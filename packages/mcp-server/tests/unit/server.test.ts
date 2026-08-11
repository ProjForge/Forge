import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { NotFoundError } from 'forge-persistence-gateway'
import {
  createForgeMcpServer,
  FORGE_MCP_TOOL_NAMES,
  type ForgeGatewayPort,
} from '../../src/index.js'

function unexpected(name: string): (...args: never[]) => Promise<never> {
  return async () => {
    throw new Error('Unexpected fake Gateway call: ' + name)
  }
}

function fakeGateway(overrides: Partial<ForgeGatewayPort> = {}): ForgeGatewayPort {
  return {
    assertReady: unexpected('assertReady') as ForgeGatewayPort['assertReady'],
    getProjectByKey: unexpected('getProjectByKey') as ForgeGatewayPort['getProjectByKey'],
    listProjects: unexpected('listProjects') as ForgeGatewayPort['listProjects'],
    registerProject: unexpected('registerProject') as ForgeGatewayPort['registerProject'],
    getAgentByKey: unexpected('getAgentByKey') as ForgeGatewayPort['getAgentByKey'],
    registerAgent: unexpected('registerAgent') as ForgeGatewayPort['registerAgent'],
    assignAgent: unexpected('assignAgent') as ForgeGatewayPort['assignAgent'],
    createTask: unexpected('createTask') as ForgeGatewayPort['createTask'],
    getTaskByKey: unexpected('getTaskByKey') as ForgeGatewayPort['getTaskByKey'],
    listTasks: unexpected('listTasks') as ForgeGatewayPort['listTasks'],
    updateTaskStatus: unexpected('updateTaskStatus') as ForgeGatewayPort['updateTaskStatus'],
    startExecution: unexpected('startExecution') as ForgeGatewayPort['startExecution'],
    getExecutionByKey: unexpected('getExecutionByKey') as ForgeGatewayPort['getExecutionByKey'],
    listExecutions: unexpected('listExecutions') as ForgeGatewayPort['listExecutions'],
    remember: unexpected('remember') as ForgeGatewayPort['remember'],
    listMemories: unexpected('listMemories') as ForgeGatewayPort['listMemories'],
    saveDecision: unexpected('saveDecision') as ForgeGatewayPort['saveDecision'],
    listDecisions: unexpected('listDecisions') as ForgeGatewayPort['listDecisions'],
    registerEmbeddingProfile: unexpected('registerEmbeddingProfile') as ForgeGatewayPort['registerEmbeddingProfile'],
    listEmbeddingCandidates: unexpected('listEmbeddingCandidates') as ForgeGatewayPort['listEmbeddingCandidates'],
    putEmbedding: unexpected('putEmbedding') as ForgeGatewayPort['putEmbedding'],
    semanticSearch: unexpected('semanticSearch') as ForgeGatewayPort['semanticSearch'],
    getSemanticCandidateTexts: unexpected('getSemanticCandidateTexts') as ForgeGatewayPort['getSemanticCandidateTexts'],
    compileContinuationContext: unexpected('compileContinuationContext') as ForgeGatewayPort['compileContinuationContext'],
    loadContinuationContext: unexpected('loadContinuationContext') as ForgeGatewayPort['loadContinuationContext'],
    finishExecution: unexpected('finishExecution') as ForgeGatewayPort['finishExecution'],
    getAuditTrail: unexpected('getAuditTrail') as ForgeGatewayPort['getAuditTrail'],
    ...overrides,
  }
}

