import assert from 'node:assert/strict'
import test from 'node:test'
import { ForgeWorkbenchService, type TextSearchPort, type WorkbenchGateway } from '../src/service.js'

const project = {
  id: '11111111-1111-4111-8111-111111111111', projectKey: 'forge', name: 'FORGE', description: null,
  status: 'active' as const, metadata: {}, version: 1, createdAt: '2026-08-11T00:00:00Z', updatedAt: '2026-08-11T00:00:00Z',
}

test('composes database and recovery health without exposing the filesystem reader', async () => {
  const gateway = { assertReady: async () => ({ serverVersion: '18.4', schemaVersion: '0.1.3', vectorVersion: '0.8.2' }) } as unknown as WorkbenchGateway
  const recovery = { overall: 'healthy' as const, logical: { state: 'healthy' as const, updatedAt: '2026-08-14T00:00:00Z', summary: 'ok' }, pitr: { state: 'healthy' as const, updatedAt: '2026-08-14T00:00:00Z', summary: 'ok' }, walTransport: { state: 'healthy' as const, updatedAt: '2026-08-14T00:00:00Z', summary: 'ok' }, baseBackup: { state: 'healthy' as const, updatedAt: '2026-08-14T00:00:00Z', summary: 'ok' } }
  const service = new ForgeWorkbenchService(gateway, { search: async () => [] }, { read: async () => recovery })
  assert.deepEqual(await service.status(), { serverVersion: '18.4', schemaVersion: '0.1.3', vectorVersion: '0.8.2', recovery })
})

test('composes bounded project catalogs without bypassing the gateway', async () => {
  const calls: string[] = []
  const gateway = {
    assertReady: async () => ({ serverVersion: '18.4', schemaVersion: '0.1.3', vectorVersion: '0.8.2' }),
    listProjects: async () => ({ items: [project], nextCursor: null }),
    listMemories: async (input) => { calls.push(`memories:${input.projectId}:${input.limit}`); return { items: [], nextCursor: null } },
    listDecisions: async (input) => { calls.push(`decisions:${input.projectId}:${input.limit}`); return { items: [], nextCursor: null } },
    listTasks: async (input) => { calls.push(`tasks:${input.projectId}:${input.limit}`); return { items: [], nextCursor: null } },
    listExecutions: async (input) => { calls.push(`executions:${input.projectId}:${input.limit}`); return { items: [], nextCursor: null } },
    listProjectAgents: async (input) => { calls.push(`agents:${input.projectId}:${input.limit}`); return { items: [], nextCursor: null } },
    listContinuationPackages: async (input) => { calls.push(`contexts:${input.projectId}:${input.limit}`); return { items: [], nextCursor: null } },
    registerProject: async () => project,
    registerAgent: async () => { throw new Error('unused') },
    assignAgent: async () => { throw new Error('unused') },
    remember: async () => { throw new Error('unused') },
    saveDecision: async () => { throw new Error('unused') },
    createTask: async () => { throw new Error('unused') },
    updateTaskStatus: async () => { throw new Error('unused') },
    updateTaskAssignment: async () => { throw new Error('unused') },
    loadContinuationContext: async () => { throw new Error('unused') },
    startExecution: async () => { throw new Error('unused') },
    compileContinuationContext: async () => { throw new Error('unused') },
    finishExecution: async () => { throw new Error('unused') },
    exportPortableProject: async () => { throw new Error('unused') },
    importPortableProject: async () => { throw new Error('unused') },
  } satisfies WorkbenchGateway
  const searchPort: TextSearchPort = { search: async () => [] }
  const service = new ForgeWorkbenchService(gateway, searchPort)
  assert.deepEqual(await service.projects(), [project])
  assert.deepEqual(await service.catalog(project.id), {
    memories: [], decisions: [], tasks: [], executions: [], agents: [], contextPackages: [],
  })
  assert.deepEqual(calls, [
    `memories:${project.id}:50`, `decisions:${project.id}:50`, `tasks:${project.id}:50`,
    `executions:${project.id}:50`, `agents:${project.id}:50`, `contexts:${project.id}:50`,
  ])
})

