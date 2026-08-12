import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Transform, Writable } from 'node:stream'
import { backupLabel, validatePassphrase } from './config.js'
import { decryptFile, encryptToFile, hashFile, newEncryptionMaterial } from './crypto.js'
import { canonicalJson } from './manifest.js'
import type {
  CreatePhysicalPackageOptions,
  PhysicalManifest,
  PhysicalManifestCore,
  PhysicalPackageResult,
} from './types.js'

const PACKAGE_VERSION = '0.4.0'
const SHA256 = /^[a-f0-9]{64}$/

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid physical manifest field: ${field}`)
  return value
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`Invalid physical manifest field: ${field}`)
  return Number(value)
}

function safeFile(value: unknown, field: string): string {
  const file = text(value, field)
  if (path.basename(file) !== file || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,220}$/.test(file)) {
    throw new Error(`Physical manifest ${field} must be a safe file name`)
  }
  return file
}

function base64(value: unknown, field: string, bytes: number): string {
  const encoded = text(value, field)
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.length !== bytes || decoded.toString('base64') !== encoded) throw new Error(`Invalid physical manifest field: ${field}`)
  return encoded
}

export function physicalAuthenticatedCore(manifest: PhysicalManifest): PhysicalManifestCore {
  return {
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    createdAt: manifest.createdAt,
    kind: manifest.kind,
    cluster: manifest.cluster,
    source: manifest.source,
    tool: manifest.tool,
    encryption: {
      cipher: manifest.encryption.cipher,
      kdf: manifest.encryption.kdf,
      salt: manifest.encryption.salt,
      iv: manifest.encryption.iv,
      parameters: manifest.encryption.parameters,
    },
  }
}

export function parsePhysicalManifest(value: unknown): PhysicalManifest {
  if (!object(value) || value.format !== 'forge-resilience-physical' || value.formatVersion !== 1) {
    throw new Error('Unsupported FORGE physical format')
  }
  if (!object(value.cluster) || !object(value.source) || !object(value.tool) || !object(value.encryption) || !object(value.payload)) {
    throw new Error('Physical manifest sections are incomplete')
  }
  if (!object(value.encryption.parameters)) throw new Error('Physical manifest encryption parameters are missing')
  const parameters = {
    N: integer(value.encryption.parameters.N, 'encryption.parameters.N'),
    r: integer(value.encryption.parameters.r, 'encryption.parameters.r'),
    p: integer(value.encryption.parameters.p, 'encryption.parameters.p'),
    keyLength: integer(value.encryption.parameters.keyLength, 'encryption.parameters.keyLength'),
  }
  if (parameters.N !== 32_768 || parameters.r !== 8 || parameters.p !== 1 || parameters.keyLength !== 32) {
    throw new Error('Unsupported physical KDF parameters')
  }
  const createdAt = text(value.createdAt, 'createdAt')
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('Invalid physical creation time')
  const kind = value.kind
  if (kind !== 'wal' && kind !== 'base-backup') throw new Error('Invalid physical artifact kind')
  const sourceSha = text(value.source.sha256, 'source.sha256')
  const payloadSha = text(value.payload.sha256, 'payload.sha256')
  if (!SHA256.test(sourceSha) || !SHA256.test(payloadSha)) throw new Error('Invalid physical SHA-256 metadata')
  const systemIdentifier = text(value.cluster.systemIdentifier, 'cluster.systemIdentifier')
  if (!/^\d{10,24}$/.test(systemIdentifier)) throw new Error('Invalid PostgreSQL system identifier')

  return {
    format: 'forge-resilience-physical',
    formatVersion: 1,
    createdAt,
    kind,
    cluster: {
      systemIdentifier,
      serverVersion: text(value.cluster.serverVersion, 'cluster.serverVersion'),
      serverVersionNumber: integer(value.cluster.serverVersionNumber, 'cluster.serverVersionNumber', 140000),
      timeline: integer(value.cluster.timeline, 'cluster.timeline', 1),
    },
    source: {
      file: safeFile(value.source.file, 'source.file'),
      sha256: sourceSha,
      bytes: integer(value.source.bytes, 'source.bytes', 1),
    },
    tool: { forgeResilienceVersion: text(value.tool.forgeResilienceVersion, 'tool.forgeResilienceVersion') },
    encryption: {
      cipher: value.encryption.cipher === 'aes-256-gcm' ? value.encryption.cipher : (() => { throw new Error('Unsupported physical cipher') })(),
      kdf: value.encryption.kdf === 'scrypt' ? value.encryption.kdf : (() => { throw new Error('Unsupported physical KDF') })(),
      salt: base64(value.encryption.salt, 'encryption.salt', 16),
      iv: base64(value.encryption.iv, 'encryption.iv', 12),
      authTag: base64(value.encryption.authTag, 'encryption.authTag', 16),
      parameters,
    },
    payload: {
      file: safeFile(value.payload.file, 'payload.file'),
      sha256: payloadSha,
      bytes: integer(value.payload.bytes, 'payload.bytes', 1),
    },
  }
}

function integrityStream(expected: { sha256: string; bytes: number }): Transform {
  const hash = createHash('sha256')
  let bytes = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      bytes += chunk.length
      callback(null, chunk)
    },
    flush(callback) {
      const sha256 = hash.digest('hex')
      callback(bytes === expected.bytes && sha256 === expected.sha256 ? undefined : new Error('Physical source changed while it was packaged'))
    },
  })
}

function verificationSink(expected: { sha256: string; bytes: number }): Writable {
  const hash = createHash('sha256')
  let bytes = 0
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      bytes += chunk.length
      callback()
    },
    final(callback) {
      const sha256 = hash.digest('hex')
      callback(bytes === expected.bytes && sha256 === expected.sha256 ? undefined : new Error('Physical plaintext checksum does not match its manifest'))
    },
  })
}

export async function createPhysicalPackage(options: CreatePhysicalPackageOptions): Promise<PhysicalPackageResult> {
  const label = backupLabel(options.label)
  const sourcePath = path.resolve(options.sourcePath)
  const outputDirectory = path.resolve(options.outputDirectory)
  await mkdir(outputDirectory, { recursive: true })
  const payloadPath = path.join(outputDirectory, `${label}.forge-physical`)
  const manifestPath = `${payloadPath}.json`
  if (existsSync(payloadPath) || existsSync(manifestPath)) throw new Error(`Physical package already exists for label: ${label}`)
  const partialPayload = `${payloadPath}.${randomUUID()}.partial`
  const partialManifest = `${manifestPath}.${randomUUID()}.partial`
  const passphrase = validatePassphrase(options.passphrase)
  let payloadPublished = false
  try {
    const source = await hashFile(sourcePath)
    if (source.bytes === 0) throw new Error('Physical source must not be empty')
    const material = newEncryptionMaterial()
    const core: PhysicalManifestCore = {
      format: 'forge-resilience-physical',
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      kind: options.kind,
      cluster: options.cluster,
      source: { file: path.basename(sourcePath), ...source },
      tool: { forgeResilienceVersion: PACKAGE_VERSION },
      encryption: {
        cipher: 'aes-256-gcm',
        kdf: 'scrypt',
        salt: material.salt.toString('base64'),
        iv: material.iv.toString('base64'),
        parameters: material.parameters,
      },
    }
    const encrypted = await encryptToFile(
      createReadStream(sourcePath).pipe(integrityStream(source)), partialPayload, passphrase, material, canonicalJson(core),
    )
    const manifest = parsePhysicalManifest({
      ...core,
      encryption: { ...core.encryption, authTag: encrypted.authTag.toString('base64') },
      payload: { file: path.basename(payloadPath), sha256: encrypted.sha256, bytes: encrypted.bytes },
    })
    await rename(partialPayload, payloadPath)
    payloadPublished = true
    await writeFile(partialManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(partialManifest, manifestPath)
    return { manifestPath, payloadPath, manifest }
  } catch (error) {
    if (payloadPublished) await rm(payloadPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    passphrase.fill(0)
    await rm(partialPayload, { force: true }).catch(() => undefined)
    await rm(partialManifest, { force: true }).catch(() => undefined)
  }
}

function decode(value: string): Buffer {
  return Buffer.from(value, 'base64')
}

export async function verifyPhysicalPackage(manifestPath: string, suppliedPassphrase: Uint8Array | string): Promise<PhysicalManifest> {
  const resolvedManifest = path.resolve(manifestPath)
  const manifest = parsePhysicalManifest(JSON.parse(await readFile(resolvedManifest, 'utf8')) as unknown)
  const payloadPath = path.join(path.dirname(resolvedManifest), manifest.payload.file)
  const payload = await hashFile(payloadPath)
  if (payload.sha256 !== manifest.payload.sha256 || payload.bytes !== manifest.payload.bytes) {
    throw new Error('Physical payload checksum does not match its manifest')
  }
  const passphrase = validatePassphrase(suppliedPassphrase)
  try {
    await decryptFile(
      payloadPath,
      verificationSink(manifest.source),
      passphrase,
      decode(manifest.encryption.salt),
      decode(manifest.encryption.iv),
      decode(manifest.encryption.authTag),
      manifest.encryption.parameters,
      canonicalJson(physicalAuthenticatedCore(manifest)),
    )
    return manifest
  } finally {
    passphrase.fill(0)
  }
}