async function connect(gateway: ForgeGatewayPort, logs: string[] = []) {
  const server = createForgeMcpServer({
    gateway,
    logger: (message) => logs.push(message),
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'forge-mcp-unit-test', version: '0.1.0' })
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

function structuredResult(value: Awaited<ReturnType<Client['callTool']>>): unknown {
  assert.ok('content' in value)
  assert.equal(value.isError, undefined)
  const structured = value.structuredContent as Record<string, unknown> | undefined
  assert.ok(structured)
  return structured.result
}

test('publishes the complete stable tool contract and safety annotations', async () => {
  const session = await connect(fakeGateway())
  try {
    const listed = await session.client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      [...FORGE_MCP_TOOL_NAMES],
    )
    const status = listed.tools.find((tool) => tool.name === 'forge_status')
    assert.deepEqual(status?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
    const finish = listed.tools.find((tool) => tool.name === 'forge_finish_execution')
    assert.equal(finish?.annotations?.destructiveHint, true)
    assert.equal(finish?.annotations?.idempotentHint, false)
    for (const name of [
      'forge_get_project',
      'forge_get_agent',
      'forge_get_task',
      'forge_get_execution',
      'forge_list_projects',
      'forge_list_tasks',
      'forge_list_executions',
      'forge_list_memories',
      'forge_list_decisions',
      'forge_list_embedding_candidates',
      'forge_semantic_search',
      'forge_get_semantic_candidate_texts',
    ]) {
      assert.deepEqual(listed.tools.find((tool) => tool.name === name)?.annotations, {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      })
    }
    for (const name of ['forge_register_embedding_profile', 'forge_put_embedding']) {
      assert.deepEqual(listed.tools.find((tool) => tool.name === name)?.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      })
    }
  } finally {
    await session.close()
  }
})

test('validates and forwards a create-task call without transport leakage', async () => {
  const projectId = '8e40f7a7-48ac-41e4-a5f9-2bc88fd69a67'
  const taskId = 'f07d3260-cf08-4aa3-98d8-23e020c22e49'
  let received: unknown
  const gateway = fakeGateway({
    createTask: async (input) => {
      received = input
      return {
        id: taskId,
        projectId,
        taskKey: input.taskKey,
        title: input.title,
        objective: input.objective ?? null,
        assignedAgentId: input.assignedAgentId ?? null,
        status: input.status ?? 'ready',
        priority: input.priority ?? 'normal',
        metadata: input.metadata ?? {},
        version: 1,
        createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z',
      }
    },
  })
  const session = await connect(gateway)
  try {
    const result = await session.client.callTool({
      name: 'forge_create_task',
      arguments: {
        projectId,
        taskKey: 'TASK-MCP-UNIT',
        title: 'Validate MCP boundary',
        priority: 'high',
        idempotencyKey: 'mcp-unit-task',
      },
    })
    assert.deepEqual(received, {
      projectId,
      taskKey: 'TASK-MCP-UNIT',
      title: 'Validate MCP boundary',
      priority: 'high',
      idempotencyKey: 'mcp-unit-task',
    })
    assert.deepEqual(structuredResult(result), {
      id: taskId,
      projectId,
      taskKey: 'TASK-MCP-UNIT',
      title: 'Validate MCP boundary',
      objective: null,
      assignedAgentId: null,
      status: 'ready',
      priority: 'high',
      metadata: {},
      version: 1,
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    })
  } finally {
    await session.close()
  }
})

test('validates and forwards a project-scoped stable-key lookup', async () => {
  const projectId = '8e40f7a7-48ac-41e4-a5f9-2bc88fd69a67'
  const taskId = 'f07d3260-cf08-4aa3-98d8-23e020c22e49'
  const received: Array<[string, string]> = []
  const session = await connect(fakeGateway({
    getTaskByKey: async (receivedProjectId, taskKey) => {
      received.push([receivedProjectId, taskKey])
      return {
        id: taskId,
        projectId: receivedProjectId,
        taskKey,
        title: 'Recovered task',
        objective: null,
        assignedAgentId: null,
        status: 'ready',
        priority: 'normal',
        metadata: {},
        version: 1,
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z',
      }
    },
  }))

  try {
    const result = await session.client.callTool({
      name: 'forge_get_task',
      arguments: { projectId, taskKey: 'stable-task-key' },
    })
    assert.equal((structuredResult(result) as { id: string }).id, taskId)
    assert.deepEqual(received, [[projectId, 'stable-task-key']])

    const invalid = await session.client.callTool({
      name: 'forge_get_task',
      arguments: { projectId, taskKey: 'stable-task-key', unexpected: true },
    })
    assert.equal(invalid.isError, true)
    assert.equal(received.length, 1)
  } finally {
    await session.close()
  }
})

