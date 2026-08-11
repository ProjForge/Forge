import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { createWorkbenchServer } from '../src/server.js'
import type { ForgeWorkbenchService } from '../src/service.js'

const projectId = '11111111-1111-4111-8111-111111111111'

test('serves the loopback API with token and origin protections', async (context) => {
  const service = {
    status: async () => ({ serverVersion: '18.4', schemaVersion: '0.1.3', vectorVersion: '0.8.2' }),
    projects: async () => [],
    catalog: async () => ({ memories: [], decisions: [] }),
  } as unknown as ForgeWorkbenchService
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url))
  const server = createWorkbenchServer(service, { publicDir, token: 'test-token' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`

  const bootstrap = await fetch(`${base}/api/bootstrap`)
  assert.equal(bootstrap.status, 200)
  assert.equal((await bootstrap.json()).token, 'test-token')

  const unauthorized = await fetch(`${base}/api/projects`)
  assert.equal(unauthorized.status, 401)

  const rejected = await fetch(`${base}/api/projects`, { headers: { origin: 'https://attacker.example', 'x-forge-token': 'test-token' } })
  assert.equal(rejected.status, 403)

  const allowed = await fetch(`${base}/api/projects`, { headers: { origin: base, 'x-forge-token': 'test-token' } })
  assert.equal(allowed.status, 200)
  assert.deepEqual(await allowed.json(), { result: [] })
})

test('rejects malformed project scope before invoking search', async (context) => {
  let called = false
  const service = { search: async () => { called = true; return [] } } as unknown as ForgeWorkbenchService
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url))
  const server = createWorkbenchServer(service, { publicDir, token: 'test-token' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const port = (server.address() as AddressInfo).port
  const response = await fetch(`http://127.0.0.1:${port}/api/search`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forge-token': 'test-token' },
    body: JSON.stringify({ projectId: 'not-a-uuid', query: 'test' }),
  })
  assert.equal(response.status, 400)
  assert.equal(called, false)
  assert.equal((await response.json()).error.code, 'INVALID_REQUEST')
  assert.notEqual(projectId, 'not-a-uuid')
})
