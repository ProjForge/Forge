import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, cp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { capture, finishCapture, restore, cleanup, dbEvidence } from './database.mjs'
import { createWrappedCoherentKey, readWrappedCoherentKey } from './packages/resilience/dist/coherent-custody.js'
import { createCoherentGeneration, withVerifiedCoherentGeneration } from './packages/resilience/dist/coherent.js'
import { writeTransferManifest, verifyTransferManifest } from './remote-coherent-transfer.mjs'

const root = 'C:/ForgeFixture'
const privateKeyPath = root + '/private/rsa.pem'
const publicKeyPath = root + '/public/public.pem'
const exchange = root + '/exchange'
const [role, runId, pin] = process.argv.slice(2)
const result = { role, runId, node: process.version }
const wrapped = 'wrapped.json'
const components = ['core.enc', 'coordinator.enc', 'report.enc', 'identity.enc', 'inventory.enc', 'ready.json']
const fingerprint = key => createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex')
const rsaPair = () => generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

async function publish() {
  const publicKey = await readFile(publicKeyPath, 'utf8')
  assert.equal(fingerprint(publicKey), pin, 'Recipient fingerprint mismatch')
  await assert.rejects(stat(privateKeyPath), { code: 'ENOENT' })
  const key = await createWrappedCoherentKey(path.join(exchange, wrapped), runId, publicKey)
  try {
    const captured = await capture()
    const { generation } = await createCoherentGeneration({
      root: path.join(exchange, 'bundles'),
      key,
      maintenance: captured.maintenance,
      capture: async () => ({ cutoff: captured.cutoff, files: captured.files }),
    })
    await finishCapture()
    await rm(root + '/capturer/originals', { recursive: true })
    await assert.rejects(stat(root + '/capturer/originals'), { code: 'ENOENT' })
    result.originalsRemoved = true
    result.transfer = await writeTransferManifest(exchange, { runId, generation, recipientSha256: pin })
  } finally {
    key.key.fill(0)
    result.keyZeroized = true
  }
}

async function stage() {
  const input = 'C:/FixtureInbox/handoff'
  const options = { runId, recipientSha256: process.env.FORGE_REHEARSAL_RECIPIENT, manifestSha256: pin }
  const { generation } = await verifyTransferManifest(input, options)
  const relative = path.join('bundles', generation)
  await mkdir(path.join(exchange, relative), { recursive: true })
  const files = [wrapped, 'manifest.json', ...components.map(name => path.join(relative, name))]
  for (const file of files) {
    await copyFile(path.join(input, file), path.join(exchange, file), constants.COPYFILE_EXCL)
  }
  await verifyTransferManifest(exchange, options)
}

async function recover() {
  const privateKey = await readFile(privateKeyPath, 'utf8')
  const recipientSha256 = fingerprint(privateKey)
  const { generation } = await verifyTransferManifest(exchange, { runId, recipientSha256, manifestSha256: pin })
  await assert.rejects(stat(root + '/capturer/originals'), { code: 'ENOENT' })
  result.originalsAbsent = true

  const wrappedPath = path.join(exchange, wrapped)
  const key = await readWrappedCoherentKey(wrappedPath, runId, privateKey)
  const bundle = { generation, directory: path.join(exchange, 'bundles', generation) }
  const tampered = root + '/private/tampered'
  try {
    await assert.rejects(readWrappedCoherentKey(wrappedPath, runId, rsaPair().privateKey))
    await assert.rejects(readWrappedCoherentKey(root + '/private/missing.json', runId, privateKey), { code: 'ENOENT' })
    let invoked = false
    const countInvocation = () => { invoked = true }
    const wrongKey = { keyId: runId, key: randomBytes(32) }
    try {
      await assert.rejects(withVerifiedCoherentGeneration({ ...bundle, key: wrongKey }, countInvocation))
    } finally {
      wrongKey.key.fill(0)
    }
    await cp(bundle.directory, tampered, { recursive: true, force: false, errorOnExist: true })
    const report = tampered + '/report.enc'
    const bytes = await readFile(report)
    bytes[0] ^= 1
    await writeFile(report, bytes)
    await assert.rejects(withVerifiedCoherentGeneration({ ...bundle, directory: tampered, key }, countInvocation))
    assert.equal(invoked, false)
    await assert.rejects(stat(root + '/private/target'), { code: 'ENOENT' })
    result.negativesBeforeProvision = ['wrong-private-key', 'missing-wrapped-key', 'wrong-symmetric-key', 'altered-report']

    await withVerifiedCoherentGeneration({ ...bundle, key }, async files => {
      const privateTemp = await realpath(process.env.TEMP)
      for (const file of Object.values(files)) {
        const relative = path.relative(privateTemp, await realpath(file))
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative))
        const acl = JSON.parse(execFileSync('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', 'C:/ForgeFixtureInput/acl.ps1', file,
        ], { encoding: 'utf8' }))
        assert.ok(acl.ownerMatches && acl.onlyCustodian)
      }
      assert.equal(Object.keys(files).length, 4)
      result.authenticatedComponents = 4
      result.plaintextAclOnlyCustodian = true
      await restore(files)
    })
  } finally {
    key.key.fill(0)
    result.keyZeroized = true
    await rm(tampered, { recursive: true, force: true })
  }
}

assert.equal(process.platform, 'win32')
assert.equal(path.resolve().toLowerCase(), 'c:\\forgefixtureinput')
assert.match(runId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
assert.ok(['init', 'capture', 'stage', 'restore'].includes(role))
if (role !== 'init') assert.match(pin, /^[a-f0-9]{64}$/)
try {
  if (role === 'init') {
    const pair = rsaPair()
    await writeFile(privateKeyPath, pair.privateKey, { flag: 'wx' })
    await writeFile(publicKeyPath, pair.publicKey, { flag: 'wx' })
    result.recipientSha256 = fingerprint(pair.publicKey)
  } else if (role === 'capture') {
    await publish()
  } else if (role === 'stage') {
    await stage()
  } else {
    await recover()
  }
  await cleanup()
} catch (error) {
  await cleanup().catch(() => {})
  result.failure = { name: error.name, code: error.code, tool: error.tool, phase: dbEvidence.phase, diagnosticHash: error.diagnosticHash }
  console.error('Fixture phase failed', JSON.stringify(result.failure))
  process.exitCode = 1
}
if (role !== 'stage') {
  const account = role === 'capture' ? 'capturer' : 'custodian'
  await writeFile(root + '/' + account + '/' + role + '.crypto.json', JSON.stringify({ ...result, database: dbEvidence }))
}
