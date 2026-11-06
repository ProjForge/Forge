import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalOperationalHealth } from '../src/operational-health.js'

test('provider failure, missing model and recovery preserve sanitized partial health', async () => {
  let mode = 0
  const fetcher = (async () => {
    if (mode === 0) throw new Error('password=secret')
    if (mode === 3) return Response.json({ data: [{ id: 'x'.repeat(70_000) }] })
    return Response.json({ data: mode === 1 ? [] : [{ id: 'embedding' }] })
  }) as typeof fetch
  const health = new LocalOperationalHealth({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'embedding' }, fetcher)
  const failed = await health.read()
  assert.equal(failed.semantic.state, 'failed')
  assert.doesNotMatch(JSON.stringify(failed), /secret|password/)
  mode = 1
  assert.equal((await health.read()).semantic.state, 'degraded')
  mode = 2
  assert.equal((await health.read()).semantic.state, 'healthy')
  mode = 3
  assert.equal((await health.read()).semantic.state, 'failed')
})

test('worker state expires and failures never expose raw errors', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'forge-worker-health-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const statusPath = join(root, 'worker.json')
  const now = new Date('2026-11-06T12:00:00Z')
  const health = new LocalOperationalHealth({ baseUrl: 'http://localhost/v1', model: 'm', statusPath },
    (async () => { throw new DOMException('timeout', 'TimeoutError') }) as typeof fetch, () => now)
  await writeFile(statusPath, JSON.stringify({ status: 'PASS', updatedAt: '2026-08-14T00:00:00Z' }))
  assert.equal((await health.read()).indexing.state, 'degraded')
  await writeFile(statusPath, JSON.stringify({ status: 'FAIL', updatedAt: now.toISOString(), message: 'secret' }))
  const failed = await health.read()
  assert.equal(failed.indexing.state, 'failed')
  assert.doesNotMatch(JSON.stringify(failed), /secret/)
  await writeFile(statusPath, JSON.stringify({ status: 'PASS', updatedAt: now.toISOString() }))
  assert.equal((await health.read()).indexing.state, 'healthy')
})
