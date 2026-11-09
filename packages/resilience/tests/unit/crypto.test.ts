import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { cp, readdir } from 'node:fs/promises'
import { createCoherentGeneration, withVerifiedCoherentGeneration, coherentRoles } from '../../src/coherent.js'
import { decryptFile, encryptToFile, newEncryptionMaterial, verifyAuthentication } from '../../src/crypto.js'

function collector(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
}

test('coherent generations authenticate all exact roles before callback; failed capture preserves prior ready generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forge-coherent-test-'))
  const key = { keyId: 'fixture', key: randomBytes(32) }
  const files = Object.fromEntries(coherentRoles.map(role => [role, path.join(root, `${role}.source`)])) as Record<typeof coherentRoles[number], string>
  let held = true
  const maintenance = { async assertHeld() { assert.ok(held) } }
  const capture = async () => ({ cutoff: new Date().toISOString(), files })
  let callbacks = 0
  try {
    for (const role of coherentRoles) await writeFile(files[role], `actual ${role} bytes`)
    const first = await createCoherentGeneration({ root: path.join(root, 'bundles'), key, maintenance, capture })
    const ready = await readFile(path.join(first.directory, 'ready.json'))
    await assert.rejects(createCoherentGeneration({ root: path.join(root, 'bundles'), key, maintenance, async capture() { held = false; throw new Error('drain lost') } }))
    assert.deepEqual(await readFile(path.join(first.directory, 'ready.json')), ready)
    assert.deepEqual(await readdir(path.join(root, 'bundles')), [first.generation])
    held = true
    let leaseChecks = 0
    await assert.rejects(createCoherentGeneration({ root: path.join(root, 'bundles'), key, capture,
      maintenance: { async assertHeld() { if (++leaseChecks > 1) throw new Error('lease expired after sealing') } } }))
    assert.deepEqual(await readdir(path.join(root, 'bundles')), [first.generation])
    assert.deepEqual(await readFile(path.join(first.directory, 'ready.json')), ready)
    await writeFile(files.coordinator, 'later actual coordinator archive')
    const second = await createCoherentGeneration({ root: path.join(root, 'bundles'), key, maintenance, capture })
    for (const negative of ['wrong-key', 'wrong-id', 'generation', 'missing', 'mixed', 'role', 'tamper', 'header']) {
      const candidate = path.join(root, negative)
      await cp(first.directory, candidate, { recursive: true })
      if (negative === 'missing') await rm(path.join(candidate, 'core.enc'))
      if (negative === 'mixed') await cp(path.join(second.directory, 'coordinator.enc'), path.join(candidate, 'coordinator.enc'))
      if (negative === 'role') await cp(path.join(candidate, 'core.enc'), path.join(candidate, 'coordinator.enc'))
      if (negative === 'tamper') await writeFile(path.join(candidate, 'report.enc'), 'damaged report')
      if (negative === 'header') await writeFile(path.join(candidate, 'ready.json'), '{}')
      await assert.rejects(withVerifiedCoherentGeneration({ directory: candidate, generation: negative === 'generation' ? second.generation : first.generation,
        key: negative === 'wrong-key' ? { ...key, key: randomBytes(32) } : negative === 'wrong-id' ? { ...key, keyId: 'other' } : key }, async () => { callbacks++ }))
      assert.equal(callbacks, 0)
    }
    // Local independent replica mock: no deletion/retention until copy authenticates.
    const replica = path.join(root, 'replica')
    await cp(first.directory, replica, { recursive: true })
    await withVerifiedCoherentGeneration({ directory: replica, generation: first.generation, key }, async restored => {
      for (const role of coherentRoles) assert.equal((await readFile(restored[role], 'utf8')), `actual ${role} bytes`)
      callbacks++
    })
    assert.equal(callbacks, 1)
    assert.deepEqual(await readFile(path.join(first.directory, 'ready.json')), ready)
  } finally { key.key.fill(0); await rm(root, { recursive: true, force: true }) }
})

test('encrypts, authenticates and decrypts a streaming backup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-resilience-'))
  const destination = path.join(directory, 'backup.bin')
  const passphrase = Buffer.from('correct horse battery staple')
  const material = newEncryptionMaterial()
  const plaintext = Buffer.from('FORGE survives process and machine replacement.')
  try {
    const encrypted = await encryptToFile(Readable.from([plaintext]), destination, passphrase, material, '{"test":1}')
    assert.notEqual((await readFile(destination)).toString('utf8'), plaintext.toString('utf8'))
    assert.equal(encrypted.bytes > 0, true)
    await verifyAuthentication(destination, passphrase, material.salt, material.iv, encrypted.authTag, material.parameters, '{"test":1}')
    const chunks: Buffer[] = []
    await decryptFile(destination, collector(chunks), passphrase, material.salt, material.iv, encrypted.authTag, material.parameters, '{"test":1}')
    assert.deepEqual(Buffer.concat(chunks), plaintext)
  } finally {
    passphrase.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects payload and authenticated-metadata tampering', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-resilience-'))
  const destination = path.join(directory, 'backup.bin')
  const passphrase = Buffer.from('correct horse battery staple')
  const material = newEncryptionMaterial()
  try {
    const encrypted = await encryptToFile(Readable.from(['immutable']), destination, passphrase, material, '{"source":"a"}')
    await assert.rejects(
      verifyAuthentication(destination, passphrase, material.salt, material.iv, encrypted.authTag, material.parameters, '{"source":"b"}'),
    )
    const bytes = await readFile(destination)
    bytes[0] = (bytes[0] ?? 0) ^ 0xff
    await writeFile(destination, bytes)
    await assert.rejects(
      verifyAuthentication(destination, passphrase, material.salt, material.iv, encrypted.authTag, material.parameters, '{"source":"a"}'),
    )
  } finally {
    passphrase.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
})
