import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile, fork, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import pg from 'pg'
import { ForgePersistenceGateway } from 'forge-persistence-gateway'
import { Coordinator, PostgresJobStore } from '../src/index.js'
import type { Job, JobStore, WorkerIdentity } from '../src/index.js'

const adminUrl = process.env.FORGE_COORDINATOR_TEST_ADMIN_URL
const coreUrl = process.env.FORGE_DATABASE_URL

async function until(condition: () => Promise<boolean>, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error('Condition deadline exceeded')
    await delay(30)
  }
}

test('coordinates trusted agents across processes, death, lease loss and uncertain Core replies', {
  skip: !adminUrl || !coreUrl, timeout: 90_000,
}, async (context) => {
  assert.equal(process.env.FORGE_COORDINATOR_TEST_ALLOW_SETUP, '1', 'Use only an explicitly disposable test database')
  const admin = new pg.Client({ connectionString: adminUrl! })
  await admin.connect()
  const exists = await admin.query("SELECT 1 FROM pg_namespace WHERE nspname='forge_coordinator'")
  assert.equal(exists.rowCount, 0, 'Refusing to replace an existing coordinator schema')
  const role = `coord_test_${randomUUID().replaceAll('-', '')}`
  const password = randomUUID()
  await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
  await admin.query(`CREATE SCHEMA forge_coordinator AUTHORIZATION ${role}`)
  const stateUrl = new URL(adminUrl!)
  stateUrl.username = role; stateUrl.password = password
  const state = new pg.Client({ connectionString: stateUrl.toString() })
  await state.connect()
  await state.query(await readFile(new URL('../../sql/setup.sql', import.meta.url), 'utf8'))
  const store = new PostgresJobStore(stateUrl.toString(), 3_000)
  const core = ForgePersistenceGateway.connect({ connectionString: coreUrl!, maxConnections: 2 })
  const children: ChildProcess[] = []
  context.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all([store.close(), core.close(), state.end()])
    await admin.query('DROP SCHEMA forge_coordinator CASCADE')
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

  async function enqueue(label: string, agentId = agents[0]!.id, maxAttempts = 3): Promise<Job> {
    const task = await core.createTask({ projectId: project.id, taskKey: label, title: label, assignedAgentId: agentId, status: 'ready', idempotencyKey: label })
    return store.enqueue({ projectId: project.id, taskId: task.id, taskKey: task.taskKey, agentId }, maxAttempts)
  }
  const identity = (job: Job, workerId: string): WorkerIdentity => ({ projectId: job.projectId, agentId: job.agentId, workerId })
  async function expired(job: Job): Promise<void> {
    await until(async () => (await state.query('SELECT lease_until<=clock_timestamp() AS expired FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0].expired === true)
  }
  function spawn(agentId: string, workerId: string, mode = 'normal') {
    const child = fork(fileURLToPath(new URL('./worker.js', import.meta.url)), [project.id, agentId, workerId, mode], {
      env: { ...process.env, FORGE_COORDINATOR_DATABASE_URL: stateUrl.toString() }, silent: true,
    })
    children.push(child)
    child.stdout?.resume(); child.stderr?.resume()
    const messages: Array<{ phase: string; completed?: number }> = []
    child.on('message', (message) => messages.push(message as { phase: string; completed?: number }))
    const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve(code)) })
    return { child, done, messages, wait: (phase: string) => until(async () => messages.some((message) => message.phase === phase)) }
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
    assert.equal(workers.flatMap((worker) => worker.messages).reduce((sum, message) => sum + (message.completed ?? 0), 0), 12)
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
    await assert.rejects(state.query('SELECT * FROM forge.tasks'), (error: unknown) => (error as { code: string }).code === '42501')
    const runtime = new pg.Client({ connectionString: coreUrl! })
    await runtime.connect()
    try { await assert.rejects(runtime.query('SELECT * FROM forge_coordinator.jobs'), (error: unknown) => (error as { code: string }).code === '42501') }
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
    const env = { ...process.env, FORGE_COORDINATOR_DATABASE_URL: stateUrl.toString(), FORGE_COORDINATOR_PROJECT_KEY: project.projectKey, FORGE_COORDINATOR_AGENT_KEY: agents[1]!.agentKey }
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
    assert.equal(await new Coordinator(store, core).runOnce(identity(job, 'late-retry'), async () => { throw new Error('Must not run') }), 'idle')
    const failed = (await state.query('SELECT state,attempts,error_code FROM forge_coordinator.jobs WHERE id=$1', [job.id])).rows[0]
    assert.deepEqual(failed, { state: 'failed', attempts: 1, error_code: 'ATTEMPTS_EXHAUSTED' })
    assert.equal((await core.listExecutions({ projectId: job.projectId, taskId: job.taskId })).items.length, 1)
  })
})
