import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { validateArtifact } from './coordinator.js'
import { captureReportTarget, reportFilename, reportIdentity, reportTargetId } from './report-publisher.js'
import type { Artifact } from './types.js'

const maxJobs = 1024
const maxEntries = 4096
const safeFilename = /^[a-f0-9]{64}\.report\.md$/

type Finding = { filename: string; class: 'orphan' | 'unconfirmed' | 'invalid_checkpoint' | 'missing' | 'changed' | 'invalid_entry' }
type JobCheckpoint = {
  project_id: string
  task_id: string
  state: string
  artifact: Artifact | null
  effect_receipt: unknown
  oversized: boolean
}

const scope = 'receiver' as const
export const incompleteReportAudit = { scope, outcome: 'incomplete', error: 'REPORT_AUDIT_INCOMPLETE' } as const

export async function auditReportReceiver(databaseUrl: string, root: string, proof: unknown) {
  try {
    if (!databaseUrl) throw new Error()
    return await compareReportReceiver(root, proof, async target => {
      const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 5000 })
      client.on('error', () => { /* Pending queries and close handle connection loss. */ })
      try {
        await client.connect()
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        const { rows } = await client.query<JobCheckpoint>(
          "SELECT project_id, task_id, state,\n" +
          " CASE WHEN octet_length(artifact::text) <= 200000 THEN artifact END AS artifact,\n" +
          " CASE WHEN octet_length(effect_receipt::text) <= 4096 THEN effect_receipt END AS effect_receipt,\n" +
          " (COALESCE(octet_length(artifact::text) > 200000, false) OR COALESCE(octet_length(effect_receipt::text) > 4096, false)) AS oversized\n" +
          " FROM forge_coordinator.jobs WHERE effect_kind = 'immutable-report-v1' AND effect_target = $1 LIMIT $2",
          [target, maxJobs + 1])
        await client.query('COMMIT')
        return rows
      } finally { await client.end() }
    })
  } catch { return incompleteReportAudit }
}

const sameStat = (a: BigIntStats, b: BigIntStats) =>
  a.mode === b.mode && a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink

async function snapshotReceiver(root: string) {
  const entries = new Map<string, BigIntStats>()
  for await (const { name } of await opendir(root)) {
    if (entries.size >= maxEntries || entries.has(name)) throw new Error()
    entries.set(name, await lstat(path.join(root, name), { bigint: true }))
  }
  return entries
}

async function readStableFile(filename: string, before: BigIntStats, limit: number) {
  const file = await open(filename, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK))
  try {
    if (!sameStat(before, await file.stat({ bigint: true }))) throw new Error()
    const actual = Buffer.alloc(limit + 1)
    let size = 0
    while (size < actual.length) {
      const { bytesRead } = await file.read(actual, size, actual.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (!sameStat(before, await file.stat({ bigint: true })) || !sameStat(before, await lstat(filename, { bigint: true }))) throw new Error()
    if (size > limit || BigInt(size) !== before.size) throw new Error()
    return actual.subarray(0, size)
  } finally { await file.close() }
}

async function matchesReport(filename: string, before: BigIntStats, bytes: Buffer) {
  return before.size === BigInt(bytes.length) && bytes.equals(await readStableFile(filename, before, bytes.length))
}

export async function readReportAuditProof(filename: string): Promise<unknown> {
  const before = await lstat(filename, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n) throw new Error()
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readStableFile(filename, before, 4096)))
}

// Both sources must be quiescent. The database and filesystem have no joint snapshot.
export async function compareReportReceiver(root: string, originalProof: unknown, loadJobs: (target: string) => Promise<JobCheckpoint[]>) {
  if (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(root)) throw new Error()
  if (!path.isAbsolute(root) || root.startsWith('//')) throw new Error()
  root = path.resolve(root)
  const proof = captureReportTarget(root)
  const target = reportTargetId(originalProof)
  if (reportTargetId(proof) !== target) throw new Error()
  const assertPinned = () => {
    if (reportTargetId(captureReportTarget(root)) !== target) throw new Error()
  }
  const jobs = await loadJobs(target)
  if (jobs.length > maxJobs || jobs.some(job => job.oversized)) throw new Error()
  assertPinned()

  const snapshot = await snapshotReceiver(proof.canonicalPath)
  assertPinned()
  const entries = new Map<string, BigIntStats>()
  const findings: Finding[] = []
  const counts = { jobs: jobs.length, entries: snapshot.size, confirmed: 0, pending: 0, invalidEntries: 0 }
  for (const [name, info] of snapshot) {
    if (name.length !== 74 || !safeFilename.test(name)) {
      counts.invalidEntries++
      continue
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) {
      counts.invalidEntries++
      findings.push({ filename: name, class: 'invalid_entry' })
    }
    entries.set(name, info)
  }
  for (const job of jobs) {
    const key = 'coordinator:v1:' + job.project_id + ':' + job.task_id + ':report'
    const filename = reportFilename(key)
    const info = entries.get(filename)
    entries.delete(filename)
    if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)) continue

    let expected: ReturnType<typeof reportIdentity> | undefined
    if (job.artifact !== null || job.effect_receipt !== null || job.state === 'completed') {
      try {
        if (job.artifact !== null) expected = reportIdentity(key, validateArtifact(job.artifact), target)
        if (job.effect_receipt !== null || job.state === 'completed') {
          const receipt = job.effect_receipt as Record<string, unknown> | null
          if (!expected || !receipt || typeof receipt !== 'object' ||
              Object.keys(receipt).length !== Object.keys(expected.receipt).length ||
              Object.entries(expected.receipt).some(([name, value]) => receipt[name] !== value)) throw new Error()
        }
      } catch {
        findings.push({ filename, class: 'invalid_checkpoint' })
        continue
      }
    }

    if (expected && job.effect_receipt !== null) {
      if (!info) findings.push({ filename, class: 'missing' })
      else if (!await matchesReport(path.join(proof.canonicalPath, filename), info, expected.bytes)) findings.push({ filename, class: 'changed' })
      else counts.confirmed++
    } else if (info) findings.push({ filename, class: 'unconfirmed' })
    else if (job.state === 'queued') counts.pending++
  }
  for (const [filename, info] of entries) {
    if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1n) findings.push({ filename, class: 'orphan' })
  }
  assertPinned()
  const finalSnapshot = await snapshotReceiver(proof.canonicalPath)
  assertPinned()
  if (finalSnapshot.size !== snapshot.size) throw new Error()
  for (const [name, before] of snapshot) {
    const after = finalSnapshot.get(name)
    if (!after || !sameStat(before, after)) throw new Error()
  }
  findings.sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0)
  return { scope, outcome: findings.length || counts.invalidEntries ? 'review_required' : 'complete', counts, findings } as const
}
