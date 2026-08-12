#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { createBackup } from './backup.js'
import { requireDatabaseUrl } from './config.js'
import { restoreBackup, verifyBackup } from './restore.js'
import { parseRecoveryPolicyDocument, runBackupPolicy } from './policy.js'
import { fetchBackupFromS3 } from './s3.js'
import { createPhysicalPackage, parsePhysicalManifest, verifyPhysicalPackage } from './physical.js'
import { fetchPhysicalPackageFromS3, replicatePhysicalPackageToS3 } from './physical-s3.js'
import path from 'node:path'

function usage(): never {
  throw new Error(
    'Usage: forge-resilience <backup|verify|restore|run-policy|fetch-s3|physical-pack|physical-verify|physical-upload-s3|physical-fetch-s3> [options]',
  )
}

function argumentsByName(values: readonly string[]): { command: string; options: Map<string, string> } {
  const command = values[0]
  if (!command) usage()
  const options = new Map<string, string>()
  for (let index = 1; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) usage()
    options.set(key.slice(2), value)
  }
  return { command, options }
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name)
  if (!value) throw new Error(`--${name} is required`)
  return value
}

function requiredInteger(options: Map<string, string>, name: string, minimum: number): number {
  const raw = required(options, name)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || String(value) !== raw) throw new Error(`--${name} must be an integer of at least ${minimum}`)
  return value
}

async function s3Target(options: Map<string, string>) {
  const policy = parseRecoveryPolicyDocument(await readFile(required(options, 'config'), 'utf8'))
  const targetName = required(options, 'target')
  const target = policy.replicas.find((candidate) => candidate.name === targetName)
  if (target?.type !== 's3') throw new Error(`S3 recovery target was not found: ${targetName}`)
  return target
}

async function passphrase(options: Map<string, string>): Promise<Buffer> {
  const file = options.get('passphrase-file') ?? process.env.FORGE_BACKUP_PASSPHRASE_FILE
  if (file) {
    const bytes = await readFile(file)
    if (bytes.subarray(-2).equals(Buffer.from('\r\n'))) return bytes.subarray(0, -2)
    if (bytes.subarray(-1).equals(Buffer.from('\n'))) return bytes.subarray(0, -1)
    return bytes
  }
  const value = process.env.FORGE_BACKUP_PASSPHRASE
  if (!value) throw new Error('Set --passphrase-file, FORGE_BACKUP_PASSPHRASE_FILE or FORGE_BACKUP_PASSPHRASE')
  return Buffer.from(value, 'utf8')
}

async function main(): Promise<void> {
  const parsed = argumentsByName(process.argv.slice(2))
  const secret = await passphrase(parsed.options)
  try {
    if (parsed.command === 'backup') {
      const label = parsed.options.get('label')
      const postgresBin = parsed.options.get('postgres-bin')
      const result = await createBackup({
        connectionString: requireDatabaseUrl(process.env.FORGE_DATABASE_URL, 'FORGE_DATABASE_URL'),
        outputDirectory: required(parsed.options, 'output'),
        passphrase: secret,
        ...(label ? { label } : {}),
        ...(postgresBin ? { postgresBin } : {}),
      })
      process.stdout.write(`${JSON.stringify({ manifestPath: result.manifestPath, payloadPath: result.payloadPath, manifest: result.manifest })}\n`)
      return
    }
    if (parsed.command === 'verify') {
      const manifest = await verifyBackup({ manifestPath: required(parsed.options, 'manifest'), passphrase: secret })
      process.stdout.write(`${JSON.stringify({ verified: true, manifest })}\n`)
      return
    }
    if (parsed.command === 'restore') {
      const postgresBin = parsed.options.get('postgres-bin')
      const result = await restoreBackup({
        connectionString: requireDatabaseUrl(process.env.FORGE_RESTORE_DATABASE_URL, 'FORGE_RESTORE_DATABASE_URL'),
        manifestPath: required(parsed.options, 'manifest'),
        passphrase: secret,
        ...(postgresBin ? { postgresBin } : {}),
      })
      process.stdout.write(`${JSON.stringify({ restored: true, ...result })}\n`)
      return
    }
    if (parsed.command === 'run-policy') {
      const postgresBin = parsed.options.get('postgres-bin')
      const policy = parseRecoveryPolicyDocument(await readFile(required(parsed.options, 'config'), 'utf8'))
      const result = await runBackupPolicy({
        connectionString: requireDatabaseUrl(process.env.FORGE_DATABASE_URL, 'FORGE_DATABASE_URL'),
        passphrase: secret,
        policy,
        ...(postgresBin ? { postgresBin } : {}),
      })
      process.stdout.write(`${JSON.stringify({ completed: true, ...result })}\n`)
      return
    }
    if (parsed.command === 'fetch-s3') {
      const target = await s3Target(parsed.options)
      const result = await fetchBackupFromS3(
        target,
        required(parsed.options, 'object-manifest'),
        required(parsed.options, 'output'),
        secret,
      )
      process.stdout.write(`${JSON.stringify({ fetched: true, ...result })}\n`)
      return
    }
    if (parsed.command === 'physical-pack') {
      const kind = required(parsed.options, 'kind')
      if (kind !== 'wal' && kind !== 'base-backup') throw new Error('--kind must be wal or base-backup')
      const label = parsed.options.get('label')
      const result = await createPhysicalPackage({
        sourcePath: required(parsed.options, 'source'),
        outputDirectory: required(parsed.options, 'output'),
        passphrase: secret,
        kind,
        cluster: {
          systemIdentifier: required(parsed.options, 'system-identifier'),
          serverVersion: required(parsed.options, 'server-version'),
          serverVersionNumber: requiredInteger(parsed.options, 'server-version-number', 140000),
          timeline: requiredInteger(parsed.options, 'timeline', 1),
        },
        ...(label ? { label } : {}),
      })
      process.stdout.write(`${JSON.stringify({ packaged: true, ...result })}\n`)
      return
    }
    if (parsed.command === 'physical-verify') {
      const manifest = await verifyPhysicalPackage(required(parsed.options, 'manifest'), secret)
      process.stdout.write(`${JSON.stringify({ verified: true, manifest })}\n`)
      return
    }
    if (parsed.command === 'physical-upload-s3') {
      const target = await s3Target(parsed.options)
      const manifestPath = path.resolve(required(parsed.options, 'manifest'))
      const manifest = parsePhysicalManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown)
      const result = await replicatePhysicalPackageToS3({
        manifestPath,
        payloadPath: path.join(path.dirname(manifestPath), manifest.payload.file),
        manifest,
      }, target, secret)
      process.stdout.write(`${JSON.stringify({ uploaded: true, ...result })}\n`)
      return
    }
    if (parsed.command === 'physical-fetch-s3') {
      const target = await s3Target(parsed.options)
      const result = await fetchPhysicalPackageFromS3(
        target, required(parsed.options, 'object-manifest'), required(parsed.options, 'output'), secret,
      )
      process.stdout.write(`${JSON.stringify({ fetched: true, ...result })}\n`)
      return
    }
    usage()
  } finally {
    secret.fill(0)
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`FORGE resilience failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
