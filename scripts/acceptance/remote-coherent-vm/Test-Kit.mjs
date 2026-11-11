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
  const reportIdentity = {
    proof: { canonicalPath: 'C:\\ForgeFixture\\report-parent\\reports' },
    receipt: {
      kind: 'immutable-report-v1',
      key: 'fixture',
      sha256: digest('synthetic-report'),
      filename: digest('fixture') + '.report.md',
    },
  }
  await writeFile(files.identity, JSON.stringify(reportIdentity))
  assert.deepEqual(await readRestoreIdentity(files), reportIdentity)
  await writeFile(files.identity, JSON.stringify({
    ...reportIdentity,
    receipt: { ...reportIdentity.receipt, filename: '..\\outside.report.md' },
  }))
  await assert.rejects(readRestoreIdentity(files), { code: 'ERR_ASSERTION' })
  await writeFile(files.identity, 'synthetic-identity')
  const wrapped = 'wrapped.json'
  const captureKey = await createWrappedCoherentKey(path.join(origin, wrapped), runId, publicKey)
  let generation
  try {
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
        assert.equal(await readFile(payload[role], 'utf8'), 'synthetic-' + role)
        materialized++
      }
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
    databaseServersStarted: 0,
  }))
} finally {
  await rm(workspace, { recursive: true, force: true })
}
