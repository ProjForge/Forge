import assert from 'node:assert/strict'
import test from 'node:test'
import { authenticatedCore, canonicalJson, parseManifest } from '../../src/manifest.js'

const manifest = {
  format: 'forge-resilience-backup',
  formatVersion: 1,
  createdAt: '2026-08-11T00:00:00.000Z',
  source: {
    databaseName: 'forge',
    serverVersion: '18.4',
    serverVersionNumber: 180004,
    schemaVersion: '0.1.3',
    vectorVersion: '0.8.2',
    extensions: { pgcrypto: '1.3', vector: '0.8.2' },
    migrations: [{ name: '0001_forge_core.sql', checksum: 'b'.repeat(64) }],
    tableCounts: { projects: '1' },
  },
  tool: { pgDumpVersion: 'pg_dump (PostgreSQL) 18.4', forgeResilienceVersion: '0.2.0' },
  encryption: {
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: 'c2FsdA==',
    iv: 'aXY=',
    authTag: 'dGFn',
    parameters: { N: 32768, r: 8, p: 1, keyLength: 32 },
  },
  payload: { file: 'forge.forge-backup', sha256: 'a'.repeat(64), bytes: 42 },
} as const

test('parses supported manifests and authenticates immutable metadata', () => {
  const parsed = parseManifest(manifest)
  assert.equal(parsed.source.schemaVersion, '0.1.3')
  const core = authenticatedCore(parsed)
  assert.equal('authTag' in core.encryption, false)
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}')
})

test('rejects traversal and unsupported backup formats', () => {
  assert.throws(() => parseManifest({ ...manifest, payload: { ...manifest.payload, file: '../escape' } }), /file name/)
  assert.throws(() => parseManifest({ ...manifest, formatVersion: 2 }), /Unsupported/)
  assert.throws(() => parseManifest({
    ...manifest,
    encryption: { ...manifest.encryption, parameters: { ...manifest.encryption.parameters, N: 2 ** 30 } },
  }), /KDF parameters/)
})
