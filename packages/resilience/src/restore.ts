import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { resolvePostgresTool, safeConnection, validatePassphrase } from './config.js'
import { decryptFile, hashFile, verifyAuthentication } from './crypto.js'
import { authenticatedCore, canonicalJson, parseManifest } from './manifest.js'
import { assertEmptyTarget, assertRestoredDatabase, connectDatabase } from './postgres.js'
import { childInput, spawnPostgres } from './process.js'
import type { BackupManifest, RestoreOptions, RestoreResult, VerifyOptions } from './types.js'

function payloadPath(manifestPath: string, manifest: BackupManifest): string {
  return path.join(path.dirname(path.resolve(manifestPath)), manifest.payload.file)
}

function decode(value: string, field: string, expectedLength: number): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`Invalid base64 backup field: ${field}`)
  const result = Buffer.from(value, 'base64')
  if (result.length !== expectedLength || result.toString('base64') !== value) {
    throw new Error(`Invalid base64 backup field: ${field}`)
  }
  return result
}

function sameHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

async function loadManifest(manifestPath: string): Promise<BackupManifest> {
  const raw = await readFile(path.resolve(manifestPath), 'utf8')
  return parseManifest(JSON.parse(raw) as unknown)
}

export async function verifyBackup(options: VerifyOptions): Promise<BackupManifest> {
  const manifest = await loadManifest(options.manifestPath)
  const payload = payloadPath(options.manifestPath, manifest)
  const actual = await hashFile(payload)
  if (actual.bytes !== manifest.payload.bytes || !sameHex(actual.sha256, manifest.payload.sha256)) {
    throw new Error('Backup payload checksum or size does not match the manifest')
  }

  const passphrase = validatePassphrase(options.passphrase)
  try {
    await verifyAuthentication(
      payload,
      passphrase,
      decode(manifest.encryption.salt, 'encryption.salt', 16),
      decode(manifest.encryption.iv, 'encryption.iv', 12),
      decode(manifest.encryption.authTag, 'encryption.authTag', 16),
      manifest.encryption.parameters,
      canonicalJson(authenticatedCore(manifest)),
    )
    return manifest
  } catch (error) {
    throw new Error('Backup authentication failed', { cause: error })
  } finally {
    passphrase.fill(0)
  }
}

function postgresMajor(versionNumber: number): number {
  return Math.trunc(versionNumber / 10_000)
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const manifest = await verifyBackup(options)
  const client = await connectDatabase(options.connectionString)
  let target: Awaited<ReturnType<typeof assertEmptyTarget>>
  try {
    target = await assertEmptyTarget(client)
    if (postgresMajor(target.serverVersionNumber) < postgresMajor(manifest.source.serverVersionNumber)) {
      throw new Error(`Restore target PostgreSQL ${target.serverVersion} is older than source ${manifest.source.serverVersion}`)
    }
  } catch (error) {
    await client.end().catch(() => undefined)
    throw error
  }

  const passphrase = validatePassphrase(options.passphrase)
  const pgRestore = resolvePostgresTool('pg_restore', options.postgresBin)
  const connection = safeConnection(options.connectionString)
  const postgres = spawnPostgres(pgRestore, [
    '--exit-on-error',
    '--single-transaction',
    '--no-owner',
    '--no-privileges',
    `--dbname=${connection.connectionArgument}`,
  ], connection.environment)
  const decryption = decryptFile(
    payloadPath(options.manifestPath, manifest),
    childInput(postgres.child),
    passphrase,
    decode(manifest.encryption.salt, 'encryption.salt', 16),
    decode(manifest.encryption.iv, 'encryption.iv', 12),
    decode(manifest.encryption.authTag, 'encryption.authTag', 16),
    manifest.encryption.parameters,
    canonicalJson(authenticatedCore(manifest)),
  )

  try {
    const results = await Promise.allSettled([decryption, postgres.completion])
    const processFailure = results[1]?.status === 'rejected' ? results[1].reason : undefined
    const decryptFailure = results[0]?.status === 'rejected' ? results[0].reason : undefined
    if (processFailure) throw processFailure
    if (decryptFailure) throw decryptFailure
    const tableCounts = await assertRestoredDatabase(client, manifest.source)
    return {
      manifest,
      restoredAt: new Date().toISOString(),
      targetServerVersion: target.serverVersion,
      tableCounts,
    }
  } finally {
    passphrase.fill(0)
    await client.end().catch(() => undefined)
  }
}
