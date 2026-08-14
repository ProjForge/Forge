import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  deriveConnectionUrl,
  namesForRun,
  parseConnectionUrl,
  redactSecrets,
  versionAtLeast,
} from './tencentdb-gate-lib.mjs'

test('requires a complete hostname-verified PostgreSQL URL', () => {
  const parsed = parseConnectionUrl('postgresql://admin:encoded@db.example:5432/postgres?sslmode=verify-full')
  assert.equal(parsed.hostname, 'db.example')
  assert.throws(() => parseConnectionUrl('postgresql://admin:encoded@db.example/postgres?sslmode=require'), /verify-full/)
  assert.throws(() => parseConnectionUrl('mysql://admin:encoded@db.example/postgres?sslmode=verify-full'), /PostgreSQL/)
})

test('derives isolated database identities while preserving TLS parameters', () => {
  const base = parseConnectionUrl('postgresql://admin:secret@db.example:5432/postgres?sslmode=verify-full&application_name=gate')
  const derived = new URL(deriveConnectionUrl(base, 'forge_tc_123', 'runtime_user', 'new secret'))
  assert.equal(derived.pathname, '/forge_tc_123')
  assert.equal(decodeURIComponent(derived.username), 'runtime_user')
  assert.equal(decodeURIComponent(derived.password), 'new secret')
  assert.equal(derived.searchParams.get('sslmode'), 'verify-full')
  assert.equal(derived.searchParams.get('application_name'), 'gate')
})

test('creates bounded PostgreSQL names from an external run id', () => {
  assert.deepEqual(namesForRun('GHA-123'), {
    database: 'forge_tc_gha_123',
    role: 'forge_tc_gha_123_runtime',
  })
  assert.throws(() => namesForRun('---'), /letters or numbers/)
})

test('compares extension versions numerically', () => {
  assert.equal(versionAtLeast('0.8.2', '0.8.2'), true)
  assert.equal(versionAtLeast('0.10.0', '0.8.2'), true)
  assert.equal(versionAtLeast('0.8.1', '0.8.2'), false)
  assert.equal(versionAtLeast('invalid', '0.8.2'), false)
})

test('redacts PostgreSQL URLs and named secrets', () => {
  const sanitized = redactSecrets('failed postgresql://admin:p%40ss@db/forge?sslmode=verify-full password=hunter2')
  assert.equal(sanitized.includes('p%40ss'), false)
  assert.equal(sanitized.includes('hunter2'), false)
})

test('keeps provider secrets out of setup steps and requires a private runner', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/tencentdb-compatibility.yml', import.meta.url), 'utf8')
  const install = workflow.indexOf('- run: npm ci')
  const gate = workflow.indexOf('- name: Run isolated TencentDB gate')
  const secret = workflow.indexOf('secrets.TENCENTDB_ADMIN_URL')
  assert.ok(install >= 0 && gate > install && secret > gate)
  assert.match(workflow, /runs-on: \[self-hosted, linux, x64, forge-tencentdb\]/)
  assert.doesNotMatch(workflow.slice(0, gate), /TENCENTDB_ADMIN_URL|TENCENTDB_RUNTIME_PASSWORD/)
})
