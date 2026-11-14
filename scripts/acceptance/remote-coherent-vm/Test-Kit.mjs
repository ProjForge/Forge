import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWrappedCoherentKey, readWrappedCoherentKey } from './input/packages/resilience/dist/coherent-custody.js'
import { coherentRoles, createCoherentGeneration, withVerifiedCoherentGeneration } from './input/packages/resilience/dist/coherent.js'
import { writeTransferManifest, verifyTransferManifest } from './input/remote-coherent-transfer.mjs'
import { readRestoreIdentity } from './input/database.mjs'
import { reportIdentity } from './input/packages/coordinator/dist/index.js'
import { captureReports, inventory } from './input/report-fixture.mjs'

assert.equal(process.version, 'v22.23.4')
for (const binary of ['pg_dump', 'pg_restore']) {
  const file = fileURLToPath(new URL('./input/postgres/bin/' + binary + '.exe', import.meta.url))
  assert.match(execFileSync(file, ['--version'], { encoding: 'utf8', windowsHide: true }), /PostgreSQL\) 18\.4\b/)
}

const workspace = await mkdtemp(path.join(tmpdir(), 'forge-remote-kit-test-'))
try {
  const runId = randomUUID()
  const origin = path.join(workspace, 'origin')
  const destination = path.join(workspace, 'destination')
  const inputs = path.join(workspace, 'inputs')
  await Promise.all([mkdir(origin), mkdir(inputs)])
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const recipientSha256 = createHash('sha256').update(createPublicKey(publicKey).export({ type: 'spki', format: 'der' })).digest('hex')
  const files = {}
  for (const role of coherentRoles) {
    const file = path.join(inputs, role)
    await writeFile(file, 'synthetic-' + role, { flag: 'wx' })
    files[role] = file
  }
  const digest = value => createHash('sha256').update(value).digest('hex')
  const proof = { version: 2, canonicalPath: path.resolve('C:/ForgeFixture/report-parent/reports'), dev: '1', ino: '2' }
  const targetId = digest(`${proof.canonicalPath.toLowerCase()}:1:2`)
  const expected = Array.from({ length: 3 }, (_, index) => ({ projectId: randomUUID(), taskId: randomUUID(), agentId: randomUUID(), taskKey: `effect-${index}` }))
  const rows = expected.map((item, index) => {
    const artifact = { title: `Synthetic ${index}`, content: `Report ${index}` }
    const { receipt } = reportIdentity(`coordinator:v1:${item.projectId}:${item.taskId}:report`, artifact, targetId)
    return { id: randomUUID(), effect_kind: 'immutable-report-v1', project_id: item.projectId, task_id: item.taskId, agent_id: item.agentId, task_key: item.taskKey,
      state: index === 0 ? 'queued' : 'completed', attempts: 1, artifact, effect_receipt: receipt, effect_target: targetId }
  })
  const sourceSnapshot = Object.fromEntries(Object.entries({ projects: 3, tasks: 3, executions: 3, jobs: 3, memories: 3, embeddings: 1, embedding_profiles: 1 }).map(([table, count]) => [table, { count, sha256: digest(table) }]))
  const identity = { fixtureVersion: 2, proof, expected, rows, inventory: inventory(rows), sourceSnapshot, systemIdentifier: '1234567890123456789', cutoff: new Date().toISOString() }
  const payload = { fixtureVersion: 2, reports: rows.map(row => {
    const { bytes, receipt } = reportIdentity(row.effect_receipt.key, row.artifact, targetId)
    return { filename: receipt.filename, bytes: bytes.length, sha256: receipt.sha256, base64: bytes.toString('base64') }
  }) }
  async function save(i = identity, p = payload) {
    await writeFile(files.identity, JSON.stringify(i))
    await writeFile(files.report, JSON.stringify(p))
  }
  await save()
  assert.deepEqual(await readRestoreIdentity(files), identity)
  let semanticNegatives = 0
  async function rejects(i, p = payload) {
    await save(i, p)
    await assert.rejects(readRestoreIdentity(files), { code: 'ERR_ASSERTION' })
    semanticNegatives++
  }
  await rejects({ ...identity, inventory: identity.inventory.slice(1) })
  await rejects({ ...identity, inventory: [...identity.inventory.slice(0, 2), identity.inventory[0]] })
  await rejects(identity, { ...payload, reports: payload.reports.slice(1) })
  await rejects(identity, { ...payload, reports: [...payload.reports.slice(0, 2), payload.reports[0]] })
  for (const field of ['base64', 'sha256', 'filename', 'bytes']) {
    const bad = structuredClone(payload)
    bad.reports.at(-1)[field] = field === 'bytes' ? 0 : field === 'filename' ? '..\\outside.report.md' : 'altered'
    await rejects(identity, bad)
  }
  const bad = structuredClone(identity)
  bad.inventory.at(-1).receipt.filename = '..\\outside.report.md'
  bad.rows.find(row => row.task_id === bad.inventory.at(-1).taskId).effect_receipt.filename = '..\\outside.report.md'
  await rejects(bad)
  await assert.rejects(readRestoreIdentity({ ...files, report: path.join(workspace, 'absent-report') }), { code: 'ERR_ASSERTION' })
  await assert.rejects(captureReports(path.join(workspace, 'absent-directory'), bad), { code: 'ERR_ASSERTION' })
  semanticNegatives += 2
  const badReceipt = structuredClone(identity)
  badReceipt.inventory.at(-1).receipt.sha256 = digest('wrong-receipt')
  badReceipt.rows.find(row => row.task_id === badReceipt.inventory.at(-1).taskId).effect_receipt.sha256 = digest('wrong-receipt')
  await rejects(badReceipt)
  await rejects({ ...identity, expected: identity.expected.slice(1) })
  await rejects({ ...identity, proof: { ...proof, canonicalPath: path.resolve('C:/outside') } })
  await rejects({ ...identity, proof: { ...proof, ino: '02' } })
  await rejects({ ...identity, fixtureVersion: 1 })
  await rejects({ proof, receipt: rows[0].effect_receipt })
  // NTFS can require the exact string-based target proof rather than safe numbers.
  const wide = structuredClone(identity)
  wide.proof.ino = '18446744073709551615'
  const wideTarget = digest(`report-target-v2:${JSON.stringify([proof.canonicalPath.toLowerCase(), proof.dev, wide.proof.ino])}`)
  for (const row of wide.rows) {
    row.effect_target = wideTarget
    row.effect_receipt.targetId = wideTarget
  }
  wide.inventory = inventory(wide.rows)
  await save(wide)
  assert.deepEqual(await readRestoreIdentity(files), wide)
  await save()
  const plaintext = Object.fromEntries(await Promise.all(coherentRoles.map(async role => [role, await readFile(files[role], 'utf8')])) )
  const wrapped = 'wrapped.json'
  const captureKey = await createWrappedCoherentKey(path.join(origin, wrapped), runId, publicKey)
  let generation
  try {
    // Authentication alone does not establish a complete fixture population.
    await save({ ...identity, inventory: identity.inventory.slice(1) }, { ...payload, reports: payload.reports.slice(1) })
    const incomplete = await createCoherentGeneration({ root: path.join(origin, 'semantic-negative'), key: captureKey,
      maintenance: { assertHeld() {} }, capture: async () => ({ cutoff: new Date().toISOString(), files }) })
    let authenticated = false
    await withVerifiedCoherentGeneration({ directory: path.join(origin, 'semantic-negative', incomplete.generation), generation: incomplete.generation, key: captureKey }, async files => {
      authenticated = true
      await assert.rejects(readRestoreIdentity(files), { code: 'ERR_ASSERTION' })
    })
    assert.equal(authenticated, true)
    await rm(path.join(origin, 'semantic-negative'), { recursive: true })
    await save()
    const created = await createCoherentGeneration({
      root: path.join(origin, 'bundles'),
      key: captureKey,
      maintenance: { assertHeld() {} },
      capture: async () => ({ cutoff: new Date().toISOString(), files }),
    })
    generation = created.generation
  } finally {
    captureKey.key.fill(0)
  }
  const { manifestSha256 } = await writeTransferManifest(origin, { runId, generation, recipientSha256 })
  await cp(origin, destination, { recursive: true, force: false, errorOnExist: true })
  await rm(origin, { recursive: true })
  await rm(inputs, { recursive: true })
  const verified = await verifyTransferManifest(destination, { runId, recipientSha256, manifestSha256 })
  assert.equal(verified.generation, generation)
  const restoreKey = await readWrappedCoherentKey(path.join(destination, wrapped), runId, privateKey)
  const directory = path.join(destination, 'bundles', generation)
  try {
    let materialized = 0
    await withVerifiedCoherentGeneration({ directory, generation, key: restoreKey }, async payload => {
      for (const role of coherentRoles) {
        assert.equal(await readFile(payload[role], 'utf8'), plaintext[role])
        materialized++
      }
      assert.deepEqual(await readRestoreIdentity(payload), identity)
    })
    assert.equal(materialized, 4)
    const report = path.join(directory, 'report.enc')
    const damaged = await readFile(report)
    damaged[0] ^= 1
    await writeFile(report, damaged)
    await assert.rejects(verifyTransferManifest(destination, { runId, recipientSha256, manifestSha256 }))
    let callbackEntered = false
    await assert.rejects(withVerifiedCoherentGeneration({ directory, generation, key: restoreKey }, async () => {
      callbackEntered = true
    }))
    assert.equal(callbackEntered, false)
  } finally {
    restoreKey.key.fill(0)
  }
  console.log(JSON.stringify({
    fixture: 'offline-local-transfer',
    node: process.version,
    postgresClient: '18.4',
    materializedComponents: 4,
    tamperRejectedBeforeCallback: true,
    reportPathValidatedBeforeProvisioning: true,
    reportsExpected: 3,
    semanticNegatives,
    authenticatedIncompleteRejectedBeforeProvisioning: true,
    historicalSingletonRejected: true,
    databaseServersStarted: 0,
  }))
} finally {
  await rm(workspace, { recursive: true, force: true })
}
