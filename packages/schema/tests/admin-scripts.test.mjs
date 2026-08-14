import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { quoteIdentifier, requiredSecret, validateIdentifier } from '../scripts/admin-helpers.mjs'

test('validates deployment-neutral PostgreSQL identifiers', () => {
  assert.equal(validateIdentifier('forge_runtime', 'role'), 'forge_runtime')
  assert.throws(() => validateIdentifier('Forge Runtime', 'role'), /lowercase PostgreSQL identifier/)
  assert.throws(() => validateIdentifier('x;drop_database', 'role'), /lowercase PostgreSQL identifier/)
  assert.equal(quoteIdentifier('a"b'), '"a""b"')
})

test('requires runtime secrets without exposing their value', () => {
  assert.equal(requiredSecret({ SECRET: 'correct-horse' }, 'SECRET'), 'correct-horse')
  assert.throws(() => requiredSecret({ SECRET: 'short' }, 'SECRET'), /^Error: SECRET must contain/)
})

test('types format parameters explicitly for PostgreSQL 14', () => {
  const source = readFileSync(new URL('../scripts/configure-runtime-role.mjs', import.meta.url), 'utf8')
  assert.match(source, /format\([^\n]+\$1::text, \$2::text\)/)
})
