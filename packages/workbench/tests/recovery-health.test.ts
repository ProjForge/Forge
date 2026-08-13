import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileRecoveryHealth } from '../src/recovery-health.js'

const now = new Date('2026-08-14T01:00:00.000Z')

test('reports authenticated logical and physical recovery as healthy without exposing paths', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-health-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const paths = {
    logicalStatusPath: join(root, 'logical.json'), pitrStatusPath: join(root, 'pitr.json'),
    walTransportStatusPath: join(root, 'wal.json'), baseBackupStatusPath: join(root, 'base.json'),
  }
  await writeFile(paths.logicalStatusPath, JSON.stringify({ status: 'ok', completedAt: '2026-08-14T00:30:00Z', manifestPath: 'secret-path', replicas: [{ target: 'disk' }, { target: 'cloud' }] }))
  await writeFile(paths.pitrStatusPath, `\uFEFF${JSON.stringify({ status: 'PASS', enabled: true, checkedAt: '2026-08-14T00:56:00Z', checks: [{ name: 'archive-state', status: 'PASS', detail: 'archive_mode=on' }] })}`)
  await writeFile(paths.walTransportStatusPath, JSON.stringify({ status: 'PASS', completedAt: '2026-08-14T00:55:00Z', packageOnly: false, results: [] }))
  await writeFile(paths.baseBackupStatusPath, JSON.stringify({ status: 'PASS', completedAt: '2026-08-13T23:00:00Z', packageOnly: false, result: {} }))

  const health = await new FileRecoveryHealth(paths, () => now).read()
  assert.equal(health.overall, 'healthy')
  assert.equal(health.logical.summary, '2 réplicas autenticadas.')
  assert.equal(health.pitr.checks?.[0]?.name, 'archive-state')
  assert.doesNotMatch(JSON.stringify(health), /secret-path|disk|cloud/)
})

test('fails closed for missing, malformed and explicitly failed status', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-health-failure-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const logicalStatusPath = join(root, 'missing.json')
  const pitrStatusPath = join(root, 'pitr.json')
  const walTransportStatusPath = join(root, 'wal.json')
  await writeFile(pitrStatusPath, '{invalid')
  await writeFile(walTransportStatusPath, JSON.stringify({ status: 'FAIL', completedAt: '2026-08-14T00:59:00Z', error: 'sensitive path' }))
  const health = await new FileRecoveryHealth({ logicalStatusPath, pitrStatusPath, walTransportStatusPath }, () => now).read()
  assert.equal(health.overall, 'failed')
  assert.equal(health.logical.state, 'failed')
  assert.equal(health.pitr.state, 'failed')
  assert.equal(health.walTransport.state, 'failed')
  assert.doesNotMatch(JSON.stringify(health), /sensitive path/)
})

test('degrades successful status outside its freshness window', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-health-stale-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const logicalStatusPath = join(root, 'logical.json')
  await writeFile(logicalStatusPath, JSON.stringify({ status: 'ok', completedAt: '2026-08-13T12:00:00Z', replicas: [{}] }))
  const health = await new FileRecoveryHealth({ logicalStatusPath }, () => now).read()
  assert.equal(health.overall, 'degraded')
  assert.equal(health.logical.state, 'degraded')
})
