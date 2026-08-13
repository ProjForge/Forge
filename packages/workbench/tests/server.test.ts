import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createWorkbenchServer } from '../src/server.js'
import type { ForgeWorkbenchService } from '../src/service.js'

const projectId = '11111111-1111-4111-8111-111111111111'

test('serves the loopback API with token and origin protections', async (context) => {
  const service = {
    status: async () => ({ serverVersion: '18.4', schemaVersion: '0.1.3', vectorVersion: '0.8.2' }),
    projects: async () => [],
    catalog: async () => ({ memories: [], decisions: [], tasks: [], executions: [] }),
  } as unknown as ForgeWorkbenchService
  const publicDir = path.resolve(process.cwd(), 'public')
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

  const favicon = await fetch(`${base}/brand/forge-favicon.svg`)
  assert.equal(favicon.status, 200)
  assert.equal(favicon.headers.get('content-type'), 'image/svg+xml')
  assert.match(await favicon.text(), /FORGE favicon/)

  const unapproved = await fetch(`${base}/brand/not-approved.svg`)
  assert.equal(unapproved.status, 404)
})

test('validates and forwards project-scoped human task workflow', async (context) => {
  const calls: unknown[] = []
  const taskId = '22222222-2222-4222-8222-222222222222'
  const task = { id: taskId, projectId, taskKey: 'TASK-1', title: 'Ship flow', objective: null, assignedAgentId: null, status: 'ready', priority: 'high', metadata: {}, version: 1, createdAt: '2026-08-14T00:00:00Z', updatedAt: '2026-08-14T00:00:00Z' }
  const service = {
    createTask: async (input: unknown) => { calls.push(input); return task },
    updateTaskStatus: async (input: unknown) => { calls.push(input); return { ...task, status: 'in_progress', version: 2 } },
  } as unknown as ForgeWorkbenchService
  const server = createWorkbenchServer(service, { publicDir: path.resolve(process.cwd(), 'public'), token: 'test-token' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = { 'content-type': 'application/json', 'x-forge-token': 'test-token' }
  const created = await fetch(`${base}/api/projects/${projectId}/tasks`, { method: 'POST', headers, body: JSON.stringify({ taskKey: 'TASK-1', title: 'Ship flow', priority: 'high', idempotencyKey: 'request-1' }) })
  assert.equal(created.status, 201)
  const updated = await fetch(`${base}/api/projects/${projectId}/tasks/${taskId}/status`, { method: 'PATCH', headers, body: JSON.stringify({ expectedVersion: 1, status: 'in_progress' }) })
  assert.equal(updated.status, 200)
  assert.deepEqual(calls, [
    { projectId, taskKey: 'TASK-1', title: 'Ship flow', status: 'ready', priority: 'high', idempotencyKey: 'request-1' },
    { projectId, taskId, expectedVersion: 1, status: 'in_progress' },
  ])
})

test('rejects malformed project scope before invoking search', async (context) => {
  let called = false
  const service = { search: async () => { called = true; return [] } } as unknown as ForgeWorkbenchService
  const publicDir = path.resolve(process.cwd(), 'public')
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
