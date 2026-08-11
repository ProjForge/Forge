import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { backupLabel, resolvePostgresTool, safeConnection, validatePassphrase } from './config.js'
import { encryptToFile, newEncryptionMaterial } from './crypto.js'
import { canonicalJson } from './manifest.js'
import { sourceMetadata, connectDatabase } from './postgres.js'
import { commandVersion, spawnPostgres } from './process.js'
import type { BackupManifest, BackupManifestCore, BackupOptions, BackupResult } from './types.js'

const PACKAGE_VERSION = '0.3.0'

export async function createBackup(options: BackupOptions): Promise<BackupResult> {
  const label = backupLabel(options.label)
  const outputDirectory = path.resolve(options.outputDirectory)
  await mkdir(outputDirectory, { recursive: true })
  const payloadPath = path.join(outputDirectory, `${label}.forge-backup`)
  const manifestPath = path.join(outputDirectory, `${label}.forge-backup.json`)
  if (existsSync(payloadPath) || existsSync(manifestPath)) throw new Error(`Backup already exists for label: ${label}`)

  const partialPayload = `${payloadPath}.${randomUUID()}.partial`
  const partialManifest = `${manifestPath}.${randomUUID()}.partial`
  const passphrase = validatePassphrase(options.passphrase)
  const pgDump = resolvePostgresTool('pg_dump', options.postgresBin)
  const connection = safeConnection(options.connectionString)
  const pgDumpVersion = await commandVersion(pgDump, connection.environment)
  const client = await connectDatabase(options.connectionString)
  let payloadPublished = false

  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const snapshotResult = await client.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot')
    const snapshot = snapshotResult.rows[0]?.snapshot
    if (!snapshot) throw new Error('PostgreSQL did not export a backup snapshot')
    const source = await sourceMetadata(client)
    const material = newEncryptionMaterial()
    const core: BackupManifestCore = {
      format: 'forge-resilience-backup',
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      source,
      tool: { pgDumpVersion, forgeResilienceVersion: PACKAGE_VERSION },
      encryption: {
        cipher: 'aes-256-gcm',
        kdf: 'scrypt',
        salt: material.salt.toString('base64'),
        iv: material.iv.toString('base64'),
        parameters: material.parameters,
      },
    }
    const selection = [
      '--schema=forge',
      ...Object.keys(source.extensions).map((extension) => `--extension=${extension}`),
      '--strict-names',
    ]
    const postgres = spawnPostgres(pgDump, [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      ...selection,
      `--snapshot=${snapshot}`,
      `--dbname=${connection.connectionArgument}`,
    ], connection.environment)

    const encryption = encryptToFile(
      postgres.child.stdout,
      partialPayload,
      passphrase,
      material,
      canonicalJson(core),
    ).catch((error: unknown) => {
      postgres.child.kill()
      throw error
    })
    const results = await Promise.allSettled([encryption, postgres.completion])
    const encryptionResult = results[0]
    const processResult = results[1]
    if (processResult.status === 'rejected') throw processResult.reason
    if (encryptionResult.status === 'rejected') throw encryptionResult.reason
    const encrypted = encryptionResult.value
    await client.query('COMMIT')

    const manifest: BackupManifest = {
      ...core,
      encryption: { ...core.encryption, authTag: encrypted.authTag.toString('base64') },
      payload: { file: path.basename(payloadPath), sha256: encrypted.sha256, bytes: encrypted.bytes },
    }
    await rename(partialPayload, payloadPath)
    payloadPublished = true
    await writeFile(partialManifest, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(partialManifest, manifestPath)
    return { manifestPath, payloadPath, manifest }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (payloadPublished) await rm(payloadPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    passphrase.fill(0)
    await client.end().catch(() => undefined)
    await rm(partialPayload, { force: true }).catch(() => undefined)
    await rm(partialManifest, { force: true }).catch(() => undefined)
  }
}
