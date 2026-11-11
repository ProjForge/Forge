import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
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

// Control only the synchronous directory identity; report IO remains real and exact.
test('exact large identities separate numeric collisions and reconcile without replay', async context => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-exact-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const actualLstat = fs.lstatSync
  const first = 9007199254740992n
  const second = 9007199254740993n
  assert.equal(Number(first), Number(second), 'deterministic legacy rounding collision')
  let ino = first
  context.mock.method(fs, 'lstatSync', ((...args: Parameters<typeof fs.lstatSync>) => {
    const info = actualLstat(...args)
    if (args[0] !== root || !info) return info
    const exact = typeof args[1] === 'object' && args[1]?.bigint
    return new Proxy(info, { get: (target, key) => key === 'ino' ? (exact ? ino : Number(ino))
      : key === 'dev' ? (exact ? 7n : 7) : Reflect.get(target, key) })
  }) as typeof fs.lstatSync)
  syncBuiltinESMExports()
  context.after(() => { context.mock.restoreAll(); syncBuiltinESMExports() })
  const publisher = new ImmutableReportPublisher(root)
  const proof = JSON.parse(JSON.stringify(captureReportTarget(root)))
  assert.deepEqual(proof, { version: 2, canonicalPath: fs.realpathSync(root), dev: '7', ino: first.toString() })
  const normalized = process.platform === 'win32' ? proof.canonicalPath.toLowerCase() : proof.canonicalPath
  assert.equal(publisher.targetId, createHash('sha256').update(`report-target-v2:${JSON.stringify([normalized, '7', first.toString()])}`).digest('hex'))
  const request = { key: 'exact-test', artifact, signal: new AbortController().signal }
  const receipt = await publisher.publish(request)
  const before = await fs.promises.stat(path.join(root, receipt.filename), { bigint: true })
  ino = second
  assert.notEqual(new ImmutableReportPublisher(root).targetId, publisher.targetId)
  await assert.rejects(publisher.publish({ ...request, expected: receipt }), /EFFECT_TARGET_CHANGED/)
  const verifier = new RestoredReportVerifier(root, proof)
  assert.deepEqual(await verifier.publish({ ...request, expected: receipt }), receipt)
  const after = await fs.promises.stat(path.join(root, receipt.filename), { bigint: true })
  assert.deepEqual([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs],
    [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs], 'committed effect is verified without rewriting')
  assert.deepEqual(await readdir(root), [receipt.filename])
  assert.throws(() => new RestoredReportVerifier(root, { ...proof, canonicalPath: root + '-wrong' }), /EFFECT_TARGET_CHANGED/)
  await assert.rejects(verifier.publish({ ...request, expected: { ...receipt, targetId: 'wrong' } }), /EFFECT_UNCONFIRMED/)
  const legacyUnsafeTarget = createHash('sha256').update(`${normalized}:7:${Number(first)}`).digest('hex')
  await assert.rejects(verifier.publish({ ...request, expected: { ...receipt, targetId: legacyUnsafeTarget } }), /EFFECT_UNCONFIRMED/)
  ino = second + 1n
  await assert.rejects(verifier.publish({ ...request, expected: receipt }), /EFFECT_TARGET_CHANGED/)

  ino = 42n
  const safe = new ImmutableReportPublisher(root)
  const safeReceipt = await safe.publish({ ...request, key: 'safe-test' })
  assert.equal(safe.targetId, createHash('sha256').update(`${normalized}:7:42`).digest('hex'), 'legacy safe target hash is unchanged')
  ino = 43n
  const legacy = { canonicalPath: proof.canonicalPath, dev: 7, ino: 42 }
  assert.deepEqual(await new RestoredReportVerifier(root, legacy).publish({ ...request, key: 'safe-test', expected: safeReceipt }), safeReceipt)
  assert.equal(new RestoredReportVerifier(root, { version: 2, canonicalPath: proof.canonicalPath, dev: '7', ino: '42' }).targetId, safe.targetId)
  for (const invalid of [null, {}, { ...legacy, ino: Number(first) }, { ...legacy, dev: -1 },
    { ...legacy, ino: 1.5 }, { ...legacy, ino: '42' }, { ...proof, version: 3 },
    ...['01', '-1', '1.0', '1e2', '', '18446744073709551616'].map(ino => ({ ...proof, ino })),
    { ...proof, dev: 7 }, { ...proof, ino: Number(first) }]) {
    assert.throws(() => new RestoredReportVerifier(root, invalid), /EFFECT_TARGET_CHANGED/)
  }
})

