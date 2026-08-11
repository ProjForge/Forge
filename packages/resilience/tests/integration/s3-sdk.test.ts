import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fetchBackupFromS3, replicateBackupToS3 } from '../../src/s3.js'
import type { S3ReplicationTarget } from '../../src/types.js'
import { recoveryPackage } from '../support/recovery-package.js'

test('uses the real S3 SDK with checksum and Object Lock headers', async () => {
  const objects = new Map<string, Buffer>()
  const puts: Array<{
    path: string
    mode: string | undefined
    checksum: string | undefined
    checksumAlgorithm: string | undefined
  }> = []
  const server = createServer((request, response) => {
    const requestPath = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (request.method === 'PUT') {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        objects.set(requestPath, Buffer.concat(chunks))
        puts.push({
          path: requestPath,
          mode: request.headers['x-amz-object-lock-mode'] as string | undefined,
          checksum: request.headers['x-amz-checksum-sha256'] as string | undefined,
          checksumAlgorithm: request.headers['x-amz-sdk-checksum-algorithm'] as string | undefined,
        })
        response.statusCode = 200
        response.end()
      })
      return
    }
    if (request.method === 'GET') {
      const object = objects.get(requestPath)
      if (!object) {
        response.statusCode = 404
        response.end()
        return
      }
      response.statusCode = 200
      response.setHeader('content-length', object.length)
      response.end(object)
      return
    }
    response.statusCode = 405
    response.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TCP test server')
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-s3-sdk-'))
  const passphrase = Buffer.from('correct horse battery staple')
  const previous = {
    accessKey: process.env.AWS_ACCESS_KEY_ID,
    secret: process.env.AWS_SECRET_ACCESS_KEY,
  }
  process.env.AWS_ACCESS_KEY_ID = 'forge-test-access'
  process.env.AWS_SECRET_ACCESS_KEY = 'forge-test-secret'
  try {
    const backup = await recoveryPackage(directory, passphrase)
    const target: S3ReplicationTarget = {
      name: 'sdk-loopback', type: 's3', bucket: 'forge-recovery-test', prefix: 'logical',
      region: 'us-east-1', endpoint: `http://127.0.0.1:${address.port}`, forcePathStyle: true,
      objectLock: { mode: 'GOVERNANCE', retentionDays: 1 },
    }
    const result = await replicateBackupToS3(backup, target, passphrase, new Date('2026-08-11T12:00:00.000Z'))
    assert.equal(result.type, 's3')
    assert.deepEqual(puts.map((entry) => entry.path), [
      '/forge-recovery-test/logical/scheduled.forge-backup',
      '/forge-recovery-test/logical/scheduled.forge-backup.json',
    ])
    assert.equal(puts.every((entry) => entry.mode === 'GOVERNANCE'), true)
    assert.equal(puts.every((entry) => typeof entry.checksum === 'string' && entry.checksum.length > 20), true)
    assert.equal(puts.every((entry) => entry.checksumAlgorithm === 'SHA256'), true)
    const fetched = await fetchBackupFromS3(
      target,
      'scheduled.forge-backup.json',
      path.join(directory, 'fetched'),
      passphrase,
    )
    assert.deepEqual(await readFile(fetched.payloadPath), await readFile(backup.payloadPath))
    assert.deepEqual(await readFile(fetched.manifestPath), await readFile(backup.manifestPath))
  } finally {
    if (previous.accessKey === undefined) delete process.env.AWS_ACCESS_KEY_ID
    else process.env.AWS_ACCESS_KEY_ID = previous.accessKey
    if (previous.secret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY
    else process.env.AWS_SECRET_ACCESS_KEY = previous.secret
    passphrase.fill(0)
    await rm(directory, { recursive: true, force: true })
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