test('validates and forwards catalog filters and cursors', async () => {
  const projectId = '8e40f7a7-48ac-41e4-a5f9-2bc88fd69a67'
  const taskId = 'f07d3260-cf08-4aa3-98d8-23e020c22e49'
  const cursor = { createdAt: '2026-08-10T00:00:00.000Z', id: taskId }
  let received: unknown
  const session = await connect(fakeGateway({
    listTasks: async (input) => {
      received = input
      return { items: [], nextCursor: null }
    },
  }))

  try {
    const result = await session.client.callTool({
      name: 'forge_list_tasks',
      arguments: {
        projectId,
        status: 'in_progress',
        priority: 'high',
        limit: 25,
        cursor,
      },
    })
    assert.deepEqual(received, {
      projectId,
      status: 'in_progress',
      priority: 'high',
      limit: 25,
      cursor,
    })
    assert.deepEqual(structuredResult(result), { items: [], nextCursor: null })

    const invalid = await session.client.callTool({
      name: 'forge_list_tasks',
      arguments: { projectId, limit: 101 },
    })
    assert.equal(invalid.isError, true)
  } finally {
    await session.close()
  }
})

test('validates and forwards model-agnostic vector operations', async () => {
  const projectId = '8e40f7a7-48ac-41e4-a5f9-2bc88fd69a67'
  const sourceId = 'f07d3260-cf08-4aa3-98d8-23e020c22e49'
  const profileId = '4f6c1ce0-f4f0-4eaf-b99f-006ab71f4419'
  const embeddingId = 'bd089067-bbb4-4b12-ac68-802ad9d21a70'
  const received: unknown[] = []
  let putCalls = 0
  let searchCalls = 0
  let candidateCalls = 0
  let candidateTextCalls = 0
  const session = await connect(fakeGateway({
    registerEmbeddingProfile: async (input) => {
      received.push(input)
      return {
        id: profileId,
        profileKey: input.profileKey,
        provider: input.provider,
        model: input.model,
        dimensions: input.dimensions,
        distanceMetric: input.distanceMetric ?? 'cosine',
        status: 'active',
        metadata: input.metadata ?? {},
        version: 1,
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z',
      }
    },
    listEmbeddingCandidates: async (input) => {
      candidateCalls += 1
      received.push(input)
      return {
        profile: {
          id: profileId,
          profileKey: input.profileKey,
          provider: 'external',
          model: 'caller-supplied',
          dimensions: 3,
          distanceMetric: 'cosine',
          status: 'active',
          metadata: {},
          version: 1,
          createdAt: '2026-08-10T00:00:00.000Z',
          updatedAt: '2026-08-10T00:00:00.000Z',
        },
        items: [],
        nextCursor: null,
      }
    },
    putEmbedding: async (input) => {
      putCalls += 1
      received.push(input)
      return {
        id: embeddingId,
        projectId: input.projectId,
        profileId,
        profileKey: input.profileKey,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        dimensions: input.embedding.length,
        metadata: input.metadata ?? {},
        createdAt: '2026-08-10T00:00:00.000Z',
      }
    },
    semanticSearch: async (input) => {
      searchCalls += 1
      received.push(input)
      return []
    },
    getSemanticCandidateTexts: async (input) => {
      candidateTextCalls += 1
      received.push(input)
      return input.candidates.map((candidate) => ({
        projectId: input.projectId,
        ...candidate,
        title: 'Hydrated candidate',
        text: 'Full project-scoped candidate text',
        textTruncated: false,
      }))
    },
  }))

  try {
    await session.client.callTool({
      name: 'forge_register_embedding_profile',
      arguments: {
        profileKey: 'generic-3d',
        provider: 'external',
        model: 'caller-supplied',
        dimensions: 3,
        distanceMetric: 'cosine',
      },
    })
    await session.client.callTool({
      name: 'forge_list_embedding_candidates',
      arguments: {
        projectId,
        profileKey: 'generic-3d',
        sourceKinds: ['memory'],
        cursor: { sourceKind: 'memory', sourceId },
        limit: 5,
        maxTextChars: 8_000,
      },
    })
    await session.client.callTool({
      name: 'forge_put_embedding',
      arguments: {
        projectId,
        profileKey: 'generic-3d',
        sourceKind: 'memory',
        sourceId,
        sourceVersion: 1,
        embedding: [1, 0, 0],
        idempotencyKey: 'unit-embedding',
      },
    })
    const search = await session.client.callTool({
      name: 'forge_semantic_search',
      arguments: {
        projectId,
        profileKey: 'generic-3d',
        queryEmbedding: [0.9, 0.1, 0],
        sourceKinds: ['memory'],
        minScore: 0.5,
        limit: 5,
      },
    })
    assert.deepEqual(structuredResult(search), [])
    assert.deepEqual(received[3], {
      projectId,
      profileKey: 'generic-3d',
      queryEmbedding: [0.9, 0.1, 0],
      sourceKinds: ['memory'],
      minScore: 0.5,
      limit: 5,
    })

    const hydrated = await session.client.callTool({
      name: 'forge_get_semantic_candidate_texts',
      arguments: {
        projectId,
        candidates: [{ sourceKind: 'memory', sourceId, sourceVersion: 1 }],
        maxTextChars: 8_000,
      },
    })
    assert.deepEqual(structuredResult(hydrated), [{
      projectId,
      sourceKind: 'memory',
      sourceId,
      sourceVersion: 1,
      title: 'Hydrated candidate',
      text: 'Full project-scoped candidate text',
      textTruncated: false,
    }])

    const invalidEmbedding = await session.client.callTool({
      name: 'forge_put_embedding',
      arguments: {
        projectId,
        profileKey: 'generic-3d',
        sourceKind: 'memory',
        sourceId,
        sourceVersion: 1,
        embedding: [],
        idempotencyKey: 'unit-invalid-embedding',
      },
    })
    assert.equal(invalidEmbedding.isError, true)
    assert.equal(putCalls, 1)

    const invalidCandidates = await session.client.callTool({
      name: 'forge_list_embedding_candidates',
      arguments: {
        projectId,
        profileKey: 'generic-3d',
        maxTextChars: 32_001,
      },
    })
    assert.equal(invalidCandidates.isError, true)
    assert.equal(candidateCalls, 1)

    const invalidSearch = await session.client.callTool({
      name: 'forge_semantic_search',
      arguments: {
        projectId,
        profileKey: 'generic-3d',
        queryEmbedding: [1, 0, 0],
        limit: 51,
      },
    })
    assert.equal(invalidSearch.isError, true)
    assert.equal(searchCalls, 1)

    const invalidHydration = await session.client.callTool({
      name: 'forge_get_semantic_candidate_texts',
      arguments: { projectId, candidates: [] },
    })
    assert.equal(invalidHydration.isError, true)
    assert.equal(candidateTextCalls, 1)
  } finally {
    await session.close()
  }
})

