import assert from 'node:assert/strict'
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { execFile, fork, spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, readdir, rename, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import pg from 'pg'
import { OperationalGate, ForgePersistenceGateway } from 'forge-persistence-gateway'
import { Coordinator, ImmutableReportPublisher, LocalReportAgent, PostgresJobStore, captureReportTarget, reportIdentity } from '../src/index.js'
import type { CorePort, Job, JobStore, WorkerIdentity } from '../src/index.js'

const adminUrl = process.env.FORGE_COORDINATOR_TEST_ADMIN_URL
const coreUrl = process.env.FORGE_DATABASE_URL
const split = process.env.FORGE_COORDINATOR_TEST_SPLIT === '1'
// Fail closed even when the main native test would otherwise be skipped.
if (split) {
  for (const key of ['FORGE_COORDINATOR_TEST_ADMIN_URL', 'FORGE_DATABASE_URL', 'FORGE_COORDINATOR_TEST_STATE_ADMIN', 'FORGE_COORDINATOR_TEST_FRESH_TARGET', 'FORGE_COORDINATOR_TEST_ROOT', 'FORGE_COORDINATOR_TEST_PROVISION', 'FORGE_COORDINATOR_TEST_PROVISION_HASH']) assert.ok(process.env[key], `Missing split fixture config: ${key}`)
  assert.equal(process.env.FORGE_COORDINATOR_TEST_RESTORE, '1')
  assert.equal(process.env.FORGE_COORDINATOR_LIVE_MODEL, undefined)
}
const normalizeFixturePath = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
async function assertFixture(client: pg.Client, url: string, directory: string): Promise<void> {
  const expected = new URL(url)
  const row = (await client.query("SELECT current_setting('data_directory') AS directory, inet_server_addr() AS host, inet_server_port() AS port, current_database() AS db, current_user AS usr")).rows[0]
  assert.equal(normalizeFixturePath(row.directory), normalizeFixturePath(directory))
  assert.equal(row.host, '127.0.0.1')
  assert.equal(String(row.port), expected.port)
  assert.equal(row.db, expected.pathname.slice(1))
  assert.equal(row.usr, expected.username)
}

async function until(condition: () => Promise<boolean>, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error('Condition deadline exceeded')
    await delay(30)
  }
}

