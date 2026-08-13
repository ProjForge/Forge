import assert from 'node:assert/strict'
import test from 'node:test'
import { ForgeWorkbenchService, type TextSearchPort, type WorkbenchGateway } from '../src/service.js'

const project = {
  id: '11111111-1111-4111-8111-111111111111', projectKey: 'forge', name: 'FORGE', description: null,
  status: 'active' as const, metadata: {}, version: 1, createdAt: '2026-08-11T00:00:00Z', updatedAt: '2026-08-11T00:00:00Z',
}

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
