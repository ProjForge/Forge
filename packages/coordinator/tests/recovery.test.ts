import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { NotFoundError } from 'forge-persistence-gateway'
import { PostgresJobStore } from '../src/store.js'
import { Coordinator } from '../src/coordinator.js'
import { ImmutableReportPublisher, RestoredReportVerifier, captureReportTarget } from '../src/report-publisher.js'
import type { Change, Claim, CorePort, FailureCode, Job, JobStore } from '../src/types.js'

const artifact = { title: 'Saved review', content: 'The original confirmed output.' }
const worker = { projectId: 'project', agentId: 'agent', workerId: 'worker' }

async function fixture(context: TestContext, options: { admissionRequired?: boolean; staleClaimArtifact?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-recovery-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const publisher = new ImmutableReportPublisher(root)
  const receipt = await publisher.publish({ key: 'coordinator:v1:project:task:report', artifact, signal: new AbortController().signal })
  const job: Job = { id: 'job', projectId: 'project', taskId: 'task', taskKey: 'key', agentId: 'agent',
    state: 'running', owner: 'worker', epoch: 1, attempts: 1, maxAttempts: 1, artifact: null,
    effectKind: publisher.kind, effectTarget: publisher.targetId, effectReceipt: receipt }
  const claim: Claim = { job: { ...job }, workerId: 'worker', epoch: 1 }
  let failure: FailureCode | undefined
  const store: JobStore = {
    leaseMs: 300, claim: async () => ({ ...claim, job: { ...job, ...(options.staleClaimArtifact ? { artifact } : {}) } }), heartbeat: async () => true,
    fenced: async <T>(_claim: Claim, operation: (current: Job) => Promise<Change<T>>) => {
      const change = await operation({ ...job })
      if (change.artifact) job.artifact = change.artifact
      if (change.effectReceipt) job.effectReceipt = change.effectReceipt
      if (change.completed) job.state = 'completed'
      return change.value
    },
    fail: async (_claim, code) => { failure = code; job.state = 'failed' },
  }
  const writes: string[] = []
  const calls = { assertReady: 0, readTask: 0, readExecution: 0, listExecutions: 0,
    updateTaskStatus: 0, startExecution: 0, remember: 0, compileContinuationContext: 0, finishExecution: 0 }
  const task = { id: 'task', assignedAgentId: 'agent', status: options.admissionRequired ? 'ready' : 'in_progress', version: 1 }
  const execution = { id: 'execution', taskId: 'task', agentId: 'agent', status: 'running', version: 1, metadata: { coordinatorJobId: 'job' } }
  let executionPresent = !options.admissionRequired
  const core = {
    assertReady: async () => { calls.assertReady++; return {} },
    getTaskByKey: async () => { calls.readTask++; return { ...task } },
    getExecutionByKey: async () => {
      calls.readExecution++
      if (!executionPresent) throw new NotFoundError('Execution', 'execution')
      return execution
    },
    listExecutions: async () => { calls.listExecutions++; return { items: [] } },
    startExecution: async () => { calls.startExecution++; executionPresent = true; return execution },
    remember: async () => { calls.remember++; writes.push('remember') },
    updateTaskStatus: async (input: { status: string }) => {
      calls.updateTaskStatus++; writes.push('task'); task.status = input.status; task.version++
      return { ...task }
    },
    compileContinuationContext: async () => { calls.compileContinuationContext++; writes.push('context'); return { packageId: 'context' } },
    finishExecution: async () => { calls.finishExecution++; writes.push('finish') },
  } as unknown as CorePort
  return { root, publisher, receipt, job, store, core, writes, calls, failure: () => failure }
}

for (const reportPresent of [true, false]) {
  for (const sameOutput of [true, false]) {
    test(`a prior receipt without prepared output blocks regeneration (report=${reportPresent}, same output=${sameOutput})`, async (context) => {
      const state = await fixture(context)
      const file = path.join(state.root, state.receipt.filename)
      const original = await readFile(file)
      if (!reportPresent) await unlink(file)
      let calls = 0
      const result = await new Coordinator(state.store, state.core, { publisher: state.publisher }).runOnce(worker, async () => {
        calls++
        return sameOutput ? artifact : { ...artifact, content: 'A newly generated, conflicting review.' }
      })
      assert.deepEqual({ result, calls }, { result: 'failed', calls: 0 }, 'Lost prepared output must require reconciliation, even if regeneration would match')
      assert.equal(state.failure(), 'EFFECT_UNCONFIRMED')
      assert.equal(state.job.state, 'failed')
      assert.equal(state.job.artifact, null)
      assert.deepEqual(state.job.effectReceipt, state.receipt)
      assert.deepEqual(state.writes, [])
      assert.deepEqual(await readdir(state.root), reportPresent ? [state.receipt.filename] : [])
      if (reportPresent) assert.deepEqual(await readFile(file), original)
    })
  }
}

for (const confirmed of [true, false]) {
  test(`retained prepared output still reconciles an existing report (receipt=${confirmed})`, async (context) => {
    const state = await fixture(context)
    state.job.artifact = artifact
    if (!confirmed) state.job.effectReceipt = null // Report appeared before receipt commit.
    const file = path.join(state.root, state.receipt.filename)
    const original = await readFile(file)
    let calls = 0
    assert.equal(await new Coordinator(state.store, state.core, { publisher: state.publisher }).runOnce(worker, async () => {
      calls++
      throw new Error('Saved output must be reused')
    }), 'completed')
    assert.equal(calls, 0)
    assert.equal(state.failure(), undefined)
    assert.equal(state.job.state, 'completed')
    assert.deepEqual(state.job.effectReceipt, state.receipt)
    assert.deepEqual(state.writes, ['remember', 'task', 'context', 'finish'])
    assert.deepEqual(await readFile(file), original)
    assert.deepEqual(await readdir(state.root), [state.receipt.filename])
  })
}

for (const staleClaimArtifact of [false, true]) {
  test(staleClaimArtifact
    ? 'a stale claim artifact cannot bypass the current fenced row missing output'
    : 'a prior receipt blocks admission of a ready task with no execution', async (context) => {
    const state = await fixture(context, { admissionRequired: !staleClaimArtifact, staleClaimArtifact })
    const file = path.join(state.root, state.receipt.filename)
    const original = await readFile(file)
    let handlerCalls = 0
    const result = await new Coordinator(state.store, state.core, { publisher: state.publisher }).runOnce(worker, async () => {
      handlerCalls++
      return artifact
    })
    assert.equal(result, 'failed')
    assert.equal(state.failure(), 'EFFECT_UNCONFIRMED')
    assert.equal(handlerCalls, 0)
    assert.deepEqual(state.calls, { assertReady: 1, readTask: 0, readExecution: 0, listExecutions: 0,
      updateTaskStatus: 0, startExecution: 0, remember: 0, compileContinuationContext: 0, finishExecution: 0 })
    assert.deepEqual(state.writes, [])
    assert.equal(state.job.state, 'failed')
    assert.equal(state.job.artifact, null)
    assert.deepEqual(state.job.effectReceipt, state.receipt)
    assert.deepEqual(await readFile(file), original)
    assert.deepEqual(await readdir(state.root), [state.receipt.filename])
  })
}

test('explicit recovery never admits a missing original execution', async context => {
  const state = await fixture(context, { admissionRequired: true })
  state.job.artifact = artifact
  let handlerCalls = 0
  assert.equal(await new Coordinator(state.store, state.core, { publisher: state.publisher,
    recovery: { taskId: state.job.taskId, receipt: state.receipt } }).runOnce(worker, async () => {
      handlerCalls++; return artifact
    }), 'failed')
  assert.equal(handlerCalls, 0)
  assert.equal(state.calls.startExecution, 0)
  assert.equal(state.calls.listExecutions, 0)
  assert.deepEqual(state.writes, [])
  assert.deepEqual(state.job.effectReceipt, state.receipt)
})

test('replacement verifier only verifies original confirmed bytes and pins the replacement', async context => {
  const state = await fixture(context)
  const proof = captureReportTarget(state.root)
  const file = path.join(state.root, state.receipt.filename)
  const bytes = await readFile(file)
  const moved = state.root + '-old'
  context.after(() => rm(moved, { recursive: true, force: true }))
  await rename(state.root, moved)
  await mkdir(state.root)
  const verifier = new RestoredReportVerifier(state.root, proof)
  const request = { key: state.receipt.key, artifact, signal: new AbortController().signal, expected: state.receipt }
  await assert.rejects(verifier.publish(request), /EFFECT_UNCONFIRMED/)
  assert.deepEqual(await readdir(state.root), [])
  await writeFile(file, bytes)
  assert.deepEqual(await verifier.publish(request), state.receipt)
  await assert.rejects(verifier.publish({ ...request, expected: { ...state.receipt, sha256: '0'.repeat(64) } }), /EFFECT_UNCONFIRMED/)
  await assert.rejects(verifier.publish({ ...request, artifact: { ...artifact, content: 'Wrong checkpoint' } }), /EFFECT_UNCONFIRMED/)
  await unlink(file)
  await symlink(moved, file, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(verifier.publish(request), /EFFECT_CONFLICT/)
  await unlink(file)
  await rm(state.root, { recursive: true })
  await rename(moved, state.root)
  await assert.rejects(verifier.publish(request), /EFFECT_TARGET_CHANGED/)
})

test('malformed recovery selector cannot become an unrestricted claim', async () => {
  const store = new PostgresJobStore('postgresql://unused@127.0.0.1:1/unused')
  try {
    await assert.rejects(store.claim(worker, { kind: 'none', targetId: '' }, {} as never), /Invalid exact recovery selector/)
  } finally { await store.close() }
})
