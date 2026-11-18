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

type AuditOptions = { auditRole?: string }

const roleContext = `SELECT current_user AS effective_role, session_user AS login_role,
  pg_catalog.current_setting('transaction_read_only') AS read_only`

async function assertRoleContext(client: pg.Client, effectiveRole: string) {
  const { rows: [context] } = await client.query(roleContext)
  if (!context || context.login_role !== client.user ||
      context.effective_role !== effectiveRole || context.read_only !== 'on') throw new Error()
}

async function assumeAuditRole(client: pg.Client, role: string) {
  // DSN startup options can override constructor settings and change current_user.
  await client.query("SET LOCAL search_path = pg_catalog, pg_temp")
  await client.query("SET LOCAL statement_timeout = '5s'")
  await client.query("SET LOCAL lock_timeout = '5s'")
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'")
  if (!client.user) throw new Error()
  await assertRoleContext(client, client.user)
  const { rows } = await client.query(`
    SELECT 1 FROM pg_catalog.pg_roles r
    JOIN pg_catalog.pg_database d ON d.datname = pg_catalog.current_database()
    WHERE r.rolname = $1 AND NOT (
      r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR
      r.rolreplication OR r.rolbypassrls
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_shdepend s
      WHERE s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
        AND s.refobjid = r.oid AND s.deptype = 'o'
        AND (s.dbid = d.oid OR s.dbid = 0)
    )
    AND NOT pg_catalog.has_database_privilege(r.oid, d.oid, 'CREATE')
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace n WHERE pg_catalog.has_schema_privilege(r.oid, n.oid, 'CREATE')
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      -- UPDATE on pg_settings is a session setting change, not persistent DML.
      WHERE c.oid <> 'pg_catalog.pg_settings'::pg_catalog.regclass
      AND CASE
        WHEN c.relkind IN ('r','p','v','m','f') THEN
          pg_catalog.has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
          pg_catalog.has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE,REFERENCES') OR
          CASE WHEN pg_catalog.current_setting('server_version_num')::int >= 170000
            THEN pg_catalog.has_table_privilege(r.oid, c.oid, 'MAINTAIN') ELSE false END
        WHEN c.relkind = 'S' THEN pg_catalog.has_sequence_privilege(r.oid, c.oid, 'USAGE,UPDATE')
        ELSE false
      END
    )
    AND pg_catalog.has_schema_privilege(r.oid, 'forge_coordinator', 'USAGE')
    AND pg_catalog.has_table_privilege(r.oid, 'forge_coordinator.jobs', 'SELECT')
  `, [role])
  if (rows.length !== 1) throw new Error()
  await client.query('SET LOCAL ROLE ' + pg.escapeIdentifier(role))
  await assertRoleContext(client, role)
}

export async function auditReportReceiver(databaseUrl: string, root: string, proof: unknown, { auditRole }: AuditOptions = {}) {
  try {
    if (!databaseUrl || (auditRole !== undefined && (typeof auditRole !== 'string' ||
        !auditRole.trim() || auditRole.includes('\0') || Buffer.byteLength(auditRole) > 63))) throw new Error()
    return await compareReportReceiver(root, proof, async target => {
      const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5000, statement_timeout: 5000 })
      client.on('error', () => { /* Pending queries and close handle connection loss. */ })
      try {
        await client.connect()
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        if (auditRole !== undefined) await assumeAuditRole(client, auditRole)
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
