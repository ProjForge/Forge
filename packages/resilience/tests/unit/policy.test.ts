import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { parseRecoveryPolicy, parseRecoveryPolicyDocument, pruneBackups, settleReplicaOperations } from '../../src/policy.js'
import type { ReplicatedPackage } from '../../src/types.js'

function manifest(createdAt: string, label: string): unknown {
  return {
    format: 'forge-resilience-backup', formatVersion: 1, createdAt,
    source: {
      databaseName: 'forge', serverVersion: '18.4', serverVersionNumber: 180004,
      schemaVersion: '0.1.3', vectorVersion: null, extensions: { pgcrypto: '1.3' },
      migrations: [{ name: '0001_forge_core.sql', checksum: 'b'.repeat(64) }], tableCounts: { projects: '1' },
    },
    tool: { pgDumpVersion: 'pg_dump (PostgreSQL) 18.4', forgeResilienceVersion: '0.2.0' },
    encryption: {
      cipher: 'aes-256-gcm', kdf: 'scrypt', salt: 'c2FsdA==', iv: 'aXY=', authTag: 'dGFn',
      parameters: { N: 32768, r: 8, p: 1, keyLength: 32 },
    },
    payload: { file: `${label}.forge-backup`, sha256: 'a'.repeat(64), bytes: 1 },
  }
}

test('parses absolute, unique and bounded recovery policy values', () => {
  const root = path.resolve(os.tmpdir(), 'forge-policy')
  const parsed = parseRecoveryPolicy({
    version: 1,
    outputDirectory: path.join(root, 'primary'),
    replicas: [{ name: 'offline-a', path: path.join(root, 'replica') }],
    retention: { keepLast: 3, maxAgeHours: 168 },
    labelPrefix: 'nightly',
  })
  assert.equal(parsed.retention.keepLast, 3)
  assert.equal(parsed.replicas[0]?.type, 'filesystem')
  assert.equal(parsed.replicas[0]?.name, 'offline-a')
  assert.throws(() => parseRecoveryPolicy({ ...parsed, replicas: [] }), /at least one/)
  assert.throws(() => parseRecoveryPolicy({ ...parsed, outputDirectory: 'relative' }), /absolute/)
  assert.throws(() => parseRecoveryPolicy({ ...parsed, replicas: [...parsed.replicas, parsed.replicas[0]!] }), /duplicate/i)
  assert.throws(() => parseRecoveryPolicy({
    ...parsed,
    replicas: [{ name: 'same', path: parsed.outputDirectory }],
  }), /must differ/)
  assert.equal(parseRecoveryPolicyDocument(`\uFEFF${JSON.stringify(parsed)}`).version, 1)
  assert.throws(() => parseRecoveryPolicyDocument(`garbage${JSON.stringify(parsed)}`), /Unexpected token/)
})

test('parses immutable S3 targets without accepting credentials in policy JSON', () => {
  const root = path.resolve(os.tmpdir(), 'forge-policy-s3')
  const source = {
    version: 1,
    outputDirectory: path.join(root, 'primary'),
    replicas: [{
      name: 'offsite',
      type: 's3',
      bucket: 'forge-recovery-prod',
      prefix: 'logical/eu-west-1',
      region: 'eu-west-1',
      endpoint: 'https://s3.example.invalid',
      forcePathStyle: true,
      objectLock: { mode: 'compliance', retentionDays: 30 },
    }],
    retention: { keepLast: 3 },
  }
  const parsed = parseRecoveryPolicy(source)
  const target = parsed.replicas[0]
  assert.equal(target?.type, 's3')
  if (target?.type !== 's3') throw new Error('Expected S3 target')
  assert.equal(target.objectLock.mode, 'COMPLIANCE')
  assert.equal(target.prefix, 'logical/eu-west-1')
  assert.throws(() => parseRecoveryPolicy({
    ...source,
    replicas: [{ ...source.replicas[0], credentials: { secretAccessKey: 'must-not-live-here' } }],
  }), /credentials must remain external/i)
  assert.throws(() => parseRecoveryPolicy({
    ...source,
    replicas: [{ ...source.replicas[0], endpoint: 'http://storage.example.com' }],
  }), /HTTPS/)
  assert.throws(() => parseRecoveryPolicy({
    ...source,
    replicas: [{ ...source.replicas[0], prefix: '../escape' }],
  }), /prefix/)
})

test('retention keeps the newest floor and recent packages while ignoring malformed files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-retention-'))
  const now = new Date('2026-08-11T12:00:00.000Z')
  try {
    for (const [label, createdAt] of [
      ['newest', '2026-08-11T11:00:00.000Z'],
      ['recent', '2026-08-10T12:00:00.000Z'],
      ['old', '2026-07-01T00:00:00.000Z'],
    ] as const) {
      await writeFile(path.join(directory, `${label}.forge-backup`), label)
      await writeFile(path.join(directory, `${label}.forge-backup.json`), JSON.stringify(manifest(createdAt, label)))
    }
    await writeFile(path.join(directory, 'foreign.forge-backup.json'), '{broken')
    const removed = await pruneBackups(directory, { keepLast: 1, maxAgeHours: 48 }, now)
    assert.deepEqual(removed.map((file) => path.basename(file)).sort(), ['old.forge-backup', 'old.forge-backup.json'])
    assert.equal(await readFile(path.join(directory, 'foreign.forge-backup.json'), 'utf8'), '{broken')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('waits for every concurrent replica before reporting a failure', async () => {
  let slowReplicaFinished = false
  const slowReplica = new Promise<ReplicatedPackage>((resolve) => {
    setTimeout(() => {
      slowReplicaFinished = true
      resolve({
        target: 'slow', type: 'filesystem', manifestLocation: 'slow.json', payloadLocation: 'slow',
        manifestPath: 'slow.json', payloadPath: 'slow',
      })
    }, 20)
  })
  const failedReplica = Promise.reject<ReplicatedPackage>(new Error('replica failed'))
  await assert.rejects(settleReplicaOperations([slowReplica, failedReplica]), /replica failed/)
  assert.equal(slowReplicaFinished, true)
})
