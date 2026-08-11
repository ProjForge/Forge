import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import { decryptFile, encryptToFile, newEncryptionMaterial, verifyAuthentication } from '../../src/crypto.js'

function collector(chunks: Buffer[]): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
}

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
