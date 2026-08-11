import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createBackup } from './backup.js'
import { backupLabel } from './config.js'
import { parseManifest } from './manifest.js'
import { verifyBackup } from './restore.js'
import type {
  BackupResult,
  PolicyRunOptions,
  PolicyRunResult,
  RecoveryPolicy,
  ReplicatedPackage,
  ReplicationTarget,
  RetentionPolicy,
} from './types.js'

interface LockRecord {
  readonly pid: number
  readonly hostname: string
  readonly startedAt: string
}

interface BackupRecord {
  readonly createdAt: number
  readonly manifestPath: string
  readonly payloadPath: string
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid recovery policy field: ${field}`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Invalid recovery policy field: ${field}`)
  return value.trim()
}

function absolute(value: unknown, field: string): string {
  const result = string(value, field)
  if (!path.isAbsolute(result)) throw new Error(`Recovery policy path must be absolute: ${field}`)
  return path.resolve(result)
}

function integer(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(`Invalid recovery policy field: ${field}`)
  return Number(value)
}

export function parseRecoveryPolicy(value: unknown): RecoveryPolicy {
  const root = object(value, 'root')
  if (root.version !== 1) throw new Error('Unsupported recovery policy version')
  if (!Array.isArray(root.replicas) || root.replicas.length === 0) {
    throw new Error('Recovery policy requires at least one replica target')
  }
  const outputDirectory = absolute(root.outputDirectory, 'outputDirectory')
  const normalizedOutput = process.platform === 'win32' ? outputDirectory.toLowerCase() : outputDirectory
  const names = new Set<string>()
  const paths = new Set<string>()
  const replicas: ReplicationTarget[] = root.replicas.map((entry, index) => {
    const target = object(entry, `replicas[${index}]`)
    const name = string(target.name, `replicas[${index}].name`)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) || names.has(name)) {
      throw new Error(`Invalid or duplicate recovery replica name: ${name}`)
    }
    const targetPath = absolute(target.path, `replicas[${index}].path`)
    const normalized = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath
    if (normalized === normalizedOutput) throw new Error('Recovery replica path must differ from outputDirectory')
    if (paths.has(normalized)) throw new Error(`Duplicate recovery replica path: ${targetPath}`)
    names.add(name)
    paths.add(normalized)
    return { name, path: targetPath }
  })
  const retentionValue = object(root.retention, 'retention')
  const retention: RetentionPolicy = {
    keepLast: integer(retentionValue.keepLast, 'retention.keepLast', 1),
    ...(retentionValue.maxAgeHours === undefined
      ? {}
      : { maxAgeHours: integer(retentionValue.maxAgeHours, 'retention.maxAgeHours', 1) }),
  }
  const labelPrefix = root.labelPrefix === undefined ? undefined : string(root.labelPrefix, 'labelPrefix')
  if (labelPrefix !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,40}$/.test(labelPrefix)) {
    throw new Error('Invalid recovery policy labelPrefix')
  }
  return {
    version: 1,
    outputDirectory,
    replicas,
    retention,
    ...(labelPrefix ? { labelPrefix } : {}),
    ...(root.lockPath === undefined ? {} : { lockPath: absolute(root.lockPath, 'lockPath') }),
    ...(root.statusPath === undefined ? {} : { statusPath: absolute(root.statusPath, 'statusPath') }),
  }
}

