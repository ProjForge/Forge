import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { ForgePersistenceGateway } from '../../packages/persistence-gateway/dist/index.js'
import { Coordinator, PostgresJobStore, ImmutableReportPublisher, captureReportTarget, reportIdentity } from '../../packages/coordinator/dist/index.js'
import { captureCoherentPostgresArchive, sealCoherentDatabases } from '../../packages/resilience/dist/index.js'
import { safeConnection } from '../../packages/resilience/dist/config.js'
import { databaseSnapshot, filesSnapshot, runCli } from './operational-audit-fixture.mjs'

const script = fileURLToPath(import.meta.url)
const operator = 'forge_pilot'
const backupRole = 'operational_backup'
const writerRoles = ['forge_runtime', 'operational_state', 'operational_migration']
const hash = value => createHash('sha256').update(value).digest('hex')
const reportKey = job => `coordinator:v1:${job.projectId}:${job.taskId}:report`
const result = async ({ task }) => ({ title: 'Synthetic report', content: task.taskKey })

const workspaceRun = fileURLToPath(new URL('../../.run', import.meta.url))
const coreDb = 'forge_coordinator_pilot'
const stateDb = 'forge_coordinator_state'

function fixtureUrl(raw, role, database, passwordPattern, port) {
  // Validate the raw string before either URL parser can normalize it.
  const match = typeof raw === 'string' && /^postgresql:\/\/([a-z_]+):([a-f0-9-]+)@127\.0\.0\.1:([1-9][0-9]{3,4})\/([a-z_]+)$/.exec(raw)
  if (!match || match[0] !== raw || match[1] !== role || !passwordPattern.test(match[2]) ||
      Number(match[3]) < 1024 || Number(match[3]) > 65535 || (port && match[3] !== port) || match[4] !== database) {
    throw new Error('Invalid sealed fixture database URL')
  }
  return new URL(raw)
}

export function sealedTargets(adminUrl, stateAdminUrl, runtimeUrl) {
  if (Object.keys(process.env).some(name => /^PG/i.test(name))) throw new Error('Unexpected PostgreSQL environment')
  const source = fixtureUrl(adminUrl, operator, coreDb, /^[a-f0-9]{64}$/)
  const sourceState = fixtureUrl(stateAdminUrl, operator, stateDb, /^[a-f0-9]{64}$/, source.port)
  const runtime = fixtureUrl(runtimeUrl, 'forge_runtime', coreDb, /^[a-f0-9]{32}$/, source.port)
  if (source.password !== sourceState.password) throw new Error('Fixture administrator credentials differ')
  const runtimeTarget = new URL(source)
  runtimeTarget.username = 'forge_runtime'
  runtimeTarget.password = runtime.password
  return { source, sourceState, runtimeUrl: runtimeTarget.toString() }
}

export async function verifyFixtureConnection(db, url, root) {
  const { rows: [identity] } = await db.query('SELECT current_database() AS database, current_user AS role, session_user AS login, host(inet_server_addr()) AS host, inet_server_port() AS port')
  assert.deepEqual(identity, { database: url.pathname.slice(1), role: url.username,
    login: url.username, host: '127.0.0.1', port: Number(url.port) })
  if (root) {
    assert.equal(path.dirname(root).toLowerCase(), workspaceRun.toLowerCase())
    assert.match(path.basename(root), /^coordinator-pilot-[a-f0-9]{32}$/)
    assert.equal((await realpath(root)).toLowerCase(), root.toLowerCase())
    const { rows: [physical] } = await db.query("SELECT current_setting('data_directory') AS directory, current_setting('server_version_num')::int AS version")
    assert.equal(path.resolve(physical.directory).toLowerCase(), path.join(root, 'data').toLowerCase())
    assert.equal(physical.version, 180004)
  }
}

async function verifyTarget(url, root) {
  const db = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000, statement_timeout: 5_000 })
  try {
    await db.connect()
    await verifyFixtureConnection(db, url, root)
  } finally { await db.end() }
}

