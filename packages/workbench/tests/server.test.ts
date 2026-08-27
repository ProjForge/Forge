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
    catalog: async () => ({ memories: [], decisions: [], tasks: [], executions: [], agents: [], contextPackages: [] }),
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

  const index = await (await fetch(base)).text()
  assert.match(index, /class="workspace-tabs"/)
  assert.match(index, /data-view="overview"/)
  assert.match(index, /Siguiente paso recomendado/)
  assert.match(index, /data-action-views="overview operation"/)
  assert.match(index, /id="workspace-message"/)
  assert.match(index, />Trabajo<\/strong><small>Tareas y agentes/)
  assert.match(index, /id="metric-open-tasks"/)
  assert.match(index, /data-views="operation knowledge continuity"/)
  assert.match(index, /id="import-project"/)
  assert.match(index, /id="export-project"/)
  assert.match(index, /id="import-dialog"/)

  const client = await (await fetch(`${base}/app.js`)).text()
  assert.match(client, /function setView\(view\)/)
  assert.match(client, /function renderNextStep\(\)/)
  assert.match(client, /function showSearchMessage\(message, error = false\)/)
  assert.match(client, /metric-running-executions/)
  assert.match(client, /\/api\/imports\/repository/)
  assert.match(client, /\/api\/imports\/forge-project/)

  const styles = await (await fetch(`${base}/styles.css`)).text()
  assert.match(styles, /\.project-stats/)
  assert.match(styles, /\[hidden\]/)
})

