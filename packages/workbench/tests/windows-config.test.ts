import assert from 'node:assert/strict'
import test from 'node:test'
import { databaseUrl, parseWindowsConfig, runtimeEnvironment } from '../src/windows-config.js'

test('parses per-user Windows configuration and applies safe defaults', () => {
  const config = parseWindowsConfig({ database: { host: 'db.local', name: 'forge', user: 'forge_runtime' } })
  assert.equal(config.database.port, 5432)
  assert.equal(config.database.credentialFile, 'workbench.dpapi')
  assert.equal(config.workbench.port, 7334)
  assert.equal(config.embedding.dimensions, 1024)
})

test('encodes PostgreSQL credentials and lets explicit process environment win', () => {
  const config = parseWindowsConfig({ database: { host: '::1', port: 5433, name: 'forge db', user: 'forge/user' } })
  assert.equal(databaseUrl(config.database, 'p@ss:word'), 'postgresql://forge%2Fuser:p%40ss%3Aword@[::1]:5433/forge%20db')
  const env = runtimeEnvironment(config, 'secret', { FORGE_WORKBENCH_PORT: '7444' })
  assert.equal(env.FORGE_WORKBENCH_PORT, '7444')
  assert.match(env.FORGE_DATABASE_URL!, /^postgresql:\/\//)
})

test('rejects invalid ports and blank identity values', () => {
  assert.throws(() => parseWindowsConfig({ database: { host: '', name: 'forge', user: 'runtime' } }), /database.host/)
  assert.throws(() => parseWindowsConfig({ database: { host: 'localhost', port: 70_000, name: 'forge', user: 'runtime' } }), /database.port/)
})
