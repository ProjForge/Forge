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
    registerProject: async () => project,
    remember: async () => { throw new Error('unused') },
    saveDecision: async () => { throw new Error('unused') },
    createTask: async () => { throw new Error('unused') },
    updateTaskStatus: async () => { throw new Error('unused') },
  } satisfies WorkbenchGateway
  const searchPort: TextSearchPort = { search: async () => [] }
  const service = new ForgeWorkbenchService(gateway, searchPort)
  assert.deepEqual(await service.projects(), [project])
  assert.deepEqual(await service.catalog(project.id), { memories: [], decisions: [], tasks: [], executions: [] })
  assert.deepEqual(calls, [`memories:${project.id}:50`, `decisions:${project.id}:50`, `tasks:${project.id}:50`, `executions:${project.id}:50`])
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
    registerProject: async () => project,
    remember: async () => { throw new Error('unused') },
    saveDecision: async () => { throw new Error('unused') },
    createTask: async () => { throw new Error('unused') },
    updateTaskStatus: async () => { throw new Error('unused') },
  } satisfies WorkbenchGateway
  const service = new ForgeWorkbenchService(gateway, { search: async (input) => { observed = input; return [] } })
  await service.search({ projectId: project.id, query: 'decisión', sourceKinds: ['decision'], limit: 10, rerank: true })
  assert.deepEqual(observed, { projectId: project.id, query: 'decisión', sourceKinds: ['decision'], limit: 10, rerank: true })
})