test('coordinates trusted agents across processes, death, lease loss and uncertain Core replies', {
  skip: !adminUrl || !coreUrl, timeout: process.env.FORGE_COORDINATOR_LIVE_MODEL ? 300_000 : 120_000,
}, async (context) => {
  assert.equal(process.env.FORGE_COORDINATOR_TEST_ALLOW_SETUP, '1', 'Use only an explicitly disposable test database')
  // Reject externally supplied restore destinations before any fixture writes.
  const freshTarget = process.env.FORGE_COORDINATOR_TEST_FRESH_TARGET
  if (freshTarget) {
    const target = new URL(freshTarget)
    const source = new URL(adminUrl!)
    assert.equal(process.env.FORGE_COORDINATOR_TEST_RESTORE, '1')
    assert.equal(process.env.FORGE_COORDINATOR_LIVE_MODEL, undefined)
    assert.equal(process.platform, 'win32')
    assert.equal(target.hostname, '127.0.0.1')
    assert.equal(source.hostname, '127.0.0.1')
    assert.equal(source.pathname, '/forge_coordinator_pilot')
    assert.equal(target.pathname, '/postgres')
    assert.equal(target.username, 'forge_pilot')
    assert.notEqual(target.port, source.port)
    assert.ok(target.password, 'Fresh target requires synthetic admin credentials')
    assert.equal(target.search, '')
    const runtime = new URL(coreUrl!)
    assert.equal(runtime.host, source.host)
    assert.equal(runtime.pathname, source.pathname)
    assert.equal(runtime.username, 'forge_runtime')
    assert.equal(runtime.search, '')
  }
  const fixtureRoot = process.env.FORGE_COORDINATOR_TEST_ROOT!
  if (split) {
    assert.equal(process.platform, 'win32')
    assert.equal(normalizeFixturePath(path.dirname(fixtureRoot)), normalizeFixturePath(fileURLToPath(new URL('../../../../.run', import.meta.url))))
    assert.match(path.basename(fixtureRoot), /^coordinator-pilot-[a-f0-9]{32}$/)
    assert.equal(process.env.FORGE_COHERENT_TEST_KEY_FILE, path.join(fixtureRoot, 'coherent-fixture.key'))
    const provision = process.env.FORGE_COORDINATOR_TEST_PROVISION!
    assert.equal(provision, path.join(fixtureRoot, 'provision-target.ps1'))
    assert.equal(createHash('sha256').update(await readFile(provision)).digest('hex'), process.env.FORGE_COORDINATOR_TEST_PROVISION_HASH)
    for (const [dsn, user, db] of [[adminUrl!, 'forge_pilot', 'forge_coordinator_pilot'], [process.env.FORGE_COORDINATOR_TEST_STATE_ADMIN!, 'forge_pilot', 'forge_coordinator_state'], [coreUrl!, 'forge_runtime', 'forge_coordinator_pilot'], [freshTarget!, 'forge_pilot', 'postgres']]) {
      const url = new URL(dsn!)
      assert.equal(url.protocol, 'postgresql:')
      assert.equal(url.hostname, '127.0.0.1')
      assert.equal(url.username, user)
      assert.equal(url.pathname, `/${db}`)
      assert.equal(url.search, '')
      assert.equal(url.hash, '')
      assert.ok(Number(url.port) >= 1024)
    }
  }
  const liveModel = process.env.FORGE_COORDINATOR_LIVE_MODEL
  const liveBase = process.env.FORGE_COORDINATOR_LIVE_BASE_URL ?? 'http://127.0.0.1:1234/v1'
  if (liveModel) new LocalReportAgent({ baseUrl: liveBase, model: liveModel })
  const admin = new pg.Client({ connectionString: adminUrl! })
  await admin.connect()
  const stateAdminUrl = split ? process.env.FORGE_COORDINATOR_TEST_STATE_ADMIN! : adminUrl!
  if (split) {
    const separate = new URL(stateAdminUrl)
    assert.equal(separate.hostname, '127.0.0.1')
    assert.equal(separate.host, new URL(adminUrl!).host)
    assert.equal(separate.pathname, '/forge_coordinator_state')
    assert.notEqual(separate.pathname, new URL(adminUrl!).pathname)
    assert.ok(process.env.FORGE_COORDINATOR_TEST_PROVISION)
  }
  const stateAdmin = split ? new pg.Client({ connectionString: stateAdminUrl }) : admin
  if (split) await stateAdmin.connect()
  if (split) {
    await assertFixture(admin, adminUrl!, path.join(fixtureRoot, 'data'))
    await assertFixture(stateAdmin, stateAdminUrl, path.join(fixtureRoot, 'data'))
  }
  const exists = await stateAdmin.query("SELECT 1 FROM pg_namespace WHERE nspname='forge_coordinator'")
  assert.equal(exists.rowCount, 0, 'Refusing to replace an existing coordinator schema')
  const role = `coord_test_${randomUUID().replaceAll('-', '')}`
  const password = randomUUID()
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
  await stateAdmin.query(`CREATE SCHEMA forge_coordinator AUTHORIZATION ${role}`)
  const stateUrl = new URL(stateAdminUrl)
  stateUrl.username = role; stateUrl.password = password
  const state = new pg.Client({ connectionString: stateUrl.toString() })
  await state.connect()
  await state.query(await readFile(new URL('../../sql/setup.sql', import.meta.url), 'utf8'))
  const store = new PostgresJobStore(stateUrl.toString(), 3_000)
  const core = ForgePersistenceGateway.connect({ connectionString: coreUrl!, maxConnections: 2 })
  const workerEnv: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'Path', 'PATHEXT', 'ComSpec', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) workerEnv[key] = process.env[key]
  }
  workerEnv.FORGE_DATABASE_URL = coreUrl!
  workerEnv.FORGE_COORDINATOR_DATABASE_URL = stateUrl.toString()
  const children: ChildProcess[] = []
  const reportsRoot = await mkdtemp(path.join(tmpdir(), 'forge-agent-reports-'))
  const publisher = new ImmutableReportPublisher(reportsRoot)
  const calls = new Map<string, number>()
  const successfulCalls = new Map<string, number>()
  let realCalls = 0
  const providerFailures: Array<{ status?: number; error?: string }> = []
  const modelServer = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => { void (async () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = JSON.parse(raw) as { messages: Array<{ content: string }> }
      const task = JSON.parse(body.messages[1]!.content) as { title: string }
      calls.set(task.title, (calls.get(task.title) ?? 0) + 1)
      if (task.title === 'agent-cli' && calls.get(task.title) === 1) {
        context.diagnostic('Injected one model HTTP 503 before any CLI output checkpoint')
        response.statusCode = 503; response.end('{}'); return
      }
      let payload: unknown
      if (liveModel) {
        const base = new URL(liveBase.endsWith('/') ? liveBase : `${liveBase}/`)
        const result = await fetch(new URL('chat/completions', base), { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: raw, signal: AbortSignal.timeout(65_000) })
        if (!result.ok) { providerFailures.push({ status: result.status }); context.diagnostic(JSON.stringify({ providerFailure: { status: result.status } })); response.statusCode = result.status; response.end('{}'); return }
        payload = await result.json()
        realCalls++
      } else {
        payload = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: 'Revision de subtract', content: 'La funcion suma en vez de restar. Cambiar return a+b por return a-b.' }) } }] }
      }
      successfulCalls.set(task.title, (successfulCalls.get(task.title) ?? 0) + 1)
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(payload))
    })().catch((error: unknown) => { const failure = { error: error instanceof Error ? error.name : 'UNKNOWN' }; providerFailures.push(failure); context.diagnostic(JSON.stringify({ providerFailure: failure })); response.statusCode = 503; response.end('{}') }) })
  })
  await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve))
  const address = modelServer.address()
  assert.ok(address && typeof address !== 'string')
  workerEnv.FORGE_COORDINATOR_AGENT_BASE_URL = `http://127.0.0.1:${address.port}/v1`
  workerEnv.FORGE_COORDINATOR_AGENT_MODEL = liveModel ?? 'fixture-review-model'
  workerEnv.FORGE_COORDINATOR_REPORT_ROOT = reportsRoot
  context.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all([store.close(), core.close(), state.end()])
    if (modelServer.listening) await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()))
    await rm(reportsRoot, { recursive: true, force: true })
    await stateAdmin.query('DROP SCHEMA forge_coordinator CASCADE')
    if (split) await stateAdmin.end()
    await admin.query(`DROP ROLE ${role}`)
    await admin.end()
  })
  await core.assertReady()
  const suffix = randomUUID()
  const project = await core.registerProject({ projectKey: `coordinator-pilot-${suffix}`, name: 'Isolated coordinator pilot' })
  const agents = await Promise.all([0, 1, 2].map(async (index) => {
    const agent = await core.registerAgent({ agentKey: `coordinator-${suffix}-${index}`, name: `Pilot agent ${index}` })
    await core.assignAgent(project.id, agent.id, 'pilot')
    return agent
  }))

  async function enqueue(label: string, agentId = agents[0]!.id, maxAttempts = 3, effect = false): Promise<Job> {
    const task = await core.createTask({ projectId: project.id, taskKey: label, title: label, ...(effect ? { objective: 'Revisa function subtract(a,b){return a+b;}. Identifica el fallo y propone la correccion puntual. Dos frases breves.' } : {}), assignedAgentId: agentId, status: 'ready', idempotencyKey: label })
    return store.enqueue({ projectId: project.id, taskId: task.id, taskKey: task.taskKey, agentId }, maxAttempts, effect ? { kind: publisher.kind, targetId: publisher.targetId } : undefined)
  }
  const identity = (job: Job, workerId: string): WorkerIdentity => ({ projectId: job.projectId, agentId: job.agentId, workerId })
  async function expired(job: Job): Promise<void> {
    await until(async () => (await state.query('SELECT lease_until<=clock_timestamp() AS expired FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0].expired === true)
  }
  function spawn(agentId: string, workerId: string, mode = 'normal', reportRoot = reportsRoot) {
    const child = fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [project.id, agentId, workerId, mode], {
      env: { ...workerEnv, FORGE_COORDINATOR_REPORT_ROOT: reportRoot }, silent: true, execArgv: [],
    })
    children.push(child)
    child.stdout?.resume()
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 16_000) stderr += chunk.toString('utf8') })
    const messages: Array<{ phase: string; completed?: number }> = []
    child.on('message', (message) => messages.push(message as { phase: string; completed?: number }))
    const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code)) })
    return { child, done, messages, stderr: () => stderr, wait: async (phase: string) => {
      try { await until(async () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error('Worker exited before the required phase'); return messages.some((message) => message.phase === phase) }, liveModel ? 65_000 : 10_000) }
      catch { throw new Error(`Worker phase ${phase} missing: exit=${child.exitCode} messages=${JSON.stringify(messages)} stderr=${stderr}`) }
    } }
  }
  async function assertOne(job: Job, content?: string) {
    const executions = await core.listExecutions({ projectId: job.projectId, taskId: job.taskId })
    assert.equal(executions.items.length, 1)
    assert.equal(executions.items[0]!.status, 'succeeded')
    const memories = await core.listMemories({ projectId: job.projectId, taskId: job.taskId })
    assert.equal(memories.items.length, 1)
    if (content) {
      const row = await admin.query('SELECT content FROM forge.memories WHERE id=$1', [memories.items[0]!.id])
      assert.equal(row.rows[0].content, content)
    }
    const packages = await core.listContinuationPackages({ projectId: job.projectId, executionId: executions.items[0]!.id })
    assert.equal(packages.items.length, 1)
    const loaded = await core.loadContinuationContext(job.projectId, packages.items[0]!.id)
    assert.equal(loaded.staleSources.length, 0)
    assert.equal((await core.getTaskByKey(job.projectId, job.taskKey)).status, 'done')
    const audit = await core.getAuditTrail(job.projectId, executions.items[0]!.id)
    for (const action of ['execution.start', 'memory.remember', 'context.compile', 'execution.finish']) assert.equal(audit.filter((entry) => entry.action === action).length, 1)
    assert.equal((await state.query('SELECT state FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0].state, 'completed')
  }

  await context.test('three registered agents and six worker processes complete twelve tasks once', async () => {
    const jobs: Job[] = []
    for (const agent of agents) for (let index = 0; index < 4; index++) jobs.push(await enqueue(`batch-${agent.id}-${index}`, agent.id))
    const workers = agents.flatMap((agent) => [spawn(agent.id, `worker-${agent.id}-a`), spawn(agent.id, `worker-${agent.id}-b`)])
    assert.deepEqual(await Promise.all(workers.map((worker) => worker.done)), [0, 0, 0, 0, 0, 0])
    assert.equal(workers.flatMap((worker) => worker.messages).filter((message) => message.phase === 'done').reduce((sum, message) => sum + (message.completed ?? 0), 0), 12)
    for (const job of jobs) await assertOne(job)
  })

  for (const [mode, phase] of [['crash-after-start', 'execution-started'], ['crash-after-memory', 'memory-written'], ['crash-after-finish', 'execution-finished']] as const) {
    await context.test(`recovers after process death at ${phase} without duplicating Core history`, async () => {
      const job = await enqueue(mode)
      const worker = spawn(job.agentId, mode, mode)
      await worker.wait(phase)
      worker.child.kill('SIGKILL')
      await worker.done
      await expired(job)
      const replacement = spawn(job.agentId, `replacement-${mode}`, mode === 'crash-after-start' ? 'normal' : 'recover-saved')
      assert.equal(await replacement.done, 0)
      await assertOne(job)
    })
  }

  await context.test('a resumed stale worker cannot publish after lease takeover', async () => {
    const job = await enqueue('stale-worker')
    let release!: () => void
    let entered = false
    const paused: JobStore = {
      leaseMs: store.leaseMs, claim: store.claim.bind(store), fenced: store.fenced.bind(store), fail: store.fail.bind(store),
      heartbeat: async () => true, // Simulates a paused/partitioned worker's missing DB heartbeats.
    }
    const previous = new Coordinator(paused, core).runOnce(identity(job, 'old'), async () => {
      entered = true
      await new Promise<void>((resolve) => { release = resolve })
      return { title: 'Stale output', content: 'Must not be published' }
    })
    await until(async () => entered)
    try {
      await expired(job)
      assert.equal(await new Coordinator(store, core).runOnce(identity(job, 'new'), async () => ({ title: 'Fresh', content: 'Current owner output' })), 'completed')
    } finally { release() }
    assert.equal(await previous, 'lost')
    await assertOne(job, 'Current owner output')
  })

  await context.test('heartbeats retain a long-running task and retries are bounded/sanitized', async () => {
    const job = await enqueue('heartbeats')
    let release!: () => void
    const running = new Coordinator(store, core).runOnce(identity(job, 'healthy'), async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { title: 'Long work', content: 'Heartbeats retained ownership' }
    })
    await until(async () => typeof release === 'function')
    try {
      const deadline = (await state.query('SELECT lease_until FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0].lease_until as Date
      await until(async () => (await state.query('SELECT lease_until>$2::timestamptz+interval \'900 milliseconds\' AS renewed FROM forge_coordinator.jobs WHERE id=$1', [job.id, deadline])).rows[0].renewed === true)
      assert.equal(await new Coordinator(store, core).runOnce(identity(job, 'contender'), async () => { throw new Error('Must not run') }), 'idle')
    } finally { release() }
    assert.equal(await running, 'completed')
    await assertOne(job)
    const failing = await enqueue('bounded-failure', agents[1]!.id, 2)
    for (let attempt = 0; attempt < 2; attempt++) assert.equal(await new Coordinator(store, core).runOnce(identity(failing, 'failing'), async () => { throw new Error('password=must-not-persist') }), 'failed')
    assert.equal(await new Coordinator(store, core).runOnce(identity(failing, 'extra'), async () => { throw new Error('Must not run') }), 'idle')
    const failed = (await state.query('SELECT state,attempts,error_code FROM forge_coordinator.jobs WHERE id=$1', [failing.id])).rows[0]
    assert.deepEqual(failed, { state: 'failed', attempts: 2, error_code: 'WORKER_FAILED' })
  })

  await context.test('worker project scope and state/Core database privileges remain separate', async () => {
    const other = await core.registerProject({ projectKey: `coordinator-other-${suffix}`, name: 'Other pilot scope' })
    const job = await enqueue('scope-and-replay')
    const replays = await Promise.all([0, 1].map(() => store.enqueue({ projectId: job.projectId, taskId: job.taskId, taskKey: job.taskKey, agentId: job.agentId })))
    for (const replay of replays) assert.equal(replay.id, job.id)
    await assert.rejects(store.enqueue({ projectId: job.projectId, taskId: job.taskId, taskKey: job.taskKey, agentId: agents[1]!.id }), /identity conflict/)
    assert.equal(await new Coordinator(store, core).runOnce({ projectId: other.id, agentId: agents[0]!.id, workerId: 'other-project' }, async () => { throw new Error('Must not run') }), 'idle')
    assert.equal(await new Coordinator(store, core).runOnce({ projectId: project.id, agentId: agents[2]!.id, workerId: 'other-agent' }, async () => { throw new Error('Must not run') }), 'idle')
    assert.equal(await new Coordinator(store, core).runOnce(identity(job, 'scoped'), async () => ({ title: 'Scoped result', content: 'Correct worker scope' })), 'completed')
    await assertOne(job)
    await assert.rejects(state.query('SELECT * FROM forge.tasks'), (error: unknown) => (error as { code: string }).code === (split ? '42P01' : '42501'))
    const runtime = new pg.Client({ connectionString: coreUrl! })
    await runtime.connect()
    try { await assert.rejects(runtime.query('SELECT * FROM forge_coordinator.jobs'), (error: unknown) => (error as { code: string }).code === (split ? '42P01' : '42501')) }
    finally { await runtime.end() }
  })

  await context.test('refuses an existing manual execution instead of starting a duplicate', async () => {
    const job = await enqueue('manual-execution')
    const original = await core.startExecution({ projectId: job.projectId, taskId: job.taskId, agentId: job.agentId, executionKey: 'manual', idempotencyKey: 'manual' })
    assert.equal(await new Coordinator(store, core).runOnce(identity(job, 'pilot'), async () => { throw new Error('Must not run') }), 'failed')
    const running = await core.listExecutions({ projectId: job.projectId, taskId: job.taskId })
    assert.deepEqual(running.items.map((execution) => execution.id), [original.id])
  })

  await context.test('the pilot CLI enqueues, runs and inspects without exposing saved content', async () => {
    const task = await core.createTask({ projectId: project.id, taskKey: 'cli-pilot', title: 'CLI pilot', assignedAgentId: agents[1]!.id, status: 'ready', idempotencyKey: 'cli-pilot' })
    const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
    const env = { ...workerEnv, FORGE_COORDINATOR_PROJECT_KEY: project.projectKey, FORGE_COORDINATOR_AGENT_KEY: agents[1]!.agentKey }
    const invoke = (args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { env, timeout: 15_000 })
    const queued = JSON.parse((await invoke(['enqueue', project.projectKey, task.taskKey])).stdout) as { jobId: string; state: string }
    assert.equal(queued.state, 'queued')
    assert.deepEqual(JSON.parse((await invoke(['worker'])).stdout), { state: 'completed' })
    const job = await store.enqueue({ projectId: project.id, taskId: task.id, taskKey: task.taskKey, agentId: agents[1]!.id })
    assert.equal(job.id, queued.jobId)
    await assertOne(job)
    const inspection = (await invoke(['status', project.projectKey, task.taskKey])).stdout
    assert.equal((JSON.parse(inspection) as { job: { state: string } }).job.state, 'completed')
    assert.doesNotMatch(inspection, /artifact|content|postgresql|password/)
  })

  await context.test('prepared artifacts cannot be overwritten by a different retry payload', async () => {
    const job = await enqueue('immutable-artifact', agents[2]!.id, 1)
    const claim = await store.claim(identity(job, 'immutable'))
    assert.ok(claim)
    await store.fenced(claim, async () => ({ value: undefined, artifact: { title: 'Saved', content: 'Immutable' } }))
    await assert.rejects(store.fenced(claim, async () => ({ value: undefined, artifact: { title: 'Changed', content: 'Different' } })), /immutable/)
    assert.equal((await state.query('SELECT artifact FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0].artifact.content, 'Immutable')
    await store.fail(claim)
  })

  await context.test('death on the final attempt becomes visible failed work rather than an endless retry', async () => {
    const job = await enqueue('exhausted-crash', agents[2]!.id, 1)
    const worker = spawn(job.agentId, 'final-attempt', 'crash-after-start')
    await worker.wait('execution-started')
    worker.child.kill('SIGKILL')
    await worker.done
    await expired(job)
    const beforeList = (await state.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows
    const blocked = (await store.listBlocked(job.projectId)).jobs.find((row) => row.id === job.id)
    assert.ok(blocked)
    assert.equal(blocked.state, 'running')
    assert.equal(blocked.exhaustion_reason, 'ATTEMPTS_EXHAUSTED')
    assert.deepEqual((await state.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows, beforeList)
    assert.equal(await new Coordinator(store, core).runOnce(identity(job, 'late-retry'), async () => { throw new Error('Must not run') }), 'idle')
    const failed = (await state.query('SELECT state,attempts,error_code FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0]
    assert.deepEqual(failed, { state: 'failed', attempts: 1, error_code: 'ATTEMPTS_EXHAUSTED' })
    assert.equal((await core.listExecutions({ projectId: job.projectId, taskId: job.taskId })).items.length, 1)
  })

  await context.test('list-blocked scopes, redacts and pages without mutating state or effects', async () => {
    const projectId = randomUUID(), otherProject = randomUUID()
    const inserted: string[] = []
    const add = async (scope: string, stateName: string, attempts: number, lease: string | null, error: string | null = null) => {
      const id = randomUUID()
      inserted.push(id)
      await state.query(`INSERT INTO forge_coordinator.jobs
        (id,project_id,task_id,task_key,agent_id,state,attempts,max_attempts,lease_until,error_code,artifact,effect_receipt,effect_kind,effect_target,owner)
        VALUES ($1,$2,$3,($1::uuid)::text,$4,$5,$6,3,$7,$8,'{"title":"private","content":"secret"}',
          '{"filename":"private-path","sha256":"private-hash"}','immutable-report-v1',$9,'private-owner')`,
      [id, scope, randomUUID(), randomUUID(), stateName, attempts, lease, error, 'a'.repeat(64)])
      return id
    }
    try {
      const terminal = await add(projectId, 'failed', 1, null, 'EFFECT_UNCONFIRMED')
      const exhausted = await add(projectId, 'queued', 3, null, 'WORKER_FAILED')
      await add(otherProject, 'failed', 1, null)
      await add(projectId, 'running', 3, '2999-01-01')
      await add(projectId, 'running', 1, '2000-01-01')
      await add(projectId, 'queued', 0, null)
      await add(projectId, 'completed', 3, null)
      const expected = [terminal, exhausted, await add(projectId, 'running', 3, '2000-01-01')]
      for (let i = 0; i < 51; i++) expected.push(await add(projectId, 'failed', 2, null))
      const snapshot = async () => (await state.query('SELECT * FROM forge_coordinator.jobs WHERE id=ANY($1::uuid[]) ORDER BY id', [inserted])).rows
      const before = await snapshot()
      const first = await store.listBlocked(projectId)
      assert.equal(first.jobs.length, 50)
      assert.equal(first.nextAfterJobId, first.jobs[49]!.id)
      const second = await store.listBlocked(projectId, first.nextAfterJobId!)
      assert.equal(second.nextAfterJobId, null)
      assert.deepEqual([...first.jobs, ...second.jobs].map((row) => row.id), expected.sort())
      assert.deepEqual(await store.listBlocked(projectId), first)
      const failed = first.jobs.concat(second.jobs).find((row) => row.id === terminal)!
      assert.equal(failed.error_code, 'EFFECT_UNCONFIRMED')
      assert.equal(failed.exhaustion_reason, null)
      assert.equal(failed.has_prepared_output, true)
      assert.equal(failed.has_effect_receipt, true)
      assert.deepEqual(Object.keys(failed).sort(), ['id','project_id','task_id','task_key','agent_id','state','attempts','max_attempts','error_code','created_at','updated_at','lease_until','effect_kind','has_prepared_output','has_effect_receipt','exhaustion_reason'].sort())
      await assert.rejects(store.listBlocked('invalid'), /UUID/)
      await assert.rejects(store.listBlocked(projectId, 'invalid'), /UUID/)
      const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
      const env: NodeJS.ProcessEnv = { ...workerEnv, FORGE_COORDINATOR_REPORT_ROOT: 'invalid-root', FORGE_COORDINATOR_AGENT_MODE: 'invalid-mode' }
      delete env.FORGE_DATABASE_URL
      const invoke = (args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { env, timeout: 15_000 })
      assert.deepEqual(JSON.parse((await invoke(['list-blocked', projectId])).stdout), JSON.parse(JSON.stringify(first)))
      assert.deepEqual(JSON.parse((await invoke(['list-blocked', projectId, first.nextAfterJobId!])).stdout), JSON.parse(JSON.stringify(second)))
      for (const args of [[], ['invalid'], [projectId, 'invalid'], [projectId, randomUUID(), 'extra']]) {
        await assert.rejects(invoke(['list-blocked', ...args]), (error: unknown) => {
          const failure = error as { code: number; stderr: string }
          assert.equal(failure.code, 2)
          assert.match(failure.stderr, /Usage: list-blocked/)
          return true
        })
      }
      assert.deepEqual(await snapshot(), before)
    } finally { await state.query('DELETE FROM forge_coordinator.jobs WHERE id=ANY($1::uuid[])', [inserted]) }
  })

  async function assertReport(job: Job) {
    await assertOne(job)
    const row = (await state.query('SELECT artifact,effect_receipt FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0]
    const expected = reportIdentity(`coordinator:v1:${job.projectId}:${job.taskId}:report`, row.artifact, publisher.targetId)
    assert.deepEqual(row.effect_receipt, expected.receipt)
    const output = await readFile(path.join(reportsRoot, expected.receipt.filename), 'utf8')
    assert.equal(output, expected.bytes.toString('utf8'))
    assert.match(output, /sum|rest|subtract|a\s*-\s*b/i)
    assert.equal((await store.inspect(job.projectId, job.taskId))?.effect_state, 'confirmed')
    return stat(path.join(reportsRoot, expected.receipt.filename))
  }

  await context.test('three model-backed agents publish scoped reports through six competing processes', async () => {
    const jobs = await Promise.all(agents.map((agent, index) => enqueue(`agent-review-${index}`, agent.id, 3, true)))
    const workers = agents.flatMap((agent) => [spawn(agent.id, `model-${agent.id}-a`, 'agent-normal'), spawn(agent.id, `model-${agent.id}-b`, 'agent-normal')])
    assert.deepEqual(await Promise.all(workers.map((worker) => worker.done)), [0, 0, 0, 0, 0, 0], JSON.stringify(workers.flatMap((worker) => worker.messages)))
    for (const job of jobs) {
      await assertReport(job)
      if (liveModel) assert.ok((calls.get(job.taskKey) ?? 0) >= 1 && (calls.get(job.taskKey) ?? 0) <= 3)
      else assert.equal(calls.get(job.taskKey), 1)
      assert.equal(successfulCalls.get(job.taskKey), 1)
    }
  })

  for (const [mode, phase] of [
    ['agent-crash-after-model', 'model-returned'], ['agent-crash-after-effect', 'effect-created'],
    ['agent-crash-after-receipt', 'effect-confirmed'], ['agent-crash-after-core', 'effect-core-finished'],
  ] as const) {
    await context.test(`model/report recovery after ${phase} neither duplicates effects nor replays saved inference`, async () => {
      const agent = await core.registerAgent({ agentKey: `${suffix}-${mode}`, name: `Recovery ${mode}` })
      await core.assignAgent(project.id, agent.id, 'recovery-test')
      const job = await enqueue(mode, agent.id, 3, true)
      const worker = spawn(job.agentId, mode, mode)
      await worker.wait(phase)
      const beforeRow = (await state.query('SELECT artifact,effect_receipt FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0]
      const file = beforeRow.artifact ? path.join(reportsRoot, reportIdentity(`coordinator:v1:${job.projectId}:${job.taskId}:report`, beforeRow.artifact, publisher.targetId).receipt.filename) : null
      const before = file ? await stat(file) : null
      if (mode === 'agent-crash-after-model') assert.equal(beforeRow.artifact, null)
      if (mode === 'agent-crash-after-effect') assert.equal(beforeRow.effect_receipt, null)
      if (mode === 'agent-crash-after-receipt' || mode === 'agent-crash-after-core') assert.ok(beforeRow.effect_receipt)
      worker.child.kill('SIGKILL')
      await worker.done
      await expired(job)
      const replacement = spawn(job.agentId, `replacement-${mode}`, mode === 'agent-crash-after-model' ? 'agent-normal' : 'agent-recover-saved')
      assert.equal(await replacement.done, 0, JSON.stringify({ messages: replacement.messages, stderr: replacement.stderr() }))
      const after = await assertReport(job)
      assert.equal(successfulCalls.get(job.taskKey), mode === 'agent-crash-after-model' ? 2 : 1)
      if (before) { assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs) }
    })
  }

  for (const swept of [false, true]) {
    await context.test(`reconcile-report verifies final-attempt death without replay (swept=${swept})`, async () => {
      const label = `reconcile-${swept}`
      const agent = await core.registerAgent({ agentKey: `${suffix}-${label}`, name: label })
      await core.assignAgent(project.id, agent.id, 'recovery-test')
      const job = await enqueue(label, agent.id, 1, true)
      const worker = spawn(agent.id, label, 'agent-crash-after-core')
      await worker.wait('effect-core-finished')
      worker.child.kill('SIGKILL'); await worker.done
      const row = async () => (await state.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0]
      const initial = await row()
      const file = path.join(reportsRoot, initial.effect_receipt.filename)
      const bytes = await readFile(file), info = await stat(file)
      const snapshot = async () => {
        const execution = await core.getExecutionByKey(project.id, `coordinator:v1:${project.id}:${job.taskId}`)
        return { task: await core.getTaskByKey(project.id, job.taskKey), execution,
          audit: await core.getAuditTrail(project.id, execution.id),
          events: (await admin.query('SELECT * FROM forge.events WHERE project_id=$1 ORDER BY id', [project.id])).rows,
          allAudit: (await admin.query('SELECT * FROM forge.audit_log WHERE project_id=$1 ORDER BY id', [project.id])).rows,
          memories: await core.listMemories({ projectId: project.id, taskId: job.taskId }),
          contexts: await core.listContinuationPackages({ projectId: project.id, executionId: execution.id }) }
      }
      const before = await snapshot(), providerCalls = calls.get(label)
      const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
      const env: NodeJS.ProcessEnv = { ...workerEnv, FORGE_COORDINATOR_REPORT_ROOT: reportsRoot, FORGE_COORDINATOR_AGENT_MODE: 'invalid' }
      const invoke = (args = [project.id, job.id]) => promisify(execFile)(process.execPath, [cli, 'reconcile-report', ...args], { env, timeout: 15_000 })
      const rejectUnchanged = async (args?: string[]) => {
        const prior = await row()
        await assert.rejects(invoke(args), (error: unknown) => {
          const failure = error as { code: number; stdout: string; stderr: string }
          assert.ok(failure.code === 1 || failure.code === 2)
          assert.ok(!failure.stdout.includes(reportsRoot) && !failure.stderr.includes(reportsRoot))
          return true
        })
        assert.deepEqual(await row(), prior)
      }
      // Seed a live lease only after process death released its transaction lock.
      await state.query("UPDATE forge_coordinator.jobs SET lease_until=clock_timestamp()+interval '1 hour' WHERE id=$1", [job.id])
      await rejectUnchanged()
      await state.query("UPDATE forge_coordinator.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id])
      assert.ok((await store.listBlocked(project.id)).jobs.some(item => item.id === job.id))
      for (const args of [[], ['invalid', job.id], [project.id, 'invalid'], [project.id, job.id, 'extra'], [randomUUID(), job.id], [project.id, randomUUID()]]) await rejectUnchanged(args)
      for (const patch of ["artifact=NULL", "effect_receipt=NULL", "effect_receipt=effect_receipt || '{\"sha256\":\"wrong\"}'::jsonb", "effect_target=repeat('b',64)", "state='queued'", "state='failed',error_code='EFFECT_UNCONFIRMED'", "max_attempts=2"]) {
        await state.query(`UPDATE forge_coordinator.jobs SET ${patch} WHERE id=$1`, [job.id])
        await rejectUnchanged()
        await state.query("UPDATE forge_coordinator.jobs SET artifact=$2,effect_receipt=$3,effect_target=$4,state='running',error_code=NULL,max_attempts=1 WHERE id=$1",
          [job.id, initial.artifact, initial.effect_receipt, initial.effect_target])
      }
      const hidden = `${file}.hidden`
      await rename(file, hidden)
      try { await rejectUnchanged(); assert.deepEqual(await readdir(reportsRoot), (await readdir(reportsRoot)).filter(name => name !== initial.effect_receipt.filename)) }
      finally { await rename(hidden, file) }
      await writeFile(file, 'corrupt')
      try { await rejectUnchanged(); assert.equal(await readFile(file, 'utf8'), 'corrupt') }
      finally { await writeFile(file, bytes) }
      const verifiedInfo = await stat(file)
      if (swept) {
        assert.equal(await store.claim(identity(job, 'sweeper'), { kind: publisher.kind, targetId: publisher.targetId }), null)
        assert.equal((await row()).error_code, 'ATTEMPTS_EXHAUSTED')
      }
      if (!swept) {
        // Only this CLI receives admission configuration; keep gate files outside the receiver.
        const gateParent = await mkdtemp(path.join(fixtureRoot ?? tmpdir(), 'forge-reconcile-gate-'))
        context.after(() => rm(gateParent, { recursive: true, force: true }))
        const gate = await OperationalGate.initialize(path.join(gateParent, 'admission'))
        env.FORGE_OPERATIONAL_GATE_ROOT = gate.root
        const lease = await gate.close()
        await rejectUnchanged()
        await lease.assertHeld()
        await lease.resume()
      }
      const prior = await row()
      const results = await Promise.all([invoke(), invoke()])
      assert.deepEqual(results.map(result => JSON.parse(result.stdout).outcome).sort(), ['already_completed', 'completed'])
      assert.equal(JSON.parse((await invoke()).stdout).outcome, 'already_completed')
      const final = await row()
      assert.deepEqual(final, { ...prior, state: 'completed', owner: null, lease_until: null, error_code: null, updated_at: final.updated_at })
      assert.deepEqual(await snapshot(), before)
      assert.equal(calls.get(label), providerCalls)
      assert.deepEqual(await readFile(file), bytes)
      const after = await stat(file)
      assert.equal(after.ino, info.ino); assert.equal(after.mtimeMs, verifiedInfo.mtimeMs)
    })
  }

  await context.test('reconcile-report refuses receipt with unfinished Core', async () => {
    const agent = await core.registerAgent({ agentKey: `${suffix}-reconcile-incomplete`, name: 'Incomplete Core' })
    await core.assignAgent(project.id, agent.id, 'recovery-test')
    const job = await enqueue('reconcile-incomplete', agent.id, 1, true)
    const worker = spawn(agent.id, 'incomplete', 'agent-crash-after-receipt')
    await worker.wait('effect-confirmed'); worker.child.kill('SIGKILL'); await worker.done
    await expired(job)
      const before = (await state.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0]
    const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
    await assert.rejects(promisify(execFile)(process.execPath, [cli, 'reconcile-report', project.id, job.id], {
      env: { ...workerEnv, FORGE_COORDINATOR_REPORT_ROOT: reportsRoot }, timeout: 15_000,
    }))
    assert.deepEqual((await state.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0], before)
  })

  for (const afterDeath of [true, false]) {
    await context.test(afterDeath
      ? 'retained receipt rejects artifact loss after worker death following receipt commit'
      : 'retained receipt with null artifact rejects a ready task before Core admission', async () => {
      const label = afterDeath ? 'receipt-lost-artifact-after-death' : 'receipt-ready-no-execution'
      const agent = await core.registerAgent({ agentKey: `${suffix}-${label}`, name: label })
      await core.assignAgent(project.id, agent.id, 'recovery-test')
      const job = await enqueue(label, agent.id, 3, true)
      if (afterDeath) {
        const worker = spawn(job.agentId, label, 'agent-crash-after-receipt')
        await worker.wait('effect-confirmed')
        // This phase is emitted only after the receipt transaction committed.
        const committed = (await state.query('SELECT artifact,effect_receipt FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0]
        assert.ok(committed.artifact)
        assert.ok(committed.effect_receipt)
        assert.equal(worker.child.kill('SIGKILL'), true)
        await worker.done
        assert.ok(worker.child.exitCode !== null || worker.child.signalCode !== null)
        await expired(job)
      } else {
        // Seed only disposable coordinator state and the real receiver; Core stays ready.
        const claim = await store.claim(identity(job, 'receipt-seed'), { kind: publisher.kind, targetId: publisher.targetId })
        assert.ok(claim)
        const artifact = { title: 'Retained review', content: 'subtract suma en vez de restar' }
        await store.fenced(claim, async () => ({ value: undefined, artifact }))
        const receipt = await publisher.publish({ key: `coordinator:v1:${job.projectId}:${job.taskId}:report`, artifact, signal: new AbortController().signal })
        await store.fenced(claim, async () => ({ value: undefined, effectReceipt: receipt }))
        await store.fail(claim)
      }
      const saved = (await state.query('SELECT artifact,effect_receipt FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0]
      const expected = reportIdentity(`coordinator:v1:${job.projectId}:${job.taskId}:report`, saved.artifact, publisher.targetId)
      assert.deepEqual(saved.effect_receipt, expected.receipt)
      const file = path.join(reportsRoot, expected.receipt.filename)
      const bytes = await readFile(file)
      assert.deepEqual(bytes, expected.bytes)
      const fileBefore = await stat(file)
      const snapshot = async () => ({
        task: await core.getTaskByKey(job.projectId, job.taskKey),
        executions: (await core.listExecutions({ projectId: job.projectId, taskId: job.taskId })).items,
        memories: (await core.listMemories({ projectId: job.projectId, taskId: job.taskId })).items,
        contexts: (await core.listContinuationPackages({ projectId: job.projectId })).items,
      })
      const before = await snapshot()
      assert.equal(before.task.status, afterDeath ? 'in_progress' : 'ready')
      assert.equal(before.executions.length, afterDeath ? 1 : 0)
      assert.equal(before.memories.length, 0)
      // Simulate partial control-state loss through its existing disposable owner.
      assert.equal((await state.query('UPDATE forge_coordinator.jobs SET artifact=NULL WHERE id=$1', [job.id])).rowCount, 1)
      const coreCalls: string[] = []
      const observed: CorePort = new Proxy(core, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => { coreCalls.push(String(property)); return Reflect.apply(value, target, args) }
        },
      })
      let handlerCalls = 0
      const modelCalls = calls.get(label) ?? 0
      assert.equal(await new Coordinator(store, observed, { publisher }).runOnce(identity(job, 'receipt-recovery'), async (input) => {
        handlerCalls++
        return new LocalReportAgent({ baseUrl: workerEnv.FORGE_COORDINATOR_AGENT_BASE_URL!, model: workerEnv.FORGE_COORDINATOR_AGENT_MODEL! }).run(input)
      }), 'failed')
      assert.deepEqual(coreCalls, ['assertReady'], 'Reject before task lookup, execution admission or Core publication')
      assert.equal(handlerCalls, 0)
      assert.equal(calls.get(label) ?? 0, modelCalls)
      assert.deepEqual(await snapshot(), before)
      const rejected = (await state.query('SELECT state,artifact,effect_receipt,error_code FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0]
      assert.deepEqual(rejected, { state: 'queued', artifact: null, effect_receipt: saved.effect_receipt, error_code: 'EFFECT_UNCONFIRMED' })
      assert.deepEqual(await readFile(file), bytes)
      const fileAfter = await stat(file)
      assert.equal(fileAfter.ino, fileBefore.ino)
      assert.equal(fileAfter.mtimeMs, fileBefore.mtimeMs)
    })
  }

  await context.test('a survivor report without either checkpoint fails only its task before Core admission', async () => {
    const label = 'survivor-no-checkpoints'
    const agent = await core.registerAgent({ agentKey: `${suffix}-${label}`, name: label })
    await core.assignAgent(project.id, agent.id, 'recovery-test')
    const blocked = await enqueue(label, agent.id, 3, true)
    const next = await enqueue(label + '-next', agent.id, 3, true)
    const artifact = { title: 'Surviving review', content: 'Original immutable bytes' }
    const receipt = await publisher.publish({ key: `coordinator:v1:${blocked.projectId}:${blocked.taskId}:report`, artifact, signal: new AbortController().signal })
    const file = path.join(reportsRoot, receipt.filename)
    const bytes = await readFile(file)
    const before = await stat(file, { bigint: true })
    const snapshot = async () => ({
      task: await core.getTaskByKey(blocked.projectId, blocked.taskKey),
      executions: (await core.listExecutions({ projectId: blocked.projectId, taskId: blocked.taskId })).items,
      memories: (await core.listMemories({ projectId: blocked.projectId, taskId: blocked.taskId })).items,
      contexts: (await core.listContinuationPackages({ projectId: blocked.projectId })).items,
    })
    const original = await snapshot()
    assert.equal(original.task.status, 'ready')
    assert.equal(original.executions.length, 0)
    const coreCalls: string[] = []
    const observed: CorePort = new Proxy(core, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => { coreCalls.push(String(property)); return Reflect.apply(value, target, args) }
      },
    })
    const handled: string[] = []
    const handler = async (input: Parameters<LocalReportAgent['run']>[0]) => {
      handled.push(input.task.id)
      return new LocalReportAgent({ baseUrl: workerEnv.FORGE_COORDINATOR_AGENT_BASE_URL!, model: workerEnv.FORGE_COORDINATOR_AGENT_MODEL! }).run(input)
    }
    const coordinator = new Coordinator(store, observed, { publisher })
    const worker = identity(blocked, 'survivor-recovery')
    assert.equal(await coordinator.runOnce(worker, handler), 'failed')
    assert.deepEqual(coreCalls, ['assertReady'])
    assert.deepEqual(handled, [])
    assert.equal(calls.get(label) ?? 0, 0)
    assert.deepEqual(await snapshot(), original)
    const rejected = (await state.query('SELECT state,artifact,effect_receipt,error_code,attempts FROM forge_coordinator.jobs WHERE id=$1', [blocked.id])).rows[0]
    assert.deepEqual(rejected, { state: 'failed', artifact: null, effect_receipt: null, error_code: 'EFFECT_UNCONFIRMED', attempts: 1 })
    const status = await store.inspect(blocked.projectId, blocked.taskId)
    assert.equal(status?.state, 'failed')
    assert.equal(status?.error_code, 'EFFECT_UNCONFIRMED')
    assert.equal(status?.effect_state, 'unconfirmed')
    assert.equal(await coordinator.runOnce(worker, handler), 'completed')
    assert.deepEqual(handled, [next.taskId])
    await assertOne(next)
    assert.equal(await coordinator.runOnce(worker, handler), 'idle')
    assert.equal((await store.inspect(blocked.projectId, blocked.taskId))?.attempts, 1)
    assert.equal(calls.get(label) ?? 0, 0)
    assert.deepEqual(await readFile(file), bytes)
    const after = await stat(file, { bigint: true })
    assert.equal(after.dev, before.dev)
    assert.equal(after.ino, before.ino)
    assert.equal(after.mtimeNs, before.mtimeNs)
    const final = await snapshot()
    assert.deepEqual(final.task, original.task)
    assert.deepEqual(final.executions, original.executions)
    assert.deepEqual(final.memories, original.memories)
  })

  await context.test('an old model worker cannot publish a report after losing ownership', async () => {
    const job = await enqueue('agent-stale-result', agents[1]!.id, 3, true)
    let release!: () => void
    const model = new LocalReportAgent({ baseUrl: workerEnv.FORGE_COORDINATOR_AGENT_BASE_URL!, model: workerEnv.FORGE_COORDINATOR_AGENT_MODEL! })
    const paused: JobStore = { leaseMs: store.leaseMs, claim: store.claim.bind(store), fenced: store.fenced.bind(store), fail: store.fail.bind(store), heartbeat: async () => true }
    const oldHandler = async (input: Parameters<LocalReportAgent['run']>[0]) => {
      const artifact = await model.run(input)
      await new Promise<void>((resolve) => { release = resolve })
      return artifact
    }
    const old = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const outcome = await new Coordinator(paused, core, { publisher }).runOnce(identity(job, 'old-model-worker'), oldHandler)
        if (outcome !== 'failed' || (await store.inspect(job.projectId, job.taskId))?.state !== 'queued') return outcome
        await delay(1_000)
      }
      return 'failed'
    })()
    await until(async () => typeof release === 'function', 65_000)
    try {
      await expired(job)
      const replacement = spawn(job.agentId, 'new-model-worker', 'agent-normal')
      assert.equal(await replacement.done, 0, JSON.stringify(replacement.messages))
    } finally { release() }
    assert.equal(await old, 'lost')
    await assertReport(job)
    assert.equal(successfulCalls.get(job.taskKey), 2)
  })

  await context.test('policy/target drift and conflicting receiver content cannot become Core success', async () => {
    const job = await enqueue('agent-policy-target', agents[2]!.id, 2, true)
    const wrongRoot = path.join(reportsRoot, 'other-target')
    await mkdir(wrongRoot)
    const wrong = new ImmutableReportPublisher(wrongRoot)
    assert.equal(await new Coordinator(store, core).runOnce(identity(job, 'downgraded'), async () => { throw new Error('Must not run') }), 'idle')
    assert.equal(await new Coordinator(store, core, { publisher: wrong }).runOnce(identity(job, 'wrong-target'), async () => { throw new Error('Must not run') }), 'idle')
    assert.equal((await store.inspect(job.projectId, job.taskId))?.attempts, 0)
    const claim = await store.claim(identity(job, 'prepared'), { kind: publisher.kind, targetId: publisher.targetId })
    assert.ok(claim)
    const artifact = { title: 'Prepared review', content: 'subtract suma en vez de restar' }
    await store.fenced(claim, async () => ({ value: undefined, artifact }))
    await store.fail(claim)
    const expected = reportIdentity(`coordinator:v1:${job.projectId}:${job.taskId}:report`, artifact, publisher.targetId)
    await writeFile(path.join(reportsRoot, expected.receipt.filename), 'Conflicting external data', { flag: 'wx' })
    const blocked = spawn(job.agentId, 'conflicting-report', 'agent-recover-saved')
    assert.equal(await blocked.done, 1)
    assert.equal((await store.inspect(job.projectId, job.taskId))?.error_code, 'EFFECT_CONFLICT')
    assert.equal((await core.listMemories({ projectId: job.projectId, taskId: job.taskId })).items.length, 0)
    assert.notEqual((await core.getTaskByKey(job.projectId, job.taskKey)).status, 'done')
    assert.equal(await readFile(path.join(reportsRoot, expected.receipt.filename), 'utf8'), 'Conflicting external data')
    assert.deepEqual(await readdir(wrongRoot), [])
  })

  await context.test('real-agent CLI preserves queued effect policy and exposes confirmation without content', async () => {
    const agent = await core.registerAgent({ agentKey: `${suffix}-agent-cli`, name: 'CLI recovery agent' })
    await core.assignAgent(project.id, agent.id, 'cli-test')
    const task = await core.createTask({ projectId: project.id, taskKey: 'agent-cli', title: 'agent-cli', objective: 'Review function subtract(a,b){return a+b;}. Explain the bug briefly in Spanish.', assignedAgentId: agent.id, status: 'ready', idempotencyKey: 'agent-cli' })
    const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
    const env = { ...workerEnv, FORGE_COORDINATOR_AGENT_MODE: 'local-report', FORGE_COORDINATOR_PROJECT_KEY: project.projectKey, FORGE_COORDINATOR_AGENT_KEY: agent.agentKey }
    const invoke = (args: string[]) => promisify(execFile)(process.execPath, [cli, ...args], { env, timeout: 70_000 })
    assert.equal((JSON.parse((await invoke(['enqueue', project.projectKey, task.taskKey])).stdout) as { state: string }).state, 'queued')
    await assert.rejects(invoke(['worker']), (error: unknown) => (error as { code: number }).code === 1)
    const interrupted = await store.inspect(project.id, task.id)
    assert.equal(interrupted?.effect_state, 'unconfirmed')
    assert.equal(interrupted?.error_code, 'AGENT_HTTP_ERROR')
    assert.equal(interrupted?.state, 'queued')
    assert.equal(interrupted?.attempts, 1)
    assert.equal((await core.listMemories({ projectId: project.id, taskId: task.id })).items.length, 0)
    let recovered = false
    for (let attempt = 0; attempt < 2; attempt++) {
      try { assert.deepEqual(JSON.parse((await invoke(['worker'])).stdout), { state: 'completed' }); recovered = true; break }
      catch (error) {
        const current = await store.inspect(project.id, task.id)
        if (current?.state !== 'queued' || !String(current.error_code).startsWith('AGENT_')) throw error
        await delay(1_000)
      }
    }
    assert.equal(recovered, true)
    const job = await store.enqueue({ projectId: project.id, taskId: task.id, taskKey: task.taskKey, agentId: agent.id }, 3, { kind: publisher.kind, targetId: publisher.targetId })
    await assertReport(job)
    const inspected = (await invoke(['status', project.projectKey, task.taskKey])).stdout
    assert.equal((JSON.parse(inspected) as { job: { effect_state: string } }).job.effect_state, 'confirmed')
    assert.match((JSON.parse(inspected) as { job: { report_file: string } }).job.report_file, /^[a-f0-9]{64}\.report\.md$/)
    assert.doesNotMatch(inspected, /artifact|postgresql|password|La funcion/)
    assert.equal(successfulCalls.get(task.taskKey), 1)
  })
  const reportCount = (await readdir(reportsRoot)).filter((name) => name.endsWith('.report.md')).length
  const counts = (await state.query(`SELECT
    count(*) FILTER (WHERE state='completed' AND effect_receipt IS NOT NULL)::int AS completed,
    count(*) FILTER (WHERE state<>'completed' AND effect_receipt IS NOT NULL)::int AS retained
    FROM forge_coordinator.jobs WHERE project_id=$1`, [project.id])).rows[0]
  context.diagnostic(JSON.stringify({ mode: liveModel ? 'live-local-model' : 'protocol-fixture', model: liveModel ?? 'fixture-review-model', realCalls, totalCalls: [...calls.values()].reduce((sum, count) => sum + count, 0), reports: reportCount, completedConfirmedEffects: counts.completed, retainedReceiptsOnRejectedJobs: counts.retained, conflictsRejected: 1, providerFailures }))
  assert.equal(counts.completed, 12)
  assert.equal(counts.retained, 3)
  if (liveModel) assert.ok(realCalls >= 10, 'Real model inference must actually run in live acceptance')

  await context.test('opt-in joint logical restore retains confirmed report and Core identity', {
    skip: process.env.FORGE_COORDINATOR_TEST_RESTORE !== '1', timeout: split ? 120_000 : 60_000,
  }, async () => {
    // Optional staged integration: ordinary PG14 coordinator CI does not build resilience.
    // The opt-in Windows wrapper builds this workspace package before loading it.
    const resiliencePackage: string = 'forge-resilience'
    const { captureCoherentPostgresArchive, createCoherentGeneration, withVerifiedCoherentGeneration } = split ? await import(resiliencePackage) : {}
    assert.equal(liveModel, undefined, 'Restore drill is synthetic only')
    const source = new URL(adminUrl!)
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname), 'Loopback disposable database only')
    assert.equal(new URL(coreUrl!).host, source.host)
    assert.equal(new URL(coreUrl!).pathname, source.pathname)
    if (!split) assert.equal(stateUrl.pathname, source.pathname)
    const bin = process.env.FORGE_COORDINATOR_TEST_PG_BIN!
    assert.ok(bin && path.isAbsolute(bin))
    const destination = `forge_restore_${randomUUID().replaceAll('-', '')}`
    const reportsRoot = await mkdtemp(path.join(tmpdir(), 'forge lost rÃ©cepteur-'))
    const publisher = new ImmutableReportPublisher(reportsRoot)
    const backupRoot = await mkdtemp(path.join(tmpdir(), 'forge-joint-backup-'))
    const relocated = path.join(backupRoot, 'relocated')
    const dump = path.join(backupRoot, 'joint.dump')
    const invoke = async (tool: string, args: string[]) => {
      await promisify(execFile)(path.join(bin, `${tool}${process.platform === 'win32' ? '.exe' : ''}`), args,
        { timeout: 30_000, env: { ...workerEnv, PGHOST: source.hostname, PGPORT: source.port, PGUSER: source.username, PGPASSWORD: source.password } })
    }
    const targetCluster = new pg.Client({ connectionString: freshTarget ?? adminUrl! })
    if (!split) await targetCluster.connect()
    if (freshTarget && !split) {
      assert.equal((await targetCluster.query('SHOW server_version')).rows[0].server_version.split(' ')[0], '18.4')
      assert.notEqual((await targetCluster.query('SELECT system_identifier FROM pg_control_system()')).rows[0].system_identifier,
        (await admin.query('SELECT system_identifier FROM pg_control_system()')).rows[0].system_identifier)
      assert.equal((await targetCluster.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('forge_runtime',$1)", [role])).rows[0].n, 0)
    }
    const invokeTarget = async (tool: string, args: string[]) => {
      const destinationUrl = new URL(freshTarget ?? adminUrl!)
      await promisify(execFile)(path.join(bin, `${tool}${process.platform === 'win32' ? '.exe' : ''}`), args,
        { timeout: 30_000, env: { ...workerEnv, PGHOST: destinationUrl.hostname, PGPORT: destinationUrl.port, PGUSER: destinationUrl.username, PGPASSWORD: decodeURIComponent(destinationUrl.password) } })
    }
    const destinationState = split ? `${destination}_state` : destination
    const stateDump = path.join(backupRoot, 'state.dump')
    const invokeState = async (output: string) => {
      await invoke('pg_dump', ['--format=custom', '--file', output, '--dbname', stateUrl.pathname.slice(1)])
    }
    let cutMono = 0
    let outageMono = 0
    let outage = ''
    let provisionMs = 0
    let authenticationMs = 0
    let databaseRestoreMs = 0
    let retained: Record<string, unknown> = {}
    const lostIds: string[] = []
    let captureMs = 0
    let restoreStarted = 0
    let cutoff = ''
    let postCutoffTask: string | undefined
    let created = false
    let restoredStore: PostgresJobStore | undefined
    let restoredCore: ReturnType<typeof ForgePersistenceGateway.connect> | undefined
    let restoredAdmin: pg.Client | undefined
    let restoredStateAdmin: pg.Client | undefined
    let file: string | undefined
    let authenticatedReport: Buffer | undefined
    let coherent: { directory: string; generation: string } | undefined
    let maintenanceHeld = false
    const locks: pg.Client[] = []
    let bytes: Buffer | undefined
    try {
      const agent = await core.registerAgent({ agentKey: `${suffix}-joint-restore`, name: 'Synthetic joint restore' })
      await core.assignAgent(project.id, agent.id, 'restore-test')
      const task = await core.createTask({ projectId: project.id, taskKey: 'joint-restore', title: 'joint-restore', assignedAgentId: agent.id, status: 'ready', idempotencyKey: 'joint-restore' })
      const job = await store.enqueue({ projectId: project.id, taskId: task.id, taskKey: task.taskKey, agentId: agent.id }, 3, publisher)
      const worker = spawn(agent.id, 'restore-crash', 'agent-crash-after-receipt', reportsRoot)
      await worker.wait('effect-confirmed')
      worker.child.kill('SIGKILL')
      await worker.done
      await expired(job)
      const pendingTask = await core.createTask({ projectId: project.id, taskKey: 'joint-other', title: 'Other eligible task', assignedAgentId: agent.id, status: 'ready', idempotencyKey: 'joint-other' })
      const pending = await store.enqueue({ projectId: project.id, taskId: pendingTask.id, taskKey: pendingTask.taskKey, agentId: agent.id }, 3, publisher)
      const pendingBefore = (await state.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [pending.id])).rows[0]
      if (split) {
        // Historic reference is 59 projects/108 memories, never read from production.
        for (let i = 0; i < 58; i++) {
          const shaped = await core.registerProject({ projectKey: `split-${suffix}-${i}`, name: `Synthetic recovery project ${i}` })
          await core.assignAgent(shaped.id, agent.id, 'synthetic')
          for (let j = 0; j < 3; j++) await core.remember({ projectId: shaped.id, agentId: agent.id,
            memoryType: 'observation', content: `Synthetic retained memory ${i}/${j}`,
            provenance: { sourceKind: 'user', sourceRef: `split-${i}-${j}` }, idempotencyKey: `split-${i}-${j}` })
          const shapedTask = await core.createTask({ projectId: shaped.id, taskKey: 'shaped', title: 'Synthetic mixed-state job',
            assignedAgentId: agent.id, status: 'ready', idempotencyKey: 'shaped' })
          const shapedJob = await store.enqueue({ projectId: shaped.id, taskId: shapedTask.id, taskKey: shapedTask.taskKey, agentId: agent.id }, 1)
          if (i % 3 === 0) {
            assert.equal(await new Coordinator(store, core).runOnce(identity(shapedJob, 'shape-complete'), async () => ({ title: 'Synthetic', content: 'Retained completion' })), 'completed')
          } else if (i % 3 === 1) {
            const claimed = await store.claim(identity(shapedJob, 'shape-fail'))
            assert.ok(claimed); await store.fail(claimed)
          }
        }
      }
      // All earlier workers have exited. No writer runs during dump + byte backup.
      for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null)
      const saved = (await state.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0]
      assert.ok(saved.artifact && saved.effect_receipt)
      const execution = (await core.listExecutions({ projectId: project.id, taskId: job.taskId })).items[0]!
      assert.equal(execution.status, 'running')
      assert.equal((await core.listMemories({ projectId: project.id, taskId: job.taskId })).items.length, 0)
      assert.equal((await core.listContinuationPackages({ projectId: project.id, executionId: execution.id })).items.length, 0)
      // Receiver requests are fully drained and all child writers joined at this common cut.
      assert.equal(modelServer.listening, true)
      if (split) await new Promise<void>((resolve, reject) => modelServer.close(error => error ? reject(error) : resolve()))
      if (split) {
        // Fixture supervisor: receiver admissions stopped, all worker processes joined.
        // No coordinator/publisher loop remains. The only remaining test writer is this scope.
        maintenanceHeld = true
        for (const [url, schema] of [[adminUrl!, 'forge'], [stateAdminUrl!, 'forge_coordinator']]) {
          const lock = new pg.Client({ connectionString: url }); await lock.connect(); locks.push(lock)
          await lock.query('BEGIN')
          await lock.query("SET LOCAL lock_timeout='2s'")
          const tables = (await lock.query('SELECT tablename FROM pg_tables WHERE schemaname=$1', [schema])).rows
          for (const row of tables) await lock.query(`LOCK TABLE "${schema}"."${String(row.tablename).replaceAll('"', '""')}" IN EXCLUSIVE MODE`)
          // A bounded concurrent writer must reject while pg_dump SELECTs remain allowed.
          const contender = new pg.Client({ connectionString: url }); await contender.connect()
          try {
            await contender.query("SET lock_timeout='150ms'")
            const table = schema === 'forge' ? 'tasks' : 'jobs'
            await assert.rejects(contender.query(`SELECT * FROM ${schema}.${table} FOR UPDATE`), (error: unknown) => (error as { code: string }).code === '55P03')
            const column = schema === 'forge' ? 'title' : 'state'
            await assert.rejects(contender.query(`UPDATE ${schema}.${table} SET ${column}=${column}`), (error: unknown) => (error as { code: string }).code === '55P03')
          } finally { await contender.end() }
        }
        assert.equal(modelServer.listening, false, 'Receiver rejects new requests during capture')
      }
      const inventoryRows = async (coreDb: pg.Client, stateDb: pg.Client) => ({
        projects: (await coreDb.query('SELECT id FROM forge.projects ORDER BY id')).rows,
        memories: (await coreDb.query('SELECT id FROM forge.memories ORDER BY id')).rows,
        tasks: (await coreDb.query('SELECT id,status FROM forge.tasks ORDER BY id')).rows,
        runs: (await coreDb.query('SELECT id,status FROM forge.executions ORDER BY id')).rows,
        jobs: (await stateDb.query('SELECT id,task_id,state FROM forge_coordinator.jobs ORDER BY id')).rows,
      })
      if (split) retained = await inventoryRows(admin, stateAdmin)
      cutMono = performance.now()
      if (split) cutoff = (await admin.query('SELECT clock_timestamp()::text AS cutoff')).rows[0].cutoff
      const captureStarted = Date.now()
      file = path.join(reportsRoot, saved.effect_receipt.filename)
      bytes = await readFile(file)
      await writeFile(path.join(backupRoot, 'report.bytes'), bytes, { flag: 'wx' })
      const reportNames = (await readdir(reportsRoot)).sort()
      const directory = await stat(reportsRoot)
      const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
      const proofFile = path.join(backupRoot, 'preuve rÃ©cupÃ©rÃ©e.json')
      const captureEnv = { ...workerEnv, FORGE_DATABASE_URL: '', FORGE_COORDINATOR_DATABASE_URL: '', FORGE_COORDINATOR_REPORT_ROOT: reportsRoot }
      await promisify(execFile)(process.execPath, [cli, 'capture-report-target', proofFile], { env: captureEnv })
      const proof = JSON.parse(await readFile(proofFile, 'utf8'))
      assert.deepEqual(proof, captureReportTarget(reportsRoot))
      await assert.rejects(promisify(execFile)(process.execPath, [cli, 'capture-report-target', proofFile], { env: captureEnv }))
      assert.deepEqual(JSON.parse(await readFile(proofFile, 'utf8')), proof)
      // PS5.1 Set-Content -Encoding UTF8 writes this optional BOM.
      await writeFile(proofFile, '\uFEFF' + JSON.stringify(proof), 'utf8')
      if (freshTarget) assert.deepEqual(reportNames, [saved.effect_receipt.filename])
      const inventory = freshTarget ? [] : await Promise.all(reportNames.map(async name => [name, await readFile(path.join(reportsRoot, name))] as const))
      if (!split) cutoff = (await admin.query('SELECT clock_timestamp()::text AS cutoff')).rows[0].cutoff
      if (!split) await invoke('pg_dump', ['--format=custom', '--file', dump, '--dbname', source.pathname.slice(1)])
      if (!split) {
        await targetCluster.query(`CREATE DATABASE ${destination} TEMPLATE template0`)
        created = true
      }
      const target = new URL(freshTarget ?? source); target.pathname = `/${destination}`
      if (freshTarget) {
        // Acceptance-only authenticated inventory. Key stays outside both generations and receiver.
        const key = split ? await readFile(process.env.FORGE_COHERENT_TEST_KEY_FILE!) : randomBytes(32)
        const generation = randomUUID()
        const inventoryFiles = ['joint.dump', ...(split ? ['state.dump'] : []), path.basename(proofFile), 'report.bytes'].sort()
        const digest = (content: Buffer) => createHash('sha256').update(content).digest('hex')
        const components = { core: { database: source.pathname, oid: (await admin.query('SELECT oid FROM pg_database WHERE datname=current_database()')).rows[0].oid },
          coordinator: { database: stateUrl.pathname, oid: (await stateAdmin.query('SELECT oid FROM pg_database WHERE datname=current_database()')).rows[0].oid },
          systemIdentifier: (await admin.query('SELECT system_identifier FROM pg_control_system()')).rows[0].system_identifier, receiver: proof }
        if (split) assert.notEqual(components.core.oid, components.coordinator.oid)
        const selectedReport = { projectId: project.id, taskId: job.taskId, jobId: job.id, executionId: execution.id, receipt: saved.effect_receipt }
        if (split) {
          const identityFile = path.join(backupRoot, 'identity.json')
          assert.equal(digest(bytes!), selectedReport.receipt.sha256)
          await writeFile(identityFile, JSON.stringify({ components, reports: reportNames, retained, proof, selectedReport }), { flag: 'wx' })
          coherent = await createCoherentGeneration({ root: path.join(backupRoot, 'sealed'), key: { keyId: 'isolated-fixture', key },
            maintenance: { async assertHeld() { assert.equal(maintenanceHeld, true); assert.equal(modelServer.listening, false) } },
            async capture() {
              await captureCoherentPostgresArchive({ connectionString: adminUrl!, postgresBin: bin, destination: dump })
              await captureCoherentPostgresArchive({ connectionString: stateAdminUrl, postgresBin: bin, destination: stateDump })
              const original = await readFile(dump)
              await assert.rejects(captureCoherentPostgresArchive({ connectionString: adminUrl!, postgresBin: bin, destination: dump }), (error: unknown) => (error as NodeJS.ErrnoException).code === 'EEXIST')
              assert.deepEqual(await readFile(dump), original)
              return { cutoff, files: { core: dump, coordinator: stateDump, report: path.join(backupRoot, 'report.bytes'), identity: identityFile } }
            } })
          maintenanceHeld = false
          for (const lock of locks) { await lock.query('ROLLBACK'); await lock.end() }
          locks.length = 0
        }
        const entries = await Promise.all(inventoryFiles.map(async name => ({ name, sha256: digest(await readFile(path.join(backupRoot, name))) })))
        const manifest = JSON.stringify({ generation, cutoff, components, reports: reportNames, files: entries })
        const authenticate = (content: string, secret: Buffer) => createHmac('sha256', secret).update(content).digest('hex')
        const signature = authenticate(manifest, key)
        if (!split) {
          await writeFile(path.join(backupRoot, 'manifest.json'), manifest, { flag: 'wx' })
          await writeFile(path.join(backupRoot, 'manifest.hmac'), signature, { flag: 'wx' })
        }
        captureMs = Date.now() - captureStarted
        // A second actual capture contains a known later Core write; it is not a byte mutation.
        const marker = await core.createTask({ projectId: project.id, taskKey: 'post-cutoff', title: 'Post-cutoff marker', assignedAgentId: agent.id, status: 'ready', idempotencyKey: 'post-cutoff' })
        postCutoffTask = marker.id
        if (split) {
          // Sequential cadence guarantees a committed matched pair before the next tick.
          for (let i = 0; i < 12; i++) {
            await delay(75)
            const late = await core.createTask({ projectId: project.id, taskKey: `lost-${i}`, title: 'Synthetic post-cut write',
              assignedAgentId: agent.id, status: 'ready', idempotencyKey: `lost-${i}` })
            const queued = await store.enqueue({ projectId: project.id, taskId: late.id, taskKey: late.taskKey, agentId: agent.id })
            assert.equal(queued.taskId, late.id)
            lostIds.push(late.id)
          }
        }
        const second = path.join(backupRoot, 'generation-two.dump')
        await invoke('pg_dump', ['--format=custom', '--file', second, '--dbname', source.pathname.slice(1)])
        assert.notEqual(digest(await readFile(second)), entries.find(entry => entry.name === 'joint.dump')!.sha256)
        const digestSecond = digest(await readFile(second))
        const secondState = path.join(backupRoot, 'generation-two-state.dump')
        if (split) await invokeState(secondState)
        const digestSecondState = split ? digest(await readFile(secondState)) : ''
        const secondCutoff = (await admin.query('SELECT clock_timestamp()::text AS cutoff')).rows[0].cutoff
        const secondManifest = JSON.stringify({ generation: randomUUID(), cutoff: secondCutoff, components, reports: reportNames,
          files: entries.map(entry => entry.name === 'joint.dump' ? { ...entry, sha256: digestSecond } : split && entry.name === 'state.dump' ? { ...entry, sha256: digestSecondState } : entry) })
        assert.notEqual(JSON.parse(secondManifest).generation, generation)
        if (!split) {
          await writeFile(path.join(backupRoot, 'generation-two.json'), secondManifest, { flag: 'wx' })
          await writeFile(path.join(backupRoot, 'generation-two.hmac'), authenticate(secondManifest, key), { flag: 'wx' })
        }
        const validate = async (body: string, mac: string, secret: Buffer, substitution?: string, missing = false): Promise<{ report: Buffer; verified: Map<string, Buffer> }> => {
          if (split) {
            assert.ok(coherent)
            // Key custody is separate from bundles; restore re-reads it rather than relying on capture memory.
            const reread = await readFile(process.env.FORGE_COHERENT_TEST_KEY_FILE!)
            if (!secret.equals(key)) reread.fill(0)
            const candidate = await mkdtemp(path.join(backupRoot, 'candidate-'))
            const { cp } = await import('node:fs/promises')
            try {
              await cp(coherent.directory, candidate, { recursive: true })
              if (substitution) {
                // Seal an actual later generation, then mix its encrypted coordinator archive.
                const secondBundle = await createCoherentGeneration({ root: path.join(backupRoot, 'later'), key: { keyId: 'isolated-fixture', key },
                  maintenance: { async assertHeld() { assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null)); assert.equal(modelServer.listening, false) } },
                  async capture() { return { cutoff: secondCutoff, files: { core: second, coordinator: secondState, report: path.join(backupRoot, 'report.bytes'), identity: path.join(backupRoot, 'identity.json') } } } })
                await cp(path.join(secondBundle.directory, 'coordinator.enc'), path.join(candidate, 'coordinator.enc'))
              }
              if (missing) await rm(path.join(candidate, 'report.enc'))
              if (body !== manifest && body !== secondManifest) {
                const payload = await readFile(path.join(candidate, 'report.enc')); payload[0] = payload[0]! ^ 1
                await writeFile(path.join(candidate, 'report.enc'), payload)
              }
              return await withVerifiedCoherentGeneration({ directory: candidate, generation: body === secondManifest ? randomUUID() : coherent.generation, key: { keyId: 'isolated-fixture', key: reread } }, async (files: { core: string; coordinator: string; report: string; identity: string }) => {
                const identityBytes = JSON.parse(await readFile(files.identity, 'utf8'))
                assert.deepEqual(identityBytes, { components, reports: reportNames, retained, proof, selectedReport })
                const verified = new Map<string, Buffer>([['joint.dump', await readFile(files.core)], ['state.dump', await readFile(files.coordinator)], [path.basename(proofFile), Buffer.from(JSON.stringify(identityBytes.proof))]])
                const report = await readFile(files.report)
                assert.deepEqual(report, bytes)
                assert.equal(digest(report), identityBytes.selectedReport.receipt.sha256)
                return { report, verified }
              })
            } finally { reread.fill(0); await rm(candidate, { recursive: true, force: true }) }
          }
          assert.equal(authenticate(body, secret), mac, 'Manifest authentication required')
          const parsed = JSON.parse(body) as { components: typeof components; generation: string; cutoff: string; reports: string[]; files: typeof entries }
          assert.deepEqual(parsed.components, components)
          assert.equal(parsed.generation, generation)
          assert.equal(parsed.cutoff, cutoff)
          assert.deepEqual(parsed.reports, reportNames)
          assert.deepEqual(parsed.files.map(entry => entry.name).sort(), inventoryFiles)
          const verified = new Map<string, Buffer>()
          let report: Buffer | undefined
          for (const entry of parsed.files) {
            const filename: string = entry.name === (split ? 'state.dump' : 'joint.dump') && substitution ? substitution : path.join(backupRoot, entry.name)
            const component: Buffer = await readFile(missing && entry.name === 'report.bytes' ? path.join(backupRoot, 'absent') : filename)
            assert.equal(digest(component), entry.sha256)
            verified.set(entry.name, component)
            if (entry.name === 'report.bytes') report = component
          }
          assert.ok(report, 'Authenticated report component required')
          return { report, verified }
        }
        if (split) {
          outageMono = performance.now()
          outage = new Date().toISOString()
          // Declared simulated outage: no source writes after this point. No destination exists yet.
          restoreStarted = Date.now()
          const phase = performance.now()
          // PostgreSQL descendants can retain execFile's output pipes after the
          // provisioner exits. Wait on its actual exit without inheritable pipes.
          const provisioner = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', process.env.FORGE_COORDINATOR_TEST_PROVISION!], {
            env: { ...workerEnv, FORGE_COORDINATOR_TEST_FRESH_TARGET: freshTarget!, FORGE_COORDINATOR_TEST_PG_BIN: bin },
            timeout: 60_000, windowsHide: true, stdio: 'ignore',
          })
          await new Promise<void>((resolve, reject) => {
            provisioner.once('error', reject)
            provisioner.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Fixture provisioning failed: ${code ?? signal}`)))
          })
          await targetCluster.connect()
          await assertFixture(targetCluster, freshTarget!, path.join(fixtureRoot, 'target-data'))
          assert.notEqual((await targetCluster.query('SELECT system_identifier FROM pg_control_system()')).rows[0].system_identifier,
            (await admin.query('SELECT system_identifier FROM pg_control_system()')).rows[0].system_identifier)
          for (const name of [destination, destinationState]) {
            assert.match(name, /^forge_restore_[a-f0-9]{32}(?:_state)?$/)
            await targetCluster.query(`CREATE DATABASE ${name} TEMPLATE template0`)
          }
          created = true
          provisionMs = performance.now() - phase
        }
        const authStarted = performance.now()
        const emptyTarget = new pg.Client({ connectionString: target.toString() }); await emptyTarget.connect()
        try {
          for (const negative of [
            () => validate(manifest, signature, key, split ? secondState : second),
            () => validate(manifest, signature, key, undefined, true),
            () => validate(manifest + ' ', signature, key),
            () => validate(manifest, signature, randomBytes(32)),
            () => validate(secondManifest, authenticate(secondManifest, key), key),
          ]) {
            await assert.rejects(negative())
            assert.equal((await emptyTarget.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname IN ('forge','forge_coordinator')")).rows[0].n, 0)
            assert.deepEqual(await readdir(reportsRoot), reportNames)
            assert.deepEqual((await state.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0], saved)
            assert.equal(calls.get(job.taskKey), 1)
          }
          if (split) {
            const emptyStateUrl = new URL(target); emptyStateUrl.pathname = `/${destinationState}`
            const emptyState = new pg.Client({ connectionString: emptyStateUrl.toString() }); await emptyState.connect()
            try { assert.equal((await emptyState.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname IN ('forge','forge_coordinator')")).rows[0].n, 0) }
            finally { await emptyState.end() }
          }
          const authenticated = split ? await validate(manifest, signature, key) : await validate(await readFile(path.join(backupRoot, 'manifest.json'), 'utf8'), await readFile(path.join(backupRoot, 'manifest.hmac'), 'utf8'), key)
          authenticatedReport = authenticated.report
          if (split) {
            // Restore exclusive materializations of the exact authenticated bytes, not reread originals.
            await writeFile(proofFile, authenticated.verified.get(path.basename(proofFile))!)
            for (const name of ['joint.dump', 'state.dump']) await writeFile(path.join(backupRoot, `verified-${name}`), authenticated.verified.get(name)!, { flag: 'wx' })
          }
        } finally { await emptyTarget.end() }
        authenticationMs = performance.now() - authStarted
        key.fill(0)
        if (!split) restoreStarted = Date.now()
        // Fresh catalog, same two fixture roles. Restore existing ACLs/ownership, then
        // run the unchanged Core provisioning and exact privilege acceptance.
        await targetCluster.query('CREATE ROLE forge_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
        await targetCluster.query(`CREATE ROLE ${role} LOGIN PASSWORD '${randomUUID()}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
      }
      const databaseRestoreStarted = performance.now()
      await invokeTarget('pg_restore', ['--exit-on-error', ...(freshTarget ? ['--single-transaction'] : []), '--dbname', destination, split ? path.join(backupRoot, 'verified-joint.dump') : dump])
      if (split) await invokeTarget('pg_restore', ['--exit-on-error', '--single-transaction', '--dbname', destinationState, path.join(backupRoot, 'verified-state.dump')])
      databaseRestoreMs = performance.now() - databaseRestoreStarted
      restoredAdmin = new pg.Client({ connectionString: target.toString() }); await restoredAdmin.connect()
      const sourceId = (await admin.query('SELECT oid FROM pg_database WHERE datname=current_database()')).rows[0].oid
      const targetId = (await restoredAdmin.query('SELECT oid FROM pg_database WHERE datname=current_database()')).rows[0].oid
      if (!freshTarget) assert.notEqual(sourceId, targetId)
      assert.notEqual(target.pathname, source.pathname)
      const restoredStateUrl = new URL(stateUrl); restoredStateUrl.host = target.host; restoredStateUrl.pathname = `/${destinationState}`
      const restoredCoreUrl = new URL(coreUrl!); restoredCoreUrl.host = target.host; restoredCoreUrl.pathname = target.pathname
      const restoredStateAdminUrl = new URL(target); restoredStateAdminUrl.pathname = `/${destinationState}`
      restoredStateAdmin = split ? new pg.Client({ connectionString: restoredStateAdminUrl.toString() }) : restoredAdmin
      if (split) {
        await restoredStateAdmin.connect()
        assert.notEqual((await restoredStateAdmin.query('SELECT oid FROM pg_database WHERE datname=current_database()')).rows[0].oid, targetId)
        assert.equal((await restoredAdmin.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname='forge_coordinator'")).rows[0].n, 0)
        assert.equal((await restoredStateAdmin.query("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname='forge'")).rows[0].n, 0)
        assert.deepEqual(await inventoryRows(restoredAdmin, restoredStateAdmin), retained)
        for (const db of [admin, restoredAdmin]) {
          const actual = (await db.query('SELECT id FROM forge.tasks WHERE id=ANY($1::uuid[])', [lostIds])).rows.map(row => row.id).sort()
          assert.deepEqual(actual, db === admin ? [...lostIds].sort() : [])
        }
        for (const db of [stateAdmin, restoredStateAdmin]) {
          const actual = (await db.query('SELECT task_id FROM forge_coordinator.jobs WHERE task_id=ANY($1::uuid[])', [lostIds])).rows.map(row => row.task_id).sort()
          assert.deepEqual(actual, db === stateAdmin ? [...lostIds].sort() : [])
        }
      }
      const rolesStarted = performance.now()
      if (freshTarget) {
        const secret = randomUUID()
        restoredStateUrl.password = randomUUID()
        restoredCoreUrl.password = secret
        await restoredAdmin.query(`ALTER ROLE ${role} PASSWORD '${restoredStateUrl.password}'`)
        await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../../schema/scripts/configure-runtime-role.mjs', import.meta.url))], {
          env: { ...workerEnv, FORGE_ADMIN_DATABASE_URL: target.toString(), FORGE_RUNTIME_PASSWORD: secret }, timeout: 15_000,
        })
        for (const oldUrl of [new URL(coreUrl!), new URL(stateUrl)]) {
          oldUrl.host = target.host; oldUrl.pathname = oldUrl.username === 'forge_runtime' ? target.pathname : `/${destinationState}`
          const rejected = new pg.Client({ connectionString: oldUrl.toString() })
          try { await assert.rejects(rejected.connect(), { code: '28P01' }) }
          finally { await rejected.end() }
        }
        const privilege = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../../schema/tests/runtime-role.test.mjs', import.meta.url))], {
          env: { ...workerEnv, FORGE_DATABASE_URL: restoredCoreUrl.toString() }, timeout: 20_000,
        })
        assert.match(privilege.stdout, /# pass 1/)
        assert.match(privilege.stdout, /# fail 0/)
        assert.equal((await restoredAdmin.query('SELECT count(*)::int AS n FROM forge.tasks WHERE id=$1', [postCutoffTask])).rows[0].n, 0)
        assert.equal((await admin.query('SELECT count(*)::int AS n FROM forge.tasks WHERE id=$1', [postCutoffTask])).rows[0].n, 1)
      }
      const rolesMs = performance.now() - rolesStarted
      const reconcileStarted = performance.now()
      assert.equal(restoredCoreUrl.username, 'forge_runtime')
      restoredStore = new PostgresJobStore(restoredStateUrl.toString(), 3_000)
      restoredCore = ForgePersistenceGateway.connect({ connectionString: restoredCoreUrl.toString(), maxConnections: 2 })
      assert.deepEqual((await restoredStateAdmin.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0], saved)
      const never = async (): Promise<never> => { throw new Error('Restored handler must never run') }
      let handlerCalls = 0
      const handler = async () => { handlerCalls++; return never() }
      const modelCalls = calls.get(job.taskKey)
      await mkdir(relocated)
      await writeFile(path.join(relocated, saved.effect_receipt.filename), bytes)
      const wrong = new ImmutableReportPublisher(relocated)
      assert.notEqual(wrong.targetId, publisher.targetId)
      assert.equal(await new Coordinator(restoredStore, restoredCore, { publisher: wrong }).runOnce(identity(job, 'relocated'), handler), 'idle')
      assert.deepEqual((await restoredStateAdmin.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0], saved)
      // Retain the emptied old inode until a fresh replacement exists, preventing reuse.
      const movedOriginal = reportsRoot + '-lost'
      for (const name of reportNames) await rm(path.join(reportsRoot, name))
      await rename(reportsRoot, movedOriginal)
      await mkdir(reportsRoot)
      assert.notEqual((await stat(reportsRoot)).ino, directory.ino)
      assert.equal(await realpath(reportsRoot), proof.canonicalPath)
      await rm(movedOriginal, { recursive: true })
      await assert.rejects(stat(movedOriginal), { code: 'ENOENT' })
      assert.deepEqual(await readdir(reportsRoot), [])
      const replacement = new ImmutableReportPublisher(reportsRoot)
      assert.notEqual(replacement.targetId, publisher.targetId)
      assert.equal(await new Coordinator(restoredStore, restoredCore, { publisher: replacement }).runOnce(identity(job, 'replacement-normal'), handler), 'idle')
      const env = { ...workerEnv, FORGE_DATABASE_URL: restoredCoreUrl.toString(), FORGE_COORDINATOR_DATABASE_URL: restoredStateUrl.toString(),
        FORGE_COORDINATOR_AGENT_MODE: 'local-report', FORGE_COORDINATOR_REPORT_ROOT: reportsRoot }
      const recover = (file = proofFile) => promisify(execFile)(process.execPath,
        [cli, 'recover-report', project.projectKey, job.taskKey, file], { env, timeout: 15_000 })
      const invalidProof = path.join(backupRoot, 'invalid proof.json')
      const rejectProof = async (metadata: unknown) => {
        await writeFile(invalidProof, JSON.stringify(metadata), 'utf8')
        await assert.rejects(recover(invalidProof))
      }
      const unchanged = async () => {
        assert.equal((await restoredCore!.getExecutionByKey(project.id, `coordinator:v1:${project.id}:${job.taskId}`)).status, 'running')
        assert.equal((await restoredCore!.listMemories({ projectId: project.id, taskId: job.taskId })).items.length, 0)
        assert.equal((await restoredCore!.listContinuationPackages({ projectId: project.id, executionId: execution.id })).items.length, 0)
        const row = (await restoredStateAdmin!.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0]
        assert.deepEqual(row, saved, 'Rejected recovery preserves the entire row, attempts and epoch')
        assert.equal(calls.get(job.taskKey), modelCalls)
      }
      assert.equal(saved.max_attempts, 3)
      assert.equal(saved.attempts, 1)
      const status = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'status', project.projectKey, job.taskKey], { env })).stdout).job
      assert.equal('artifact' in status, false)
      assert.equal('effect_receipt' in status, false)
      await rejectProof({ ...proof, ino: (BigInt(proof.ino) + 1n).toString() })
      await unchanged()
      await rejectProof({ ...proof, canonicalPath: relocated })
      await unchanged()
      await writeFile(invalidProof, '{broken', 'utf8')
      await assert.rejects(recover(invalidProof))
      await unchanged()
      for (const column of ['artifact', 'effect_receipt']) {
        await restoredStateAdmin.query(`UPDATE forge_coordinator.jobs SET ${column}=NULL WHERE id=$1`, [job.id])
        const before: Record<string, unknown> = (await restoredStateAdmin.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0]
        await assert.rejects(recover(), (error: unknown) => {
          assert.match((error as { stderr: string }).stderr, /RECOVERY_REQUIRES_PREPARED_OUTPUT_AND_RECEIPT/)
          return true
        })
        assert.deepEqual((await restoredStateAdmin.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0], before)
        await restoredStateAdmin.query(`UPDATE forge_coordinator.jobs SET ${column}=$2::jsonb WHERE id=$1`, [job.id, JSON.stringify(saved[column])])
      }
      await unchanged()
      await assert.rejects(recover()) // Missing confirmed report must not be created.
      await assert.rejects(readFile(file), { code: 'ENOENT' })
      await unchanged()
      await writeFile(file, Buffer.alloc(bytes.length, 120), { flag: 'wx' })
      await assert.rejects(recover())
      assert.deepEqual(await readFile(file), Buffer.alloc(bytes.length, 120))
      await unchanged()
      await rm(file)
      if (freshTarget) {
        assert.ok(authenticatedReport)
        await writeFile(file, authenticatedReport, { flag: 'wx' })
      }
      for (const [name, content] of inventory) await writeFile(path.join(reportsRoot, name), content, { flag: 'wx' })
      const restoredFile = await stat(file)
      const concurrent = await Promise.all([recover(), recover()])
      assert.deepEqual(concurrent.map(result => JSON.parse(result.stdout).state).sort(), ['completed', 'idle'])
      assert.equal(JSON.parse((await recover()).stdout).state, 'idle')
      const completedRow = (await restoredStateAdmin.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0]
      assert.equal(completedRow.attempts, 2)
      assert.equal(Number(completedRow.epoch), Number(saved.epoch) + 1)
      assert.deepEqual(completedRow.effect_receipt, saved.effect_receipt)
      assert.equal(handlerCalls, 0); assert.equal(calls.get(job.taskKey), modelCalls)
      const executions = (await restoredCore.listExecutions({ projectId: project.id, taskId: job.taskId })).items
      assert.equal(executions.length, 1); assert.equal(executions[0]!.id, execution.id)
      assert.equal(executions[0]!.taskId, job.taskId); assert.equal(executions[0]!.status, 'succeeded')
      assert.equal((await restoredCore.listMemories({ projectId: project.id, taskId: job.taskId })).items.length, 1)
      assert.equal((await restoredCore.listContinuationPackages({ projectId: project.id, executionId: execution.id })).items.length, 1)
      assert.equal((await restoredCore.getTaskByKey(project.id, job.taskKey)).status, 'done')
      assert.equal((await restoredStore.inspect(project.id, job.taskId))?.state, 'completed')
      assert.deepEqual(await readFile(file), bytes)
      assert.equal((await stat(file)).ino, restoredFile.ino)
      assert.equal((await stat(file)).mtimeMs, restoredFile.mtimeMs)
      assert.deepEqual((await readdir(reportsRoot)).sort(), reportNames, 'No duplicate or temporary report remains')
      assert.deepEqual((await restoredStateAdmin.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [pending.id])).rows[0], pendingBefore)
      const audit = await restoredCore.getAuditTrail(project.id, execution.id)
      for (const action of ['execution.start', 'memory.remember', 'context.compile', 'execution.finish']) assert.equal(audit.filter((entry) => entry.action === action).length, 1)
      assert.deepEqual((await state.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0], saved)
      assert.equal((await core.listMemories({ projectId: project.id, taskId: job.taskId })).items.length, 0)
      if (split) context.diagnostic(JSON.stringify({ splitDatabaseRestore: true, cutoff, outage,
        observedRpoMs: outageMono - cutMono, observedRtoMs: performance.now() - outageMono,
        endpoints: { rpo: 'monotonic common quiescent cut -> declared simulated outage', rto: 'declared outage before initdb -> both DB probes and CLI concurrent/replay completion' },
        phases: { captureMs, provisionMs, authenticationMs, databaseRestoreMs, rolesMs, reconciliationAndProbesMs: performance.now() - reconcileStarted },
        retained: Object.fromEntries(Object.entries(retained).map(([name, rows]) => [name, (rows as unknown[]).length])),
        retainedJobStates: (await restoredStateAdmin!.query('SELECT state,count(*)::int AS n FROM forge_coordinator.jobs GROUP BY state ORDER BY state')).rows,
        losses: { coreTasks: lostIds.length + 1, coordinatorJobs: lostIds.length, matchedPairs: lostIds.length }, cadenceMs: 75,
        receiverDrained: true, independentArchives: 2, authenticatedBeforeEitherRestore: true, restoreSource: 'exclusive authenticated byte materializations',
        syntheticEffectForRecoveredTask: 1, providerReplay: 0, handlerReplay: 0 }))
      if (freshTarget) context.diagnostic(JSON.stringify({ freshClusterRestore: !split, captureMs, restoreToReconciledMs: Date.now() - restoreStarted, cutoff,
        authenticatedGeneration: true, rejectionCases: 5, reportRestoreSource: 'authenticated-report.bytes', targetRuntimeRoleContract: '1/1', targetAuthentication: 'SCRAM', oldPasswordsRejected: 2, oldPasswordSqlstate: '28P01', sourceIntact: true, postCutoffExcluded: true, handlerReplay: 0, providerReplay: 0 }))
      context.diagnostic(`Joint restore: ${freshTarget ? 'distinct cluster system identifiers and ports' : 'distinct database OIDs'}; full receiver loss; distinct inode; real CLI recovery; concurrent/replay and negative checks; handler/model replay=0`)
    } finally {
      maintenanceHeld = false
      for (const lock of locks) { await lock.query('ROLLBACK'); await lock.end() }
      await restoredStore?.close(); await restoredCore?.close(); if (split) await restoredStateAdmin?.end(); await restoredAdmin?.end()
      if (!freshTarget && file && bytes) await writeFile(file, bytes, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
      if (created) {
        if (split) await targetCluster.query(`DROP DATABASE ${destinationState}`)
        await targetCluster.query(`DROP DATABASE ${destination}`)
      }
      await targetCluster.end()
      await rm(backupRoot, { recursive: true, force: true })
      await rm(reportsRoot, { recursive: true, force: true })
      await rm(reportsRoot + '-lost', { recursive: true, force: true })
    }
  })})
