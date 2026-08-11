import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { encryptToFile, newEncryptionMaterial } from '../../src/crypto.js'
import { canonicalJson } from '../../src/manifest.js'
import type { BackupManifest, BackupManifestCore, BackupResult } from '../../src/types.js'

export async function recoveryPackage(directory: string, passphrase: Buffer): Promise<BackupResult> {
  const payloadPath = path.join(directory, 'scheduled.forge-backup')
  const manifestPath = `${payloadPath}.json`
  const material = newEncryptionMaterial()
  const core: BackupManifestCore = {
    format: 'forge-resilience-backup',
    formatVersion: 1,
    createdAt: '2026-08-11T12:00:00.000Z',
    source: {
      databaseName: 'forge', serverVersion: '18.4', serverVersionNumber: 180004,
      schemaVersion: '0.1.3', vectorVersion: null, extensions: { pgcrypto: '1.3' },
      migrations: [{ name: '0001_forge_core.sql', checksum: 'b'.repeat(64) }], tableCounts: { projects: '1' },
    },
    tool: { pgDumpVersion: 'pg_dump (PostgreSQL) 18.4', forgeResilienceVersion: '0.3.0' },
    encryption: {
      cipher: 'aes-256-gcm', kdf: 'scrypt', salt: material.salt.toString('base64'),
      iv: material.iv.toString('base64'), parameters: material.parameters,
    },
  }
  const encrypted = await encryptToFile(
    Readable.from(Buffer.from('portable postgres archive')),
    payloadPath,
    passphrase,
    material,
    canonicalJson(core),
  )
  const manifest: BackupManifest = {
    ...core,
    encryption: { ...core.encryption, authTag: encrypted.authTag.toString('base64') },
    payload: { file: path.basename(payloadPath), sha256: encrypted.sha256, bytes: encrypted.bytes },
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { payloadPath, manifestPath, manifest }
}
