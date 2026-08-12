import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createPhysicalPackage, parsePhysicalManifest, verifyPhysicalPackage } from '../../src/physical.js'
import { fetchPhysicalPackageFromS3, replicatePhysicalPackageToS3 } from '../../src/physical-s3.js'
import type { S3DownloadRequest, S3PutRequest, S3ReplicationClient } from '../../src/s3.js'
import type { S3ReplicationTarget } from '../../src/types.js'

class MemoryS3 implements S3ReplicationClient {
  readonly objects = new Map<string, Buffer>()
  readonly puts: S3PutRequest[] = []
  tamper = false
  async putObject(request: S3PutRequest): Promise<void> {
    this.puts.push(request)
    this.objects.set(`${request.bucket}/${request.key}`, await readFile(request.file))
  }
  async downloadObject(request: S3DownloadRequest): Promise<void> {
    const object = this.objects.get(`${request.bucket}/${request.key}`)
    if (!object) throw new Error('missing test object')
    const content = this.tamper && request.key.endsWith('.forge-physical') ? Buffer.concat([object, Buffer.from('x')]) : object
    await writeFile(request.destination, content, { flag: 'wx' })
  }
}

const cluster = { systemIdentifier: '7548123456789012345', serverVersion: '18.4', serverVersionNumber: 180004, timeline: 1 }
const target: S3ReplicationTarget = {
  name: 'physical-offsite', type: 's3', bucket: 'forge-recovery-prod', prefix: 'physical/7548123456789012345',
  region: 'eu-west-1', objectLock: { mode: 'COMPLIANCE', retentionDays: 30 },
}

test('encrypts and verifies a cluster-bound WAL package', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-physical-'))
  const passphrase = Buffer.from('separate physical recovery secret')
  try {
    const source = path.join(directory, '000000010000000000000001')
    await writeFile(source, Buffer.alloc(16 * 1024, 7))
    const physical = await createPhysicalPackage({ sourcePath: source, outputDirectory: path.join(directory, 'out'), passphrase, kind: 'wal', cluster, label: 'wal-0001' })
    const verified = await verifyPhysicalPackage(physical.manifestPath, passphrase)
    assert.equal(verified.kind, 'wal')
    assert.equal(verified.cluster.systemIdentifier, cluster.systemIdentifier)
    assert.equal(verified.source.file, path.basename(source))
  } finally {
    passphrase.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects traversal, unsupported KDF and ciphertext tampering', async () => {
  assert.throws(() => parsePhysicalManifest({ format: 'forge-resilience-physical', formatVersion: 1 }), /incomplete/)
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-physical-tamper-'))
  const passphrase = Buffer.from('separate physical recovery secret')
  try {
    const source = path.join(directory, 'base.tar')
    await writeFile(source, 'base backup bytes')
    const physical = await createPhysicalPackage({ sourcePath: source, outputDirectory: path.join(directory, 'out'), passphrase, kind: 'base-backup', cluster, label: 'base-1' })
    await writeFile(physical.payloadPath, Buffer.concat([await readFile(physical.payloadPath), Buffer.from('tamper')]))
    await assert.rejects(verifyPhysicalPackage(physical.manifestPath, passphrase), /checksum/)
  } finally {
    passphrase.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
})

test('uploads payload before manifest and authenticates the downloaded physical replica', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-physical-s3-'))
  const passphrase = Buffer.from('separate physical recovery secret')
  try {
    const source = path.join(directory, '000000010000000000000002')
    await writeFile(source, Buffer.alloc(1024, 3))
    const physical = await createPhysicalPackage({ sourcePath: source, outputDirectory: path.join(directory, 'out'), passphrase, kind: 'wal', cluster, label: 'wal-0002' })
    const client = new MemoryS3()
    const replica = await replicatePhysicalPackageToS3(physical, target, passphrase, new Date('2026-08-12T12:00:00Z'), client)
    assert.deepEqual(client.puts.map((put) => put.key), [
      'physical/7548123456789012345/wal-0002.forge-physical',
      'physical/7548123456789012345/wal-0002.forge-physical.json',
    ])
    assert.equal(replica.manifestLocation.endsWith('.forge-physical.json'), true)
    const fetched = await fetchPhysicalPackageFromS3(target, path.basename(physical.manifestPath), path.join(directory, 'fetched'), passphrase, client)
    assert.equal((await verifyPhysicalPackage(fetched.manifestPath, passphrase)).kind, 'wal')
  } finally {
    passphrase.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
})

test('fails closed when an S3 physical payload is corrupted', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-physical-s3-tamper-'))
  const passphrase = Buffer.from('separate physical recovery secret')
  try {
    const source = path.join(directory, 'wal')
    await writeFile(source, 'wal bytes')
    const physical = await createPhysicalPackage({ sourcePath: source, outputDirectory: path.join(directory, 'out'), passphrase, kind: 'wal', cluster, label: 'wal-tamper' })
    const client = new MemoryS3()
    client.tamper = true
    await assert.rejects(replicatePhysicalPackageToS3(physical, target, passphrase, new Date(), client), /checksum|authentication/i)
  } finally {
    passphrase.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
})