for (const entry of ['report', 'conflict', 'directory', 'link'] as const) {
  test(`surviving ${entry} with neither checkpoint blocks before admission and requests terminal failure`, async context => {
    const state = await fixture(context, { admissionRequired: true, staleClaimArtifact: true })
    state.job.effectReceipt = null
    const file = path.join(state.root, state.receipt.filename)
    if (entry !== 'report') {
      await unlink(file)
      if (entry === 'conflict') await writeFile(file, 'Conflicting bytes')
      if (entry === 'directory') await mkdir(file)
      if (entry === 'link') {
        const target = path.join(state.root, 'linked-source')
        await writeFile(target, 'Linked bytes')
        await fs.promises.link(target, file)
      }
    }
    let terminal: boolean | undefined
    const fail = state.store.fail
    state.store.fail = async (claim, code, stop) => { terminal = stop; await fail(claim, code, stop) }
    assert.equal(await new Coordinator(state.store, state.core, { publisher: state.publisher }).runOnce(worker, async () => {
      assert.fail('Handler must not run')
    }), 'failed')
    assert.equal(terminal, true)
    assert.equal(state.failure(), 'EFFECT_UNCONFIRMED')
    assert.deepEqual(state.calls, { assertReady: 1, readTask: 0, readExecution: 0, listExecutions: 0,
      updateTaskStatus: 0, startExecution: 0, remember: 0, compileContinuationContext: 0, finishExecution: 0 })
  })
}

test('receiver absence and identity change never become report absence', async context => {
  const state = await fixture(context)
  const key = state.receipt.key
  await unlink(path.join(state.root, state.receipt.filename))
  assert.equal(await state.publisher.hasReport(key), false)
  const moved = state.root + '-moved'
  context.after(() => rm(moved, { recursive: true, force: true }))
  await rename(state.root, moved)
  await assert.rejects(state.publisher.hasReport(key), { code: 'ENOENT' })
  await mkdir(state.root)
  await assert.rejects(state.publisher.hasReport(key), /EFFECT_TARGET_CHANGED/)
})

test('unexpected receiver inspection errors block admission without terminalizing ordinary failures', async context => {
  const state = await fixture(context, { admissionRequired: true })
  state.job.effectReceipt = null
  state.publisher.hasReport = async () => { throw Object.assign(new Error('private receiver detail'), { code: 'EACCES' }) }
  let terminal: boolean | undefined
  const fail = state.store.fail
  state.store.fail = async (claim, code, stop) => { terminal = stop; await fail(claim, code, stop) }
  assert.equal(await new Coordinator(state.store, state.core, { publisher: state.publisher }).runOnce(worker, async () => {
    assert.fail('Handler must not run')
  }), 'failed')
  assert.equal(terminal, false)
  assert.equal(state.failure(), 'WORKER_FAILED')
  assert.equal(state.calls.readTask, 0)
  assert.deepEqual(state.writes, [])
})

test('a genuinely absent report with neither checkpoint permits normal generation', async context => {
  const state = await fixture(context)
  state.job.effectReceipt = null
  await unlink(path.join(state.root, state.receipt.filename))
  let handlerCalls = 0
  assert.equal(await new Coordinator(state.store, state.core, { publisher: state.publisher }).runOnce(worker, async () => {
    handlerCalls++; return artifact
  }), 'completed')
  assert.equal(handlerCalls, 1)
  assert.deepEqual(state.job.effectReceipt, state.receipt)
})


test('publisher without receiver inspection fails closed before Core admission on every attempt', async context => {
  const state = await fixture(context, { admissionRequired: true, staleClaimArtifact: true })
  state.job.effectReceipt = null
  const publisher = { kind: state.publisher.kind, targetId: state.publisher.targetId,
    publish: state.publisher.publish.bind(state.publisher) }
  let terminal: boolean | undefined
  const fail = state.store.fail
  state.store.fail = async (claim, code, stop) => { terminal = stop; await fail(claim, code, stop) }
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(await new Coordinator(state.store, state.core, { publisher }).runOnce(worker, async () => {
      assert.fail('Handler must not run')
    }), 'failed')
    assert.equal(state.failure(), 'EFFECT_POLICY_MISMATCH')
    assert.equal(terminal, false)
    assert.deepEqual(state.calls, { assertReady: attempt + 1, readTask: 0, readExecution: 0, listExecutions: 0,
      updateTaskStatus: 0, startExecution: 0, remember: 0, compileContinuationContext: 0, finishExecution: 0 })
    assert.deepEqual(state.writes, [])
    assert.equal(state.job.artifact, null)
    assert.equal(state.job.effectReceipt, null)
  }
  assert.deepEqual(await readdir(state.root), [state.receipt.filename])
})
