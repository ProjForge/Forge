import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'

const packageRoot = resolve(import.meta.dirname, '..')
const launcher = resolve(packageRoot, 'dist/codex.js')
const stderr = []
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [launcher],
  cwd: packageRoot,
  env: getDefaultEnvironment(),
  stderr: 'pipe',
})
transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)))

const client = new Client({ name: 'forge-codex-registration-check', version: '0.1.5' })

try {
  await client.connect(transport)
  const tools = await client.listTools()
  assert.equal(tools.tools.length, 27)
  const status = await client.callTool({ name: 'forge_status', arguments: {} })
  assert.ok('content' in status)
  assert.notEqual(status.isError, true, JSON.stringify(status.content))
  const runtime = status.structuredContent?.result
  assert.ok(runtime && typeof runtime === 'object')
  assert.equal(runtime.schemaVersion, '0.1.3')
  assert.match(stderr.join(''), /ready on stdio/)
  process.stdout.write(JSON.stringify({
    status: 'PASS',
    tools: tools.tools.length,
    schemaVersion: runtime.schemaVersion,
  }) + '\n')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const launcherOutput = stderr.join('').trim()
  process.stderr.write(
    'Codex registration check failed: ' + message
      + (launcherOutput ? '\n' + launcherOutput : '')
      + '\n',
  )
  process.exitCode = 1
} finally {
  await client.close().catch(() => undefined)
}