export function parseRecoveryPolicyDocument(raw: string): RecoveryPolicy {
  return parseRecoveryPolicy(JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown)
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const partial = `${file}.${randomUUID()}.partial`
  try {
    await writeFile(partial, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(partial, file)
  } finally {
    await rm(partial, { force: true }).catch(() => undefined)
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
  }
}

async function acquireLock(file: string, now: Date): Promise<() => Promise<void>> {
  await mkdir(path.dirname(file), { recursive: true })
  const record: LockRecord = { pid: process.pid, hostname: os.hostname(), startedAt: now.toISOString() }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(record)}\n`)
      await handle.close()
      return async () => rm(file, { force: true })
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
      let existing: LockRecord | undefined
      try {
        existing = JSON.parse(await readFile(file, 'utf8')) as LockRecord
      } catch {
        throw new Error(`Recovery policy lock exists and is unreadable: ${file}`)
      }
      if (existing.hostname !== os.hostname() || !Number.isSafeInteger(existing.pid) || processExists(existing.pid)) {
        throw new Error(`Recovery policy is already running with PID ${existing.pid} on ${existing.hostname}`)
      }
      await rm(file)
    }
  }
  throw new Error('Could not acquire recovery policy lock')
}

async function copyExclusive(source: string, destination: string): Promise<void> {
  await copyFile(source, destination, fsConstants.COPYFILE_EXCL)
}

export async function replicateBackup(
  backup: BackupResult,
  target: ReplicationTarget,
  passphrase: Uint8Array | string,
): Promise<ReplicatedPackage> {
  const directory = path.resolve(target.path)
  await mkdir(directory, { recursive: true })
  const payloadPath = path.join(directory, path.basename(backup.payloadPath))
  const manifestPath = path.join(directory, path.basename(backup.manifestPath))
  if (path.resolve(backup.payloadPath) === payloadPath || path.resolve(backup.manifestPath) === manifestPath) {
    throw new Error('Recovery replica target must differ from the source directory')
  }
  const partialPayload = `${payloadPath}.${randomUUID()}.partial`
  const partialManifest = `${manifestPath}.${randomUUID()}.partial`
  let payloadPublished = false
  let manifestPublished = false
  try {
    await copyExclusive(backup.payloadPath, partialPayload)
    await rename(partialPayload, payloadPath)
    payloadPublished = true
    await copyExclusive(backup.manifestPath, partialManifest)
    await rename(partialManifest, manifestPath)
    manifestPublished = true
    await verifyBackup({ manifestPath, passphrase })
    return { target: target.name, manifestPath, payloadPath }
  } catch (error) {
    if (manifestPublished) await rm(manifestPath, { force: true }).catch(() => undefined)
    if (payloadPublished) await rm(payloadPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await rm(partialPayload, { force: true }).catch(() => undefined)
    await rm(partialManifest, { force: true }).catch(() => undefined)
  }
}

async function backupRecords(directory: string): Promise<BackupRecord[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  const records: BackupRecord[] = []
  for (const name of names.filter((entry) => entry.endsWith('.forge-backup.json'))) {
    const manifestPath = path.join(directory, name)
    try {
      const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown)
      const payloadPath = path.join(directory, manifest.payload.file)
      if (!(await stat(payloadPath)).isFile()) continue
      records.push({ createdAt: Date.parse(manifest.createdAt), manifestPath, payloadPath })
    } catch {
      // Unknown or malformed files are never retention candidates.
    }
  }
  return records.sort((left, right) => right.createdAt - left.createdAt)
}

export async function pruneBackups(
  directory: string,
  retention: RetentionPolicy,
  now = new Date(),
): Promise<string[]> {
  const records = await backupRecords(path.resolve(directory))
  const protectedPaths = new Set(records.slice(0, retention.keepLast).map((record) => record.manifestPath))
  const cutoff = retention.maxAgeHours === undefined
    ? Number.POSITIVE_INFINITY
    : now.getTime() - retention.maxAgeHours * 60 * 60 * 1000
  const removed: string[] = []
  for (const record of records) {
    if (protectedPaths.has(record.manifestPath) || record.createdAt >= cutoff) continue
    await rm(record.manifestPath)
    await rm(record.payloadPath)
    removed.push(record.manifestPath, record.payloadPath)
  }
  return removed
}

export async function runBackupPolicy(options: PolicyRunOptions): Promise<PolicyRunResult> {
  const policy = parseRecoveryPolicy(options.policy)
  const now = options.now ?? new Date()
  const startedAt = now.toISOString()
  const lockPath = policy.lockPath ?? path.join(policy.outputDirectory, '.forge-resilience.lock')
  const statusPath = policy.statusPath ?? path.join(policy.outputDirectory, 'forge-resilience-status.json')
  const release = await acquireLock(lockPath, now)
  try {
    await atomicJson(statusPath, { status: 'running', startedAt })
    const label = backupLabel(`${policy.labelPrefix ?? 'forge-policy'}-${startedAt.replace(/[:.]/g, '-')}`, now)
    const backup = await createBackup({
      connectionString: options.connectionString,
      outputDirectory: policy.outputDirectory,
      passphrase: options.passphrase,
      label,
      ...(options.postgresBin ? { postgresBin: options.postgresBin } : {}),
    })
    await verifyBackup({ manifestPath: backup.manifestPath, passphrase: options.passphrase })
    const replicas = await Promise.all(policy.replicas.map((target) => replicateBackup(backup, target, options.passphrase)))
    const prunedFiles: string[] = []
    for (const directory of [policy.outputDirectory, ...policy.replicas.map((target) => target.path)]) {
      prunedFiles.push(...await pruneBackups(directory, policy.retention, now))
    }
    const result: PolicyRunResult = {
      startedAt,
      completedAt: new Date().toISOString(),
      backup,
      replicas,
      prunedFiles,
    }
    await atomicJson(statusPath, {
      status: 'ok',
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      manifestPath: backup.manifestPath,
      replicas: replicas.map((replica) => ({ target: replica.target, manifestPath: replica.manifestPath })),
      prunedFiles,
    })
    return result
  } catch (error) {
    await atomicJson(statusPath, {
      status: 'error',
      startedAt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown recovery policy failure',
    }).catch(() => undefined)
    throw error
  } finally {
    await release().catch(() => undefined)
  }
}
