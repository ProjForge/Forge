import path from 'node:path'
import type { BackupManifest, BackupManifestCore } from './types.js'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isObject(value)) return value

  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  )
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export function authenticatedCore(manifest: BackupManifest): BackupManifestCore {
  return {
    format: manifest.format,
    formatVersion: manifest.formatVersion,
    createdAt: manifest.createdAt,
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid backup manifest field: ${field}`)
  return value
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid backup manifest field: ${field}`)
  return Number(value)
}

export function parseManifest(value: unknown): BackupManifest {
  if (!isObject(value)) throw new Error('Backup manifest must be an object')
  if (value.format !== 'forge-resilience-backup' || value.formatVersion !== 1) {
    throw new Error('Unsupported FORGE backup format')
  }
  if (!isObject(value.source) || !isObject(value.tool) || !isObject(value.encryption) || !isObject(value.payload)) {
    throw new Error('Backup manifest sections are incomplete')
  }
  if (!isObject(value.encryption.parameters)) throw new Error('Backup encryption parameters are missing')
  if (!Array.isArray(value.source.migrations) || !isObject(value.source.tableCounts) || !isObject(value.source.extensions)) {
    throw new Error('Backup source metadata is incomplete')
  }

  const payloadFile = requiredString(value.payload.file, 'payload.file')
  if (path.basename(payloadFile) !== payloadFile) throw new Error('Backup payload path must be a file name')

  const migrations = value.source.migrations.map((migration, index) => {
    if (!isObject(migration)) throw new Error(`Invalid migration record at index ${index}`)
    const name = requiredString(migration.name, `source.migrations[${index}].name`)
    const checksum = requiredString(migration.checksum, `source.migrations[${index}].checksum`)
    if (!/^\d{4}_.+\.sql$/.test(name) || !/^[a-f0-9]{64}$/.test(checksum)) {
      throw new Error(`Invalid migration record at index ${index}`)
    }
    return { name, checksum }
  })

  const tableCounts = Object.fromEntries(Object.entries(value.source.tableCounts).map(([name, count]) => {
    if (!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(name) || typeof count !== 'string' || !/^\d+$/.test(count)) {
      throw new Error(`Invalid table count: ${name}`)
    }
    return [name, count]
  }))
  const extensions = Object.fromEntries(Object.entries(value.source.extensions).map(([name, version]) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || typeof version !== 'string' || version.length === 0) {
      throw new Error(`Invalid extension metadata: ${name}`)
    }
    return [name, version]
  }))

  const parameters = {
    N: requiredInteger(value.encryption.parameters.N, 'encryption.parameters.N'),
    r: requiredInteger(value.encryption.parameters.r, 'encryption.parameters.r'),
    p: requiredInteger(value.encryption.parameters.p, 'encryption.parameters.p'),
    keyLength: requiredInteger(value.encryption.parameters.keyLength, 'encryption.parameters.keyLength'),
  }
  if (parameters.N !== 32_768 || parameters.r !== 8 || parameters.p !== 1 || parameters.keyLength !== 32) {
    throw new Error('Unsupported backup KDF parameters')
  }
  const createdAt = requiredString(value.createdAt, 'createdAt')
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('Invalid backup creation time')
  const payloadSha = requiredString(value.payload.sha256, 'payload.sha256')
  const payloadBytes = requiredInteger(value.payload.bytes, 'payload.bytes')
  if (!/^[a-f0-9]{64}$/.test(payloadSha) || payloadBytes === 0) throw new Error('Invalid backup payload metadata')

  return {
    format: 'forge-resilience-backup',
    formatVersion: 1,
    createdAt,
    source: {
      databaseName: requiredString(value.source.databaseName, 'source.databaseName'),
      serverVersion: requiredString(value.source.serverVersion, 'source.serverVersion'),
      serverVersionNumber: requiredInteger(value.source.serverVersionNumber, 'source.serverVersionNumber'),
      schemaVersion: requiredString(value.source.schemaVersion, 'source.schemaVersion'),
      vectorVersion: value.source.vectorVersion === null ? null : requiredString(value.source.vectorVersion, 'source.vectorVersion'),
      extensions,
      migrations,
      tableCounts,
    },
    tool: {
      pgDumpVersion: requiredString(value.tool.pgDumpVersion, 'tool.pgDumpVersion'),
      forgeResilienceVersion: requiredString(value.tool.forgeResilienceVersion, 'tool.forgeResilienceVersion'),
    },
    encryption: {
      cipher: value.encryption.cipher === 'aes-256-gcm' ? value.encryption.cipher : (() => { throw new Error('Unsupported backup cipher') })(),
      kdf: value.encryption.kdf === 'scrypt' ? value.encryption.kdf : (() => { throw new Error('Unsupported backup KDF') })(),
      salt: requiredString(value.encryption.salt, 'encryption.salt'),
      iv: requiredString(value.encryption.iv, 'encryption.iv'),
      authTag: requiredString(value.encryption.authTag, 'encryption.authTag'),
      parameters,
    },
    payload: {
      file: payloadFile,
      sha256: payloadSha,
      bytes: payloadBytes,
    },
  }
}