test('rejects invalid identifiers before invoking the Gateway', async () => {
  let calls = 0
  const session = await connect(fakeGateway({
    loadContinuationContext: async () => {
      calls += 1
      throw new Error('Must not run')
    },
  }))
  try {
    const result = await session.client.callTool({
      name: 'forge_load_context',
      arguments: {
        projectId: 'not-a-uuid',
        packageId: 'also-not-a-uuid',
      },
    })
    assert.ok('content' in result)
    assert.equal(result.isError, true)
    assert.equal(calls, 0)
  } finally {
    await session.close()
  }
})

test('preserves domain errors and sanitizes unexpected failures', async () => {
  const logs: string[] = []
  const session = await connect(fakeGateway({
    loadContinuationContext: async () => {
      throw new NotFoundError('Context package', 'missing')
    },
    getAuditTrail: async () => {
      throw new Error('sensitive database detail')
    },
  }), logs)

  try {
    const domainResult = await session.client.callTool({
      name: 'forge_load_context',
      arguments: {
        projectId: '8e40f7a7-48ac-41e4-a5f9-2bc88fd69a67',
        packageId: 'f07d3260-cf08-4aa3-98d8-23e020c22e49',
      },
    })
    assert.ok('content' in domainResult)
    assert.equal(domainResult.isError, true)
    assert.deepEqual(domainResult.structuredContent, {
      error: {
        code: 'NOT_FOUND',
        message: 'Context package not found in the requested project: missing',
      },
    })

    const internalResult = await session.client.callTool({
      name: 'forge_get_audit_trail',
      arguments: {
        projectId: '8e40f7a7-48ac-41e4-a5f9-2bc88fd69a67',
        executionId: 'f07d3260-cf08-4aa3-98d8-23e020c22e49',
      },
    })
    assert.ok('content' in internalResult)
    assert.equal(internalResult.isError, true)
    assert.deepEqual(internalResult.structuredContent, {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The FORGE operation failed unexpectedly',
      },
    })
    assert.doesNotMatch(JSON.stringify(internalResult), /sensitive database detail/)
    assert.match(logs[0] ?? '', /sensitive database detail/)
  } finally {
    await session.close()
  }
})
