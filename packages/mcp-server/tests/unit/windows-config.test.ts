import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { databaseUrl, loadMcpWindowsConfig } from '../../src/windows-config.js'

test('loads the shared BOM-compatible runtime configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-mcp-config-'))
  try {
    writeFileSync(join(root, 'workbench.json'), `\uFEFF${JSON.stringify({ database: { host: '::1', port: 5433, name: 'forge db', user: 'runtime/user', credentialFile: 'runtime.dpapi' } })}`)
    const config = loadMcpWindowsConfig(root)
    assert.equal(config.credentialPath, join(root, 'runtime.dpapi'))
    assert.equal(databaseUrl(config, 'p@ss'), 'postgresql://runtime%2Fuser:p%40ss@[::1]:5433/forge%20db')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('rejects missing and malformed shared configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-mcp-config-invalid-'))
  try {
    assert.throws(() => loadMcpWindowsConfig(root), /Invalid shared FORGE configuration/)
    writeFileSync(join(root, 'workbench.json'), JSON.stringify({ database: { host: '', name: 'forge', user: 'runtime', credentialFile: 'x' } }))
    assert.throws(() => loadMcpWindowsConfig(root), /database.host/)
    writeFileSync(join(root, 'workbench.json'), JSON.stringify({ database: { host: 'localhost', name: 'forge', user: 'runtime', credentialFile: '..\\secret' } }))
    assert.throws(() => loadMcpWindowsConfig(root), /must be a file name/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
