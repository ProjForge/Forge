import assert from 'node:assert/strict'
import test from 'node:test'
import { backupLabel, requireDatabaseUrl, safeConnection, validatePassphrase } from '../../src/config.js'

test('generates filesystem-safe deterministic backup labels', () => {
  assert.equal(backupLabel(undefined, new Date('2026-08-11T12:34:56.789Z')), 'forge-2026-08-11T12-34-56-789Z')
  assert.equal(backupLabel('nightly_01'), 'nightly_01')
  assert.throws(() => backupLabel('../escape'), /Backup label/)
})

test('requires complete PostgreSQL URLs', () => {
  assert.equal(requireDatabaseUrl('postgresql://user@localhost/forge', 'URL'), 'postgresql://user@localhost/forge')
  assert.throws(() => requireDatabaseUrl('https://localhost/forge', 'URL'), /PostgreSQL URL/)
  assert.throws(() => requireDatabaseUrl('postgresql://localhost', 'URL'), /host and database/)
})

test('keeps database passwords out of process arguments', () => {
  const result = safeConnection('postgresql://forge_user:p%40ssword@127.0.0.1:5432/forge?sslmode=require')
  assert.equal(result.connectionArgument.includes('p%40ssword'), false)
  assert.equal(result.connectionArgument.includes('forge_user'), true)
  assert.equal(result.environment.PGPASSWORD, 'p@ssword')
})

test('rejects weak backup passphrases', () => {
  assert.throws(() => validatePassphrase('too-short'), /at least 20 bytes/)
  const value = validatePassphrase('correct horse battery staple')
  assert.equal(value.toString('utf8'), 'correct horse battery staple')
  value.fill(0)
})
