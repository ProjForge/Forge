import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { writeTransferManifest, verifyTransferManifest } from './remote-coherent-transfer.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-transfer-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const options = { runId: randomUUID(), generation: randomUUID(), recipientSha256: 'a'.repeat(64) }
  const bundle = path.join(directory, 'bundles', options.generation)
  await mkdir(bundle, { recursive: true })
  await writeFile(path.join(directory, 'wrapped.json'), JSON.stringify({ version: 1, keyId: options.runId, wrapped: 'YWJj' }))
  for (const role of ['core', 'coordinator', 'report', 'identity', 'inventory']) await writeFile(path.join(bundle, `${role}.enc`), `synthetic-${role}`)
  await writeFile(path.join(bundle, 'ready.json'), JSON.stringify({ format: 'forge-coherent', version: 1, generation: options.generation, keyId: options.runId, envelope: { salt: '1'.repeat(32), iv: '2'.repeat(24), authTag: '3'.repeat(32) } }))
  return { directory, options, bundle }
}

test('round trip pins all seven exact files and writes exclusively', async t => {
  const { directory, options } = await fixture(t)
  const written = await writeTransferManifest(directory, options)
  assert.deepEqual(await verifyTransferManifest(directory, { ...options, ...written }), written)
  const bytes = await readFile(path.join(directory, 'manifest.json'))
  assert.equal(written.manifestSha256, hash(bytes))
  const manifest = JSON.parse(bytes)
  assert.equal(manifest.version, 1)
  assert.equal(manifest.files.length, 7)
  for (const entry of manifest.files) {
    const content = await readFile(path.join(directory, entry.path))
    assert.equal(entry.bytes, content.length)
    assert.equal(entry.sha256, hash(content))
  }
  await assert.rejects(writeTransferManifest(directory, options))
  assert.deepEqual(await readFile(path.join(directory, 'manifest.json')), bytes)
})

for (const scenario of ['extra-root', 'extra-bundle', 'missing', 'corrupt', 'wrong-run', 'wrong-recipient', 'wrong-pin', 'wrong-generation', 'bad-inventory', 'wrong-ready', 'wrong-wrapped']) {
  test(`rejects ${scenario}`, async t => {
    const { directory, options, bundle } = await fixture(t)
    const result = await writeTransferManifest(directory, options)
    const verify = { ...options, ...result }
    if (scenario === 'extra-root') await writeFile(path.join(directory, 'unexpected'), 'x')
    if (scenario === 'extra-bundle') await writeFile(path.join(bundle, 'unexpected'), 'x')
    if (scenario === 'missing') await rm(path.join(bundle, 'core.enc'))
    if (scenario === 'corrupt') await writeFile(path.join(bundle, 'core.enc'), 'tampered')
    if (scenario === 'wrong-run') verify.runId = randomUUID()
    if (scenario === 'wrong-recipient') verify.recipientSha256 = 'b'.repeat(64)
    if (scenario === 'wrong-pin') verify.manifestSha256 = '0'.repeat(64)
    if (['wrong-generation', 'bad-inventory', 'wrong-ready', 'wrong-wrapped'].includes(scenario)) {
      const manifestFile = path.join(directory, 'manifest.json')
      const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
      if (scenario === 'wrong-generation') manifest.generation = randomUUID()
      if (scenario === 'bad-inventory') manifest.files[0].path = '../escape'
      if (scenario === 'wrong-ready' || scenario === 'wrong-wrapped') {
        const relative = scenario === 'wrong-ready' ? `bundles/${options.generation}/ready.json` : 'wrapped.json'
        const file = path.join(directory, relative)
        const metadata = JSON.parse(await readFile(file, 'utf8'))
        metadata.keyId = randomUUID()
        const bytes = Buffer.from(JSON.stringify(metadata))
        await writeFile(file, bytes)
        Object.assign(manifest.files.find(entry => entry.path === relative), { bytes: bytes.length, sha256: hash(bytes) })
      }
      const bytes = Buffer.from(JSON.stringify(manifest))
      await writeFile(manifestFile, bytes)
      verify.manifestSha256 = hash(bytes)
    }
    await assert.rejects(verifyTransferManifest(directory, verify))
  })
}

test('writer rejects invalid identifiers and inconsistent identity before publication', async t => {
  const { directory, options, bundle } = await fixture(t)
  for (const change of [{ runId: '../escape' }, { generation: 'a'.repeat(36) }, { recipientSha256: 'A'.repeat(64) }]) await assert.rejects(writeTransferManifest(directory, { ...options, ...change }))
  const ready = JSON.parse(await readFile(path.join(bundle, 'ready.json'), 'utf8'))
  ready.keyId = randomUUID()
  await writeFile(path.join(bundle, 'ready.json'), JSON.stringify(ready))
  await assert.rejects(writeTransferManifest(directory, options))
  await assert.rejects(readFile(path.join(directory, 'manifest.json')), { code: 'ENOENT' })
})

test('rejects Windows directory junctions in inventory and supplied root', async t => {
  const { directory, options, bundle } = await fixture(t)
  const saved = path.join(directory, 'saved')
  await rename(bundle, saved)
  await symlink(saved, bundle, 'junction')
  await rm(saved, { recursive: true, force: true })
  // The dangling junction is still forbidden before any file is opened.
  await assert.rejects(writeTransferManifest(directory, options))
  await rm(bundle, { force: true })
  const alias = `${directory}-alias`
  t.after(() => rm(alias, { force: true }))
  await symlink(directory, alias, 'junction')
  await assert.rejects(writeTransferManifest(alias, options))
})