test('forwards precision mode to the semantic bridge unchanged', async () => {
  let observed: unknown
  const gateway = {
    assertReady: async () => ({ serverVersion: '18.4', schemaVersion: '0.1.3', vectorVersion: '0.8.2' }),
    listProjects: async () => ({ items: [], nextCursor: null }),
    listMemories: async () => ({ items: [], nextCursor: null }),
    listDecisions: async () => ({ items: [], nextCursor: null }),
    listTasks: async () => ({ items: [], nextCursor: null }),
    listExecutions: async () => ({ items: [], nextCursor: null }),
    listProjectAgents: async () => ({ items: [], nextCursor: null }),
    listContinuationPackages: async () => ({ items: [], nextCursor: null }),
    registerProject: async () => project,
    registerAgent: async () => { throw new Error('unused') },
    assignAgent: async () => { throw new Error('unused') },
    remember: async () => { throw new Error('unused') },
    saveDecision: async () => { throw new Error('unused') },
    createTask: async () => { throw new Error('unused') },
    updateTaskStatus: async () => { throw new Error('unused') },
    updateTaskAssignment: async () => { throw new Error('unused') },
    loadContinuationContext: async () => { throw new Error('unused') },
    startExecution: async () => { throw new Error('unused') },
    compileContinuationContext: async () => { throw new Error('unused') },
    finishExecution: async () => { throw new Error('unused') },
    exportPortableProject: async () => { throw new Error('unused') },
    importPortableProject: async () => { throw new Error('unused') },
  } satisfies WorkbenchGateway
  const service = new ForgeWorkbenchService(gateway, { search: async (input) => { observed = input; return [] } })
  await service.search({ projectId: project.id, query: 'decisión', sourceKinds: ['decision'], limit: 10, rerank: true })
  assert.deepEqual(observed, { projectId: project.id, query: 'decisión', sourceKinds: ['decision'], limit: 10, rerank: true })
})

test('forwards the execution lifecycle through the gateway contracts', async () => {
  const calls: unknown[] = []
  const execution = { id: '22222222-2222-4222-8222-222222222222', status: 'running' as const }
  const contextPackage = { packageId: '33333333-3333-4333-8333-333333333333' }
  const gateway = {
    startExecution: async (input: unknown) => { calls.push(input); return execution },
    compileContinuationContext: async (input: unknown) => { calls.push(input); return contextPackage },
    finishExecution: async (input: unknown) => { calls.push(input); return { ...execution, status: 'succeeded' as const } },
  } as unknown as WorkbenchGateway
  const service = new ForgeWorkbenchService(gateway, { search: async () => [] })
  const start = { projectId: project.id, taskId: '44444444-4444-4444-8444-444444444444', agentId: '55555555-5555-4555-8555-555555555555', executionKey: 'human:TASK-1:request', idempotencyKey: 'request' }
  await service.startExecution(start)
  const compile = { ...start, executionId: execution.id }
  await service.compileContinuation(compile)
  const finish = { projectId: project.id, executionId: execution.id, agentId: start.agentId, expectedVersion: 1, status: 'succeeded' as const }
  await service.finishExecution(finish)
  assert.deepEqual(calls, [start, compile, finish])
})

test('exports verified bundles and imports repository onboarding atomically through the gateway', async () => {
  const calls: unknown[] = []
  const payload = {
    formatVersion: 1 as const,
    sourceSchemaVersion: '0.1.3' as const,
    project: { projectKey: 'existing-app', name: 'Existing App', description: null, metadata: {} },
    agents: [], tasks: [], memories: [], decisions: [],
    omitted: ['embeddings', 'executions', 'context_packages', 'events', 'audit_log'] as const,
  }
  const gateway = {
    exportPortableProject: async (scope: string) => { calls.push({ export: scope }); return payload },
    importPortableProject: async (input: unknown) => { calls.push(input); return { project, imported: { agents: 0, tasks: 0, memories: 1, decisions: 0 } } },
  } as unknown as WorkbenchGateway
  const service = new ForgeWorkbenchService(gateway, { search: async () => [] })
  const bundle = await service.exportProject(project.id)
  assert.equal(bundle.format, 'forge-project')
  assert.match(bundle.checksum.value, /^[0-9a-f]{64}$/)

  const onboarded = await service.onboardProject({
    projectKey: 'existing-app', name: 'Existing App', files: [{ path: 'README.md', content: '# Existing App' }], idempotencyKey: 'import-1',
  })
  assert.equal(onboarded.imported.memories, 1)
  assert.deepEqual(calls[0], { export: project.id })
  assert.equal((calls[1] as { mode: string }).mode, 'create')
  assert.equal((calls[1] as { payload: { memories: unknown[] } }).payload.memories.length, 1)
})