async function publishUntilReceipt({ adminUrl, stateAdminUrl, runtimeUrl, stateUrl, root, reports, identity }) {
  const targets = sealedTargets(adminUrl, stateAdminUrl, runtimeUrl)
  const suppliedState = fixtureUrl(stateUrl, 'operational_state', stateDb, /^[a-f0-9-]{36}$/, targets.source.port)
  const state = new URL(targets.sourceState)
  state.username = 'operational_state'
  state.password = suppliedState.password
  const external = path.dirname(reports)
  assert.match(path.basename(external), /^forge-operational-[a-f0-9]{32}$/)
  assert.equal(path.parse(external).root.toLowerCase(), 'c:\\')
  assert.equal(reports, path.join(external, 'reports'))
  assert.equal(process.env.FORGE_OPERATIONAL_GATE_ROOT, path.join(external, 'gate'))
  assert.equal((await realpath(reports)).toLowerCase(), reports.toLowerCase())
  await verifyTarget(targets.source, root)
  await verifyTarget(new URL(targets.runtimeUrl))
  await verifyTarget(state)
  runtimeUrl = targets.runtimeUrl
  stateUrl = state.toString()
  const core = ForgePersistenceGateway.connect({ connectionString: runtimeUrl })
  const store = new PostgresJobStore(stateUrl)
  // Coordinator reaches remember only after the publisher receipt commits.
  const paused = new Proxy(core, { get(target, key) {
    if (key === 'remember') return async () => {
      process.send('receipt-committed')
      await new Promise(() => {})
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  try {
    await new Coordinator(store, paused, { publisher: new ImmutableReportPublisher(reports) }).runOnce(identity, result)
  } finally {
    await Promise.all([store.close(), core.close()])
  }
}

if (process.argv[1] === script) {
  if (!process.send || process.argv[2] !== '--publisher' || process.argv.length !== 3) process.exit(1)
  try {
    await publishUntilReceipt(await new Promise(resolve => process.once('message', resolve)))
    process.exitCode = 1
  } catch {
    process.exitCode = 1
  } finally { process.disconnect() }
}

async function losePublisher(config, env, observe) {
  const child = fork(script, ['--publisher'], { env, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000)
  let receipt
  try {
    const ready = new Promise((resolve, reject) => child.once('message', message =>
      message === 'receipt-committed' ? resolve() : reject(new Error('Unexpected publisher message'))))
    child.send(config)
    await Promise.race([
      ready,
      exit.then(() => assert.fail('Publisher exited before observation')),
    ])
    receipt = await observe()
    assert.equal(child.kill('SIGKILL'), true)
    const stopped = await exit
    assert.equal(stopped.signal, 'SIGKILL')
    return { receipt, exit: stopped }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exit
  }
}

export async function sealedOrphanRestore({ admin, stateAdmin, source, sourceState, runtimeUrl, stateUrl, reports, scratch,
  proof, gate, bin, root, evidence, client, execute, env }) {
  const urls = [source, sourceState]
  const databases = urls.map(url => url.pathname.slice(1))
  const maintenanceUrl = new URL('/postgres', source).toString()
  const directory = path.join(root, 'data')
  async function verifyIdentity(db, database) {
    const { rows: [identity] } = await db.query(`SELECT current_database() AS database, current_user AS role,
      current_setting('data_directory') AS directory, host(inet_server_addr()) AS host,
      inet_server_port() AS port, current_setting('server_version_num')::int AS version,
      (SELECT oid FROM pg_database WHERE datname=current_database()) AS oid`)
    assert.equal(path.resolve(identity.directory).toLowerCase(), directory.toLowerCase())
    assert.equal(identity.host, '127.0.0.1')
    assert.equal(identity.port, Number(source.port))
    assert.equal(identity.role, operator)
    assert.equal(identity.database, database)
    assert.equal(identity.version, 180004)
    return identity.oid
  }
  const proofFile = path.join(scratch, 'pre-loss-audit-proof.json')
  const proofBytes = JSON.stringify(proof)
  await writeFile(proofFile, proofBytes, { flag: 'wx' })
  const maintenance = await client(maintenanceUrl)
  let restored = []
  let seal
  let resumeAttempts = 0
  const refuseResume = async () => { resumeAttempts++; assert.fail('Resume forbidden') }
  const jobRow = async (db, id) => (await db.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [id])).rows[0]
  const taskRow = async (db, id) => (await db.query('SELECT * FROM forge.tasks WHERE id=$1', [id])).rows[0]
  let handlerCalls = 0
  let sourceOpen = true
  try {
    await verifyIdentity(maintenance, 'postgres')
    const beforeOids = [await verifyIdentity(admin, databases[0]), await verifyIdentity(stateAdmin, databases[1])]
    await verifyTarget(new URL(runtimeUrl))
    await verifyTarget(stateUrl)
    const publisher = new ImmutableReportPublisher(reports)
    const withWriters = async work => {
      const core = ForgePersistenceGateway.connect({ connectionString: runtimeUrl })
      const store = new PostgresJobStore(stateUrl.toString())
      try { return await work(core, store) } finally { await Promise.all([core.close(), store.close()]) }
    }
    const enqueue = async (core, store, { projectId, agentId }, taskKey) => {
      const task = await core.createTask({ projectId, taskKey, title: taskKey,
        assignedAgentId: agentId, status: 'ready', idempotencyKey: taskKey })
      return store.enqueue({ projectId, agentId, taskId: task.id, taskKey }, 3, { kind: publisher.kind, targetId: publisher.targetId })
    }
    const scope = await withWriters(async (core, store) => {
      const project = await core.registerProject({ projectKey: 'orphan-restore', name: 'Synthetic restore' })
      const agent = await core.registerAgent({ agentKey: 'orphan-restore', name: 'Synthetic agent' })
      await core.assignAgent(project.id, agent.id)
      const identity = { projectId: project.id, agentId: agent.id, workerId: randomUUID() }
      const sibling = await enqueue(core, store, identity, 'pre-cut-confirmed')
      assert.equal(await new Coordinator(store, core, { publisher }).runOnce(identity, async input => {
        handlerCalls++
        return result(input)
      }), 'completed')
      return { identity, sibling }
    })
    const siblingRow = await jobRow(stateAdmin, scope.sibling.id)
    assert.equal(siblingRow.state, 'completed')
    assert.ok(siblingRow.effect_receipt)
    const atCut = await filesSnapshot(reports)
    assert.equal(atCut.length, 1)
    assert.equal((await maintenance.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=ANY($1) AND usename<>current_user', [databases])).rows[0].n, 0)
    const cut = [await databaseSnapshot(admin, 'forge'), await databaseSnapshot(stateAdmin, 'forge_coordinator')]
    const archives = []
    for (const [index, url] of urls.entries()) {
      const file = path.join(scratch, index ? 'state.dump' : 'core.dump')
      await captureCoherentPostgresArchive({ connectionString: url.toString(), postgresBin: bin, destination: file, role: backupRole })
      archives.push({ file, sha256: hash(await readFile(file)), dumpExit: 0 })
    }
    assert.deepEqual([await databaseSnapshot(admin, 'forge'), await databaseSnapshot(stateAdmin, 'forge_coordinator')], cut)
    const late = await withWriters((core, store) => enqueue(core, store, scope.identity, 'post-cut-orphan'))
    assert.ok(await taskRow(admin, late.taskId))
    const lost = await losePublisher({ adminUrl: source.toString(), stateAdminUrl: sourceState.toString(), root,
      runtimeUrl, stateUrl: stateUrl.toString(), reports, identity: scope.identity },
      { ...env, FORGE_OPERATIONAL_GATE_ROOT: gate.root }, async () => {
        const row = await jobRow(stateAdmin, late.id)
        assert.equal(row.state, 'running')
        assert.equal(row.attempts, 1)
        assert.deepEqual(row.effect_receipt, reportIdentity(reportKey(late), row.artifact, publisher.targetId).receipt)
        return row.effect_receipt
      })
    const originalFiles = await filesSnapshot(reports)
    assert.deepEqual(originalFiles.filter(([name]) => name !== lost.receipt.filename), atCut)
    assert.equal(originalFiles.length, 2)
    assert.equal(originalFiles.find(([name]) => name === lost.receipt.filename)[4], lost.receipt.sha256)
    assert.deepEqual(captureReportTarget(reports), proof)

    // A killed admitted process leaves tickets. Preserve them in the failed
    // closed source gate and use a new admission namespace for restored DBs.
    const sourceTickets = (await readdir(path.join(gate.root, 'active'))).length
    assert.ok(sourceTickets > 0)
    await assert.rejects(gate.close(25), /Operational drain timeout; gate remains closed/)
    assert.equal(JSON.parse(await readFile(path.join(gate.root, 'state.json'), 'utf8')).phase, 'closed')
    const restoreGate = await gate.constructor.initialize(path.join(path.dirname(gate.root), 'restored-gate'))
    const lease = await restoreGate.close(15_000)
    lease.resume = refuseResume
    process.env.FORGE_OPERATIONAL_GATE_ROOT = restoreGate.root
    await Promise.all([admin.end(), stateAdmin.end()])
    sourceOpen = false
    await verifyIdentity(maintenance, 'postgres')
    for (const [index, database] of databases.entries()) {
      await maintenance.query(`DROP DATABASE ${pg.escapeIdentifier(database)}`)
      await maintenance.query(`CREATE DATABASE ${pg.escapeIdentifier(database)} TEMPLATE template0`)
      // The original wrapper grants this database-level ACL. pg_restore
      // without --create restores object ACLs but skips database ACLs.
      if (index === 0) await maintenance.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(database)} TO forge_runtime`)
      const { file, sha256 } = archives[index]
      assert.equal(hash(await readFile(file)), sha256)
      const connection = safeConnection(urls[index].toString())
      const { code, signal } = await execute(path.join(bin, 'pg_restore.exe'),
        ['--exit-on-error', '--single-transaction', '--dbname', connection.connectionArgument, file], connection.environment)
      assert.deepEqual({ code, signal }, { code: 0, signal: null })
      archives[index].restoreExit = code
    }
    for (const url of urls) restored.push(await client(url.toString()))
    for (const [index, db] of restored.entries()) assert.notEqual(await verifyIdentity(db, databases[index]), beforeOids[index])
    const [restoredCore, restoredState] = restored
    assert.equal(await taskRow(restoredCore, late.taskId), undefined)
    assert.equal(await jobRow(restoredState, late.id), undefined)
    const { rowCount } = await restoredState.query('SELECT 1 FROM forge_coordinator.jobs WHERE task_id=$1 OR effect_receipt->>\'filename\'=$2', [late.taskId, lost.receipt.filename])
    assert.equal(rowCount, 0)
    assert.ok(await taskRow(restoredCore, scope.sibling.taskId))
    assert.deepEqual(await jobRow(restoredState, scope.sibling.id), siblingRow)
    assert.deepEqual(await filesSnapshot(reports), originalFiles)
    assert.deepEqual(captureReportTarget(reports), proof)
    assert.equal(await readFile(proofFile, 'utf8'), proofBytes)
    assert.deepEqual([await databaseSnapshot(restoredCore, 'forge'), await databaseSnapshot(restoredState, 'forge_coordinator')], cut)

    seal = await sealCoherentDatabases({ connectionString: source.toString(), dataDirectory: directory,
      databases, writerRoles, backupRole, maintenance: lease })
    seal.resume = refuseResume
    const snapshot = async () => ({
      core: await databaseSnapshot(restoredCore, 'forge'), state: await databaseSnapshot(restoredState, 'forge_coordinator'),
      reports: hash(JSON.stringify(await filesSnapshot(reports))),
      proof: hash(await readFile(proofFile)),
      gateAndTickets: hash(JSON.stringify([await filesSnapshot(restoreGate.root), await filesSnapshot(gate.root)])),
    })
    const before = await snapshot()
    const runs = []
    for (let index = 0; index < 2; index++) {
      await seal.assertHeld()
      const audit = await runCli({ url: sourceState.toString(), role: backupRole, proof: proofFile, reports }, env, seal)
      assert.equal(audit.code, 1)
      assert.deepEqual(audit.result, { scope: 'receiver', outcome: 'review_required',
        counts: { jobs: 1, entries: 2, confirmed: 1, pending: 0, invalidEntries: 0 },
        findings: [{ filename: lost.receipt.filename, class: 'orphan' }] })
      assert.deepEqual(audit.initial, { login_role: operator, effective_role: operator, read_only: 'on' })
      assert.deepEqual(audit.observed, { context: { login_role: operator, effective_role: backupRole, read_only: 'on' }, jobs: 1 })
      assert.deepEqual(audit.counts, { connections: 1, core: 0, closes: 1, jobsReads: 1, commits: 1, switches: 1 })
      await seal.assertHeld()
      assert.deepEqual(await snapshot(), before)
      runs.push(audit)
    }
    assert.deepEqual(runs[0], runs[1])
    assert.equal(handlerCalls, 1)
    assert.equal(resumeAttempts, 0)
    const roles = (await restoredCore.query('SELECT rolname,rolcanlogin FROM pg_roles WHERE rolname=ANY($1) ORDER BY rolname', [[...writerRoles, backupRole]])).rows
    assert.equal(roles.length, 4)
    assert.ok(roles.every(role => role.rolcanlogin === false))
    await seal.assertHeld()
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify({
      postgres: '18.4', node: process.versions.node, isolatedLoopbackIdentityVerified: true,
      archives: archives.map(({ sha256, dumpExit, restoreExit }, index) => ({ database: databases[index], sha256, dumpExit, restoreExit })),
      freshDatabasesInOwnedCluster: true, quiescentCut: true, restoredReadOnlySnapshotsMatchCut: true,
      publisherExit: lost.exit, sourceGateClosedWithRetainedTickets: sourceTickets,
      postCut: { taskId: late.taskId, jobId: late.id, filename: lost.receipt.filename, sha256: lost.receipt.sha256,
        originalIdentityAndBytesRetained: true, taskJobReceiptAbsent: true },
      confirmedSibling: { jobId: scope.sibling.id, filename: siblingRow.effect_receipt.filename, sha256: siblingRow.effect_receipt.sha256 },
      auditRuns: runs, stableReadOnlySnapshot: before, roles, resumeAttempts, auditCalls: { core: 0, agent: 0, provider: 0 },
    }, null, 2))
    console.log('PASS sealed orphan restore')
  } finally {
    await seal?.close()
    await Promise.all([...restored, maintenance, ...(sourceOpen ? [admin, stateAdmin] : [])].map(db => db.end()))
  }
}
