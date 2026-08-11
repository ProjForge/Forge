import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fetchBackupFromS3, replicateBackupToS3, type S3DownloadRequest, type S3PutRequest, type S3ReplicationClient } from '../../src/s3.js'
import type { S3ReplicationTarget } from '../../src/types.js'
import { recoveryPackage } from '../support/recovery-package.js'

class MemoryS3 implements S3ReplicationClient {
  readonly objects = new Map<string, Buffer>()
  readonly puts: S3PutRequest[] = []
  tamperPayload = false

  async putObject(request: S3PutRequest): Promise<void> {
    this.puts.push(request)
    this.objects.set(`${request.bucket}/${request.key}`, await readFile(request.file))
  }

  async downloadObject(request: S3DownloadRequest): Promise<void> {
    const content = this.objects.get(`${request.bucket}/${request.key}`)
    if (!content) throw new Error('missing test object')
    const value = this.tamperPayload && request.key.endsWith('.forge-backup')
      ? Buffer.concat([content, Buffer.from('tampered')])
      : content
    await writeFile(request.destination, value, { flag: 'wx' })
  }
}

const target: S3ReplicationTarget = {
  name: 'offsite', type: 's3', bucket: 'forge-recovery-prod', prefix: 'logical', region: 'eu-west-1',
  objectLock: { mode: 'COMPLIANCE', retentionDays: 30 },
}

test('publishes payload before manifest under Object Lock and verifies the downloaded replica', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-s3-test-'))
  const passphrase = Buffer.from('correct horse battery staple')
  try {
    const backup = await recoveryPackage(directory, passphrase)
    const client = new MemoryS3()
    const result = await replicateBackupToS3(backup, target, passphrase, new Date('2026-08-11T12:00:00.000Z'), client)
    assert.deepEqual(client.puts.map((request) => request.key), [
      'logical/scheduled.forge-backup',
      'logical/scheduled.forge-backup.json',
    ])
    assert.equal(client.puts.every((request) => request.objectLockMode === 'COMPLIANCE'), true)
    assert.equal(client.puts[0]?.retainUntil.toISOString(), '2026-09-10T12:00:00.000Z')
    assert.equal(result.manifestLocation, 's3://forge-recovery-prod/logical/scheduled.forge-backup.json')
    assert.equal(result.type, 's3')
  } finally {
    passphrase.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
})

test('fails closed when the downloaded S3 payload does not authenticate', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-s3-tamper-'))
  const passphrase = Buffer.from('correct horse battery staple')
  try {
    const backup = await recoveryPackage(directory, passphrase)
    const client = new MemoryS3()
    client.tamperPayload = true
    await assert.rejects(
      replicateBackupToS3(backup, target, passphrase, new Date('2026-08-11T12:00:00.000Z'), client),
      /checksum|authentication/i,
    )
  } finally {
    passphrase.fill(0)
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects unsafe S3 manifest names before downloading', async () => {
  const client = new MemoryS3()
  await assert.rejects(
    fetchBackupFromS3(target, '../scheduled.forge-backup.json', os.tmpdir(), 'correct horse battery staple', client),
    /safe FORGE backup manifest/,
  )
  assert.equal(client.objects.size, 0)
})