test('exports downloadable bundles and validates portable imports before forwarding', async (context) => {
  const calls: unknown[] = []
  const payload = {
    formatVersion: 1 as const,
    sourceSchemaVersion: '0.1.3' as const,
    project: { projectKey: 'portable-app', name: 'Portable App', description: null, metadata: {} },
    agents: [], tasks: [], memories: [], decisions: [],
    omitted: ['embeddings', 'executions', 'context_packages', 'events', 'audit_log'] as const,
  }
  const { createPortableProjectBundle } = await import('../src/project-portability.js')
  const bundle = createPortableProjectBundle(payload, '2026-08-21T00:00:00.000Z')
  const service = {
    exportProject: async (scope: string) => { calls.push({ export: scope }); return bundle },
    importProject: async (input: unknown) => { calls.push(input); return { project: { id: projectId }, imported: {} } },
  } as unknown as ForgeWorkbenchService
  const server = createWorkbenchServer(service, { publicDir: path.resolve(process.cwd(), 'public'), token: 'test-token' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = { 'content-type': 'application/json', 'x-forge-token': 'test-token' }

  const exported = await fetch(`${base}/api/projects/${projectId}/export`, { headers })
  assert.equal(exported.status, 200)
  assert.equal(exported.headers.get('content-type'), 'application/vnd.forge.project+json; charset=utf-8')
  assert.match(exported.headers.get('content-disposition') ?? '', /portable-app\.forge-project/)
  assert.deepEqual(await exported.json(), bundle)

  const imported = await fetch(`${base}/api/imports/forge-project`, {
    method: 'POST', headers,
    body: JSON.stringify({ bundle, targetProjectKey: 'portable-copy', targetProjectName: 'Portable Copy', mode: 'create', idempotencyKey: 'import-1' }),
  })
  assert.equal(imported.status, 201)
  assert.deepEqual(calls[0], { export: projectId })
  assert.deepEqual(calls[1], { bundle, targetProjectKey: 'portable-copy', targetProjectName: 'Portable Copy', mode: 'create', idempotencyKey: 'import-1' })
})

test('forwards bounded repository onboarding requests', async (context) => {
  let observed: unknown
  const service = {
    onboardProject: async (input: unknown) => { observed = input; return { project: { id: projectId }, imported: { memories: 1 } } },
  } as unknown as ForgeWorkbenchService
  const server = createWorkbenchServer(service, { publicDir: path.resolve(process.cwd(), 'public'), token: 'test-token' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const response = await fetch(`${base}/api/imports/repository`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-forge-token': 'test-token' },
    body: JSON.stringify({ projectKey: 'existing-app', name: 'Existing App', files: [{ path: 'README.md', content: '# Existing App' }], idempotencyKey: 'repository-1' }),
  })
  assert.equal(response.status, 201)
  assert.deepEqual(observed, { projectKey: 'existing-app', name: 'Existing App', files: [{ path: 'README.md', content: '# Existing App' }], idempotencyKey: 'repository-1' })
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

test('validates agent assignment and project-scoped continuation inspection', async (context) => {
  const calls: unknown[] = []
  const taskId = '22222222-2222-4222-8222-222222222222'
  const agentId = '33333333-3333-4333-8333-333333333333'
  const packageId = '44444444-4444-4444-8444-444444444444'
  const service = {
    registerAndAssignAgent: async (input: unknown) => { calls.push(input); return { agent: { id: agentId }, assignment: { projectId, agentId } } },
    updateTaskAssignment: async (input: unknown) => { calls.push(input); return { id: taskId, assignedAgentId: agentId, version: 2 } },
    continuation: async (scope: string, id: string) => { calls.push({ projectId: scope, packageId: id }); return { packageId: id, projectId: scope } },
  } as unknown as ForgeWorkbenchService
  const server = createWorkbenchServer(service, { publicDir: path.resolve(process.cwd(), 'public'), token: 'test-token' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = { 'content-type': 'application/json', 'x-forge-token': 'test-token' }

  const assigned = await fetch(`${base}/api/projects/${projectId}/agents`, {
    method: 'POST', headers, body: JSON.stringify({ agentKey: 'codex-main', name: 'Codex', role: 'engineer', assignmentRole: 'maintainer' }),
  })
  assert.equal(assigned.status, 201)
  const taskAssignment = await fetch(`${base}/api/projects/${projectId}/tasks/${taskId}/assignment`, {
    method: 'PATCH', headers, body: JSON.stringify({ expectedVersion: 1, assignedAgentId: agentId }),
  })
  assert.equal(taskAssignment.status, 200)
  const inspected = await fetch(`${base}/api/projects/${projectId}/context-packages/${packageId}`, { headers })
  assert.equal(inspected.status, 200)
  assert.deepEqual(calls, [
    { projectId, agentKey: 'codex-main', name: 'Codex', role: 'engineer', assignmentRole: 'maintainer' },
    { projectId, taskId, expectedVersion: 1, assignedAgentId: agentId },
    { projectId, packageId },
  ])

  const rejected = await fetch(`${base}/api/projects/${projectId}/tasks/${taskId}/assignment`, {
    method: 'PATCH', headers, body: JSON.stringify({ expectedVersion: 1, assignedAgentId: 'not-a-uuid' }),
  })
  assert.equal(rejected.status, 400)
})

test('validates and forwards the complete human execution lifecycle', async (context) => {
  const calls: unknown[] = []
  const taskId = '22222222-2222-4222-8222-222222222222'
  const agentId = '33333333-3333-4333-8333-333333333333'
  const executionId = '44444444-4444-4444-8444-444444444444'
  const service = {
    startExecution: async (input: unknown) => { calls.push(input); return { id: executionId, version: 1, status: 'running' } },
    compileContinuation: async (input: unknown) => { calls.push(input); return { packageId: '55555555-5555-4555-8555-555555555555' } },
    finishExecution: async (input: unknown) => { calls.push(input); return { id: executionId, version: 2, status: 'succeeded' } },
  } as unknown as ForgeWorkbenchService
  const server = createWorkbenchServer(service, { publicDir: path.resolve(process.cwd(), 'public'), token: 'test-token' })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const headers = { 'content-type': 'application/json', 'x-forge-token': 'test-token' }

  assert.equal((await fetch(`${base}/api/projects/${projectId}/tasks/${taskId}/executions`, {
    method: 'POST', headers, body: JSON.stringify({ agentId, executionKey: 'human:TASK-1:request', policyVersion: 'workbench-human-v1', idempotencyKey: 'request' }),
  })).status, 201)
  assert.equal((await fetch(`${base}/api/projects/${projectId}/executions/${executionId}/continuation`, {
    method: 'POST', headers, body: JSON.stringify({ taskId, agentId, idempotencyKey: 'context-request' }),
  })).status, 201)
  assert.equal((await fetch(`${base}/api/projects/${projectId}/executions/${executionId}/status`, {
    method: 'PATCH', headers, body: JSON.stringify({ agentId, expectedVersion: 1, status: 'succeeded' }),
  })).status, 200)
  assert.deepEqual(calls, [
    { projectId, taskId, agentId, executionKey: 'human:TASK-1:request', policyVersion: 'workbench-human-v1', idempotencyKey: 'request' },
    { projectId, executionId, taskId, agentId, idempotencyKey: 'context-request' },
    { projectId, executionId, agentId, expectedVersion: 1, status: 'succeeded' },
  ])

  const invalid = await fetch(`${base}/api/projects/${projectId}/executions/${executionId}/status`, {
    method: 'PATCH', headers, body: JSON.stringify({ agentId, expectedVersion: 1, status: 'running' }),
  })
  assert.equal(invalid.status, 400)
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
