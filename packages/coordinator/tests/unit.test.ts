import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { link as linkFile, mkdir, mkdtemp, rename, rm, symlink, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compareReportReceiver, auditReportReceiver, readReportAuditProof } from '../src/report-audit.js'
import { ImmutableReportPublisher, captureReportTarget, reportFilename, reportIdentity } from '../src/report-publisher.js'
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
  epoch: 1, owner: 'worker', attempts: 1, maxAttempts: 3, artifact: null, effectKind: 'none', effectTarget: '', effectReceipt: null }
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

test('audits one receiver across projects with exact bytes and deterministic safe findings', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'forge-report-audit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const artifact = { title: 'private-title', content: 'private-content' }
  const checkpoint = async (project_id: string, task_id: string, file?: 'exact' | 'tampered') => {
    const key = 'coordinator:v1:' + project_id + ':' + task_id + ':report'
    const { bytes, receipt } = reportIdentity(key, artifact, new ImmutableReportPublisher(root).targetId)
    if (file) await writeFile(path.join(root, receipt.filename), file === 'exact' ? bytes : Buffer.alloc(bytes.length))
    return { job: { project_id, task_id, state: 'completed', artifact, effect_receipt: receipt, oversized: false }, filename: receipt.filename }
  }
  const first = await checkpoint('project-a', 'task', 'exact')
  const second = await checkpoint('project-b', 'task', 'exact')
  const pending = { ...first.job, task_id: 'pending', state: 'queued', artifact: null, effect_receipt: null }
  const clean = await compareReportReceiver(root, captureReportTarget(root), async target => {
    assert.equal(target, first.job.effect_receipt.targetId)
    return [first.job, second.job, pending]
  })
  assert.deepEqual(clean, { scope: 'receiver', outcome: 'complete',
    counts: { jobs: 3, entries: 2, confirmed: 2, pending: 1, invalidEntries: 0 }, findings: [] })
  const missing = await checkpoint('project-a', 'missing')
  const tampered = await checkpoint('project-a', 'tampered', 'tampered')
  const malformed = await checkpoint('project-a', 'malformed', 'exact')
  const orphan = await checkpoint('project-a', 'orphan', 'exact')
  const link = reportFilename('link-entry')
  await linkFile(path.join(root, first.filename), path.join(root, link))
  await writeFile(path.join(root, 'private-inventory-name'), 'private-content')
  const jobs = [first.job, second.job, pending, missing.job, tampered.job,
    { ...malformed.job, artifact: { title: '', content: 'small invalid checkpoint' } }]
  const result = await compareReportReceiver(root, captureReportTarget(root), async () => jobs)
  assert.equal(result.outcome, 'review_required')
  assert.deepEqual(result.counts, { jobs: 6, entries: 7, confirmed: 1, pending: 1, invalidEntries: 3 })
  assert.deepEqual(Object.fromEntries(result.findings.map(finding => [finding.filename, finding.class])), {
    [first.filename]: 'invalid_entry', [link]: 'invalid_entry',
    [missing.filename]: 'missing', [tampered.filename]: 'changed', [malformed.filename]: 'invalid_checkpoint',
    [orphan.filename]: 'orphan',
  })
  assert.equal(JSON.stringify(result), JSON.stringify(await compareReportReceiver(root, captureReportTarget(root), async () => jobs.reverse())))
  assert.doesNotMatch(JSON.stringify(result), /private-|project-|task/)
})

