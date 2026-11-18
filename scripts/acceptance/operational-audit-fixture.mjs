// Fixture-only observer. The CLI executes unchanged in a child with no Core or provider configuration.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const script = fileURLToPath(import.meta.url)
const cli = fileURLToPath(new URL('../../packages/coordinator/dist/cli.js', import.meta.url))
const backup = 'operational_backup'
const operator = 'forge_pilot'
const hash = value => createHash('sha256').update(value).digest('hex')
const quote = pg.escapeIdentifier

async function observeCli() {
  const config = await new Promise(resolve => process.once('message', resolve))
  const { connect, query, end } = pg.Client.prototype
  const counts = { connections: 0, core: 0, closes: 0, jobsReads: 0, commits: 0, switches: 0 }
  let context
  let sqlState
  pg.Client.prototype.connect = function (...args) {
    counts.connections++
    if (this.database !== 'forge_coordinator_state') {
      counts.core++
      throw new Error('Fixture auditor database mismatch')
    }
    return connect.apply(this, args).catch(error => {
      if (error.code === '28P01') sqlState = error.code
      throw error
    })
  }
  pg.Client.prototype.end = function (...args) {
    counts.closes++
    return end.apply(this, args)
  }
  pg.Client.prototype.query = async function (sql, ...args) {
    assert.equal(typeof sql, 'string')
    assert.equal(counts.commits, 0)
    if (sql.startsWith('SET LOCAL ROLE ')) counts.switches++
    const result = await query.call(this, sql, ...args)
    if (sql.startsWith('SELECT current_user AS effective_role')) {
      if (!context) await attest({ initial: result.rows[0] })
      context = { client: this, row: result.rows[0] }
    }
    if (sql.includes('FROM forge_coordinator.jobs WHERE effect_kind')) {
      counts.jobsReads++
      assert.equal(context?.client === this, true)
      await attest({ observed: { context: context.row, jobs: result.rowCount } })
    }
    if (sql === 'COMMIT') counts.commits++
    return result
  }
  async function attest(message) {
    const ack = new Promise((resolve, reject) => {
      process.once('message', reply => reply === 'seal-held' ? resolve() : reject(new Error('Seal check failed')))
    })
    process.send(message)
    await ack
  }
  process.env.FORGE_COORDINATOR_DATABASE_URL = config.url
  process.env.FORGE_COORDINATOR_REPORT_ROOT = config.reports
  process.env.FORGE_COORDINATOR_AUDIT_ROLE = config.role
  process.argv = [process.execPath, cli, 'audit-reports', config.proof]
  await import(new URL('../../packages/coordinator/dist/cli.js', import.meta.url))
  await new Promise((resolve, reject) => process.send({ counts, sqlState }, error => error ? reject(error) : resolve()))
  process.disconnect()
}

if (process.send && process.argv[1] === script) {
  try { await observeCli() } catch { console.error('AUDIT_FIXTURE_OBSERVER_FAILED'); process.exit(1) }
}

