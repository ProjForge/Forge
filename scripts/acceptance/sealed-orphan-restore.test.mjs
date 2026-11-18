import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sealedTargets } from './sealed-orphan-restore.mjs'

const admin = 'postgresql://forge_pilot:' + 'a'.repeat(64) + '@127.0.0.1:55441/forge_coordinator_pilot'
const state = admin.replace(/pilot$/, 'state')
const runtime = admin.replace('forge_pilot:' + 'a'.repeat(64), 'forge_runtime:' + 'b'.repeat(32))

test('sealed restore derives its limited Core URL from the checked admin endpoint', () => {
  const targets = sealedTargets(admin, state, runtime)
  assert.equal(targets.runtimeUrl, runtime)
})

test('sealed restore rejects out-of-scope URLs without opening any connections', () => {
  for (const candidate of [
    runtime.replace('127.0.0.1', '192.0.2.10'),
    runtime.replace('127.0.0.1', 'localhost'),
    runtime.replace('127.0.0.1', '127.1'),
    runtime.replace('127.0.0.1', '[::1]'),
    runtime.replace(':55441', ':55442'),
    runtime.replace(/pilot$/, 'state'),
    runtime.replace('forge_runtime', 'forge_pilot'),
    runtime + '?host=192.0.2.10',
    runtime + '?options=-c%20role=forge_pilot',
    runtime + '#fragment',
    runtime + '\n',
    runtime.replace('postgresql:', 'https:'),
  ]) assert.throws(() => sealedTargets(admin, state, candidate), /Invalid sealed fixture database URL/)
  assert.throws(() => sealedTargets(admin + '?service=other', state, runtime), /Invalid sealed fixture database URL/)
  assert.throws(() => sealedTargets(admin, state.replace(':55441', ':55442'), runtime), /Invalid sealed fixture database URL/)
  assert.throws(() => sealedTargets(admin, state.replace('a'.repeat(64), 'c'.repeat(64)), runtime), /credentials differ/)
})

test('publisher entry point rejects direct invocation', () => {
  const entry = new URL('./sealed-orphan-restore.mjs', import.meta.url)
  const result = spawnSync(process.execPath, [fileURLToPath(entry)], { timeout: 5000 })
  assert.ifError(result.error)
  assert.equal(result.status, 1)
})