for (const mutation of ['addition', 'deletion', 'modification'] as const) {
  test('rejects late receiver ' + mutation + ' during confirmed report verification', async t => {
    const root = await mkdtemp(path.join(await fs.promises.realpath(tmpdir()), 'forge-audit-race-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const artifact = { title: 'Fixture', content: 'Audit race' }
    const publisher = new ImmutableReportPublisher(root)
    const receipt = await publisher.publish({
      key: 'coordinator:v1:project:confirmed:report', artifact, signal: new AbortController().signal,
    })
    const foreign = path.join(root, mutation === 'addition' ? 'private-new-name' : reportFilename('coordinator:v1:project:unconfirmed:report'))
    if (mutation !== 'addition') await writeFile(foreign, 'Fixture')
    const originalOpen = fs.promises.open
    let injected = false
    fs.promises.open = async (...args) => {
      assert.equal(args[0], path.join(root, receipt.filename))
      const file = await originalOpen(...args)
      const originalRead = file.read.bind(file)
      file.read = (async (...readArgs: Parameters<typeof originalRead>) => {
        const result = await originalRead(...readArgs)
        if (!injected) {
          injected = true
          if (mutation === 'deletion') await rm(foreign)
          else await writeFile(foreign, 'Changed fixture')
        }
        return result
      }) as typeof file.read
      return file
    }
    syncBuiltinESMExports()
    try {
      const confirmed = { project_id: 'project', task_id: 'confirmed', state: 'completed', artifact, effect_receipt: receipt, oversized: false }
      const unconfirmed = { ...confirmed, task_id: 'unconfirmed', state: 'queued', artifact: null, effect_receipt: null }
      await assert.rejects(compareReportReceiver(root, captureReportTarget(root), async () => [unconfirmed, confirmed]))
      assert.equal(injected, true)
    } finally {
      fs.promises.open = originalOpen
      syncBuiltinESMExports()
    }
  })
}

test('requires prior receiver proof before loading jobs', async t => {
  const parent = await mkdtemp(path.join(tmpdir(), 'forge-audit-proof-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'original')
  const proofFile = path.join(parent, 'proof.json')
  await mkdir(root)
  const proof = captureReportTarget(root)
  const artifact = { title: 'Fixture', content: 'Original receiver' }
  const receipt = await new ImmutableReportPublisher(root).publish({
    key: 'coordinator:v1:project:task:report', artifact, signal: new AbortController().signal,
  })
  const originalBytes = await readFile(path.join(root, receipt.filename))
  const job = { project_id: 'project', task_id: 'task', state: 'completed', artifact, effect_receipt: receipt, oversized: false }
  const incomplete = { scope: 'receiver', outcome: 'incomplete', error: 'REPORT_AUDIT_INCOMPLETE' }
  const neverLoad = async () => assert.fail('Invalid proof reached database callback')
  const badProofs = [undefined, {}, { ...proof, version: 3 }, { ...proof, canonicalPath: root + '-other' },
    { ...proof, dev: proof.dev === '0' ? '1' : '0' }, { ...proof, ino: proof.ino === '0' ? '1' : '0' },
    { canonicalPath: proof.canonicalPath, dev: 2 ** 53, ino: 0 }]
  for (const bad of badProofs) {
    await assert.rejects(compareReportReceiver(root, bad, neverLoad))
    assert.deepEqual(await auditReportReceiver('postgres://%invalid', root, bad), incomplete)
  }
  await assert.rejects(readReportAuditProof(proofFile))
  await writeFile(proofFile, '{')
  await assert.rejects(readReportAuditProof(proofFile))
  await writeFile(proofFile, Buffer.alloc(4097))
  await assert.rejects(readReportAuditProof(proofFile))
  await writeFile(proofFile, Buffer.from([0xff]))
  await assert.rejects(readReportAuditProof(proofFile))
  await assert.rejects(readReportAuditProof(parent))
  await writeFile(proofFile, String.fromCodePoint(0xfeff) + JSON.stringify(proof))
  const linkedProof = path.join(parent, 'linked-proof')
  await linkFile(proofFile, linkedProof)
  await assert.rejects(readReportAuditProof(linkedProof))
  await rm(linkedProof)
  const prior = await readReportAuditProof(proofFile)
  const clean = await compareReportReceiver(root, prior, async () => [job])
  assert.equal(clean.outcome, 'complete')
  assert.equal(clean.counts.confirmed, 1)
  const legacy = { canonicalPath: proof.canonicalPath, dev: Number(proof.dev), ino: Number(proof.ino) }
  if (Number.isSafeInteger(legacy.dev) && Number.isSafeInteger(legacy.ino)) {
    assert.deepEqual(await compareReportReceiver(root, legacy, async () => [job]), clean)
  } else {
    await assert.rejects(compareReportReceiver(root, legacy, neverLoad))
  }
  assert.deepEqual(await readFile(path.join(root, receipt.filename)), originalBytes)
  const retired = path.join(parent, 'retired')
  await rename(root, retired)
  await mkdir(root)
  let loads = 0
  await assert.rejects(compareReportReceiver(root, prior, async () => { loads++; return [] }))
  assert.equal(loads, 0)
  assert.deepEqual(await auditReportReceiver('postgres://%invalid', root, prior), incomplete)
  assert.deepEqual(await readdir(root), [])
  assert.deepEqual(await readdir(retired), [receipt.filename])
  assert.deepEqual(await readFile(path.join(retired, receipt.filename)), originalBytes)
})

test('fails closed for inventory bounds, database errors, and receiver replacement', async t => {
  const parent = await mkdtemp(path.join(tmpdir(), 'forge-audit-bounds-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'root')
  await mkdir(root)
  const probe = { project_id: 'project', task_id: 'task', state: 'queued', artifact: null, effect_receipt: null, oversized: false }
  await assert.rejects(compareReportReceiver(root, captureReportTarget(root), async () => Array(1025).fill(probe)))
  for (let i = 0; i < 4097; i++) await mkdir(path.join(root, String(i)))
  await assert.rejects(compareReportReceiver(root, captureReportTarget(root), async () => []))
  const next = path.join(parent, 'next')
  await mkdir(next)
  await assert.rejects(compareReportReceiver(next, captureReportTarget(next), async () => {
    await rename(next, path.join(parent, 'old'))
    await mkdir(next)
    return []
  }))
  const linked = path.join(parent, 'linked')
  await symlink(next, linked, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(compareReportReceiver(linked, captureReportTarget(next), async () => assert.fail('Invalid root reached database')))
  const linkName = reportFilename('symlink')
  await symlink(root, path.join(next, linkName), process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual((await compareReportReceiver(next, captureReportTarget(next), async () => [])).findings, [{ filename: linkName, class: 'invalid_entry' }])
  assert.deepEqual(await auditReportReceiver('postgres://%invalid', next, captureReportTarget(next)), {
    scope: 'receiver', outcome: 'incomplete', error: 'REPORT_AUDIT_INCOMPLETE',
  })
})