async function runCli(config, env, seal) {
  const child = fork(script, [], { env, execArgv: [], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stdout = ''
  let stderr = ''
  let counts
  let observed
  let initial
  let sqlState
  let during
  child.stdout.on('data', bytes => { stdout += bytes })
  child.stderr.on('data', bytes => { stderr += bytes })
  child.on('message', message => {
    if (message.counts) { counts = message.counts; sqlState = message.sqlState }
    else {
      during = seal.assertHeld().then(() => { initial ??= message.initial; observed ??= message.observed; child.send('seal-held') }, () => child.send('seal-lost'))
    }
  })
  const timer = setTimeout(() => child.kill(), 20_000)
  try {
    const finished = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    child.send(config)
    const { code, signal } = await finished
    await during
    assert.equal(signal, null)
    assert.equal(stderr.length, 0)
    assert.ok(counts)
    return { code, result: JSON.parse(stdout), counts, observed, initial, sqlState }
  } finally { clearTimeout(timer) }
}

export async function provisionSharedOwner(admin, stateAdmin) {
  const role = 'operational_shared_owner_fixture'
  const database = 'forge_audit_sacrificial_fixture'
  await admin.query(`CREATE ROLE ${quote(role)} NOLOGIN`)
  await admin.query(`CREATE DATABASE ${quote(database)} OWNER ${quote(role)} TEMPLATE template0`)
  await stateAdmin.query(`GRANT USAGE ON SCHEMA forge_coordinator TO ${quote(role)}`)
  await stateAdmin.query(`GRANT SELECT ON forge_coordinator.jobs TO ${quote(role)}`)
  const { rows } = await stateAdmin.query(`
    SELECT r.rolcanlogin OR r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR
           r.rolreplication OR r.rolbypassrls AS privileged,
           EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid) AS membership,
           s.dbid::int AS dbid, d.datname AS database,
           pg_catalog.has_schema_privilege(r.oid, 'forge_coordinator', 'USAGE') AS schema_usage,
           pg_catalog.has_table_privilege(r.oid, 'forge_coordinator.jobs', 'SELECT') AS jobs_select
    FROM pg_catalog.pg_roles r
    JOIN pg_catalog.pg_shdepend s ON s.refobjid = r.oid
      AND s.refclassid = 'pg_catalog.pg_authid'::regclass AND s.deptype = 'o'
    LEFT JOIN pg_catalog.pg_database d ON s.classid = 'pg_catalog.pg_database'::regclass AND d.oid = s.objid
    WHERE r.rolname = $1`, [role])
  assert.deepEqual(rows, [{ privileged: false, membership: false, dbid: 0, database, schema_usage: true, jobs_select: true }])
  return { role, ownership: rows[0] }
}

async function databaseSnapshot(db, schema) {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    const { rows: [context] } = await db.query(`
      SELECT current_database() AS database, session_user AS login_role, current_user AS effective_role,
        current_setting('transaction_read_only') AS read_only,
        current_setting('transaction_isolation') AS isolation`)
    assert.deepEqual(context, {
      database: db.database, login_role: operator, effective_role: operator,
      read_only: 'on', isolation: 'repeatable read',
    })
    const sha256 = await snapshotContents(db, schema)
    await db.query('COMMIT')
    return { context, sha256 }
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  }
}

async function snapshotContents(db, schema) {
  const read = async (sql, params) => (await db.query(sql, params)).rows
  const tables = await read(`
    SELECT c.relname, c.relowner, c.relacl, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 ORDER BY c.relname`, [schema])
  const contents = await read(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema=$1 AND table_type='BASE TABLE' ORDER BY table_name`, [schema])
  for (const table of contents) {
    table.rows = await read(`SELECT to_jsonb(t) AS row FROM ${quote(schema)}.${quote(table.table_name)} t ORDER BY to_jsonb(t)::text`)
  }
  return hash(JSON.stringify({
    tables, contents,
    schemas: await read('SELECT nspname,nspowner,nspacl FROM pg_catalog.pg_namespace ORDER BY nspname'),
    databases: await read('SELECT datname,datdba,datacl FROM pg_catalog.pg_database ORDER BY datname'),
    columns: await read('SELECT attrelid,attnum,attacl FROM pg_catalog.pg_attribute WHERE attacl IS NOT NULL ORDER BY attrelid,attnum'),
    roles: await read('SELECT rolname,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolinherit FROM pg_catalog.pg_roles ORDER BY rolname'),
    memberships: await read('SELECT * FROM pg_catalog.pg_auth_members ORDER BY roleid, member, grantor'),
  }))
}

async function filesSnapshot(root) {
  const entries = []
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name)
    const info = await lstat(file, { bigint: true })
    assert.ok(entry.isDirectory() || entry.isFile())
    entries.push([entry.name, String(info.ino), String(info.mtimeNs), String(info.size),
      entry.isDirectory() ? await filesSnapshot(file) : hash(await readFile(file))])
  }
  return entries
}

export async function auditUnderSeal({ admin, stateAdmin, stateAdminUrl, reports, scratch, proof, sharedOwner, env, gate, seal, counters }) {
  const proofFile = path.join(scratch, 'pre-loss-audit-proof.json')
  await writeFile(proofFile, JSON.stringify(proof), { flag: 'wx' })
  const wrongProof = path.join(scratch, 'wrong-audit-proof.json')
  await writeFile(wrongProof, JSON.stringify({ ...proof, ino: proof.ino === '0' ? '1' : '0' }), { flag: 'wx' })
  const snapshot = async () => ({
    core: await databaseSnapshot(admin, 'forge'),
    coordinator: await databaseSnapshot(stateAdmin, 'forge_coordinator'),
    reportFiles: hash(JSON.stringify(await filesSnapshot(reports))),
    gateAndTickets: hash(JSON.stringify(await filesSnapshot(gate.root))),
    calls: counters(),
  })
  const original = await snapshot()
  const cases = {}
  const run = async (name, outcome, { url = stateAdminUrl, role = backup, proof = proofFile, connections = 1, initialRole = operator, sqlState } = {}) => {
    await seal.assertHeld()
    const before = await snapshot()
    const actual = await runCli({ url, role, proof, reports }, env, seal)
    await seal.assertHeld()
    const after = await snapshot()
    assert.deepEqual(after, before)
    assert.equal(actual.code, outcome === 'complete' ? 0 : 1, JSON.stringify({ name, outcome: actual.result.outcome, counts: actual.counts, sqlState: actual.sqlState }))
    assert.equal(actual.result.outcome, outcome)
    const successfulRead = outcome !== 'incomplete'
    const reads = Number(successfulRead)
    assert.deepEqual(actual.counts, { connections, core: 0, closes: connections, jobsReads: reads, commits: reads, switches: reads })
    if (successfulRead) {
      assert.deepEqual(actual.observed, { context: { login_role: operator, effective_role: backup, read_only: 'on' }, jobs: 3 })
      assert.equal(actual.result.counts.confirmed, 3)
    } else {
      assert.equal(actual.observed, undefined)
      assert.deepEqual(actual.result, { scope: 'receiver', outcome: 'incomplete', error: 'REPORT_AUDIT_INCOMPLETE' })
    }
    assert.equal(actual.sqlState, sqlState)
    assert.deepEqual(actual.initial, connections && !sqlState ?
      { login_role: operator, effective_role: initialRole, read_only: 'on' } : undefined)
    cases[name] = { ...actual, sealBeforeAfter: true, sealDuringConnection: Boolean(actual.initial), sealDuringRead: successfulRead, before, after }
  }
  await run('complete', 'complete')
  const extra = path.join(reports, 'audit-fixture-inert.txt')
  await writeFile(extra, 'Disposable audit negative', { flag: 'wx' })
  try {
    await run('inertEntry', 'review_required')
    assert.equal(cases.inertEntry.result.counts.invalidEntries, 1)
  } finally { await rm(extra) }
  await run('repeatComplete', 'complete')
  assert.deepEqual(cases.repeatComplete.result, cases.complete.result)
  await run('wrongProof', 'incomplete', { proof: wrongProof, connections: 0 })
  await run('emptyRole', 'incomplete', { role: '', connections: 0 })
  await run('unknownRole', 'incomplete', { role: 'operational_absent_fixture' })
  await run('loginOperator', 'incomplete', { role: operator })
  await run('stateOwner', 'incomplete', { role: 'operational_state' })
  await run('membership', 'incomplete', { role: 'pg_read_all_stats' })
  await run('migrationWriter', 'incomplete', { role: 'operational_migration' })
  if (sharedOwner) await run('sharedOwner', 'incomplete', { role: sharedOwner.role })
  const startup = new URL(stateAdminUrl)
  startup.searchParams.set('options', '-c role=operational_backup')
  await run('startupRoleOverride', 'incomplete', { url: startup.toString(), initialRole: backup })
  const denied = new URL(stateAdminUrl)
  denied.password = 'incorrect-audit-fixture-password'
  await run('authenticationError', 'incomplete', { url: denied.toString(), sqlState: '28P01' })
  await seal.assertHeld()
  assert.deepEqual(await snapshot(), original)
  const reportsEvidence = (await filesSnapshot(reports)).map(([filename, inode, mtimeNs, bytes, sha256]) => ({ filename, inode, mtimeNs, bytes, sha256 }))
  assert.equal(reportsEvidence.length, 3)
  return { cases, sharedOwner, reports: reportsEvidence, fixtureCallDelta: { core: 0, agent: 0, provider: 0 },
    originalRestoredAfterInertEntry: true, negativeSqlStates: { writerLogin: '28000', backupLogin: '28P01', backupWrites: '42501' } }
}
