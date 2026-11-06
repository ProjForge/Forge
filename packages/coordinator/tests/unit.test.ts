import assert from 'node:assert/strict'
import test from 'node:test'
import { validateArtifact, Coordinator, LeaseLostError, PostgresJobStore } from '../src/index.js'
import type { CorePort, JobStore, Claim, Change, Job } from '../src/index.js'

test('bounds agent output before it can become a persistent retry payload', () => {
  assert.deepEqual(validateArtifact({ title: 'Result', content: 'Evidence' }), { title: 'Result', content: 'Evidence' })
  assert.throws(() => validateArtifact({ title: '', content: 'body' }))
  assert.throws(() => validateArtifact({ title: 'x', content: 'x'.repeat(32_001) }))
  assert.throws(() => validateArtifact({ title: 'x', content: '' }))
})

test('rejects unsafe lease intervals without opening a connection', () => {
  for (const value of [0, -1, 299, 300_001, NaN, Infinity, 1000.1]) assert.throws(() => new PostgresJobStore('unused', value))
})

const job: Job = { id: 'job', projectId: 'project', taskId: 'task', taskKey: 'key', agentId: 'agent', state: 'running',
  epoch: 1, owner: 'worker', attempts: 1, maxAttempts: 3, artifact: null }
const claim: Claim = { job, epoch: 1, workerId: 'worker' }

test('losing the fence prevents all Core operations and handler work', async () => {
  let failed = false
  const store: JobStore = {
    leaseMs: 300, claim: async () => claim, heartbeat: async () => false,
    fenced: async () => { throw new LeaseLostError() }, fail: async () => { failed = true },
  }
  const core = { assertReady: async () => ({}) } as unknown as CorePort
  const result = await new Coordinator(store, core).runOnce({ projectId: 'project', agentId: 'agent', workerId: 'worker' }, async () => { throw new Error('Handler must not run') })
  assert.equal(result, 'lost')
  assert.equal(failed, false)
})

test('completed execution reconciliation never invokes the handler or writes again', async () => {
  let complete = false
  const store: JobStore = {
    leaseMs: 300, claim: async () => claim, heartbeat: async () => true, fail: async () => { throw new Error('Unexpected retry') },
    fenced: async <T>(_claim: Claim, operation: (current: Job) => Promise<Change<T>>) => {
      const change = await operation(job); complete = change.completed === true; return change.value
    },
  }
  const core = {
    assertReady: async () => ({}),
    getTaskByKey: async () => ({ id: 'task', assignedAgentId: 'agent', status: 'done' }),
    getExecutionByKey: async () => ({ taskId: 'task', agentId: 'agent', status: 'succeeded', metadata: { coordinatorJobId: 'job' } }),
  } as unknown as CorePort
  const result = await new Coordinator(store, core).runOnce({ projectId: 'project', agentId: 'agent', workerId: 'worker' }, async () => { throw new Error('Handler must not run') })
  assert.equal(result, 'completed')
  assert.equal(complete, true)
})

test('heartbeat failure and handler deadlines release even an uncooperative async handler', async () => {
  for (const loseLease of [true, false]) {
    let failed = false
    let guarded = 0
    const store: JobStore = {
      leaseMs: 300, claim: async () => claim, heartbeat: async () => !loseLease,
      fail: async () => { failed = true },
      fenced: async <T>(_claim: Claim, operation: (current: Job) => Promise<Change<T>>) => { guarded++; return (await operation(job)).value },
    }
    const core = {
      assertReady: async () => ({}),
      getTaskByKey: async () => ({ id: 'task', assignedAgentId: 'agent', status: 'in_progress' }),
      getExecutionByKey: async () => ({ taskId: 'task', agentId: 'agent', status: 'running', metadata: { coordinatorJobId: 'job' } }),
    } as unknown as CorePort
    const result = await new Coordinator(store, core, { handlerTimeoutMs: loseLease ? 500 : 100 })
      .runOnce({ projectId: 'project', agentId: 'agent', workerId: 'worker' }, async () => new Promise(() => {}))
    assert.equal(result, loseLease ? 'lost' : 'failed')
    assert.equal(failed, !loseLease)
    assert.equal(guarded, 1, 'Cancelled output must never enter publication')
  }
})
