import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { FORGE_MCP_TOOL_NAMES } from '../../src/index.js'

const connectionString = process.env.FORGE_DATABASE_URL

async function connect() {
  assert.ok(connectionString)
  const stderr: string[] = []
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/stdio.js')],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      FORGE_DATABASE_URL: connectionString,
    },
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (chunk) => stderr.push(String(chunk)))
  const client = new Client({ name: 'forge-mcp-native-test', version: '0.1.0' })
  await client.connect(transport)
  return { client, stderr }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args })
  assert.ok('content' in response)
  assert.notEqual(response.isError, true, JSON.stringify(response.content))
  const structured = response.structuredContent as Record<string, unknown> | undefined
  assert.ok(structured)
  assert.ok('result' in structured)
  return structured.result as Record<string, unknown>
}

test('executes and resumes a FORGE workflow over a real MCP stdio boundary', {
  skip: connectionString ? false : 'FORGE_DATABASE_URL is not configured',
  timeout: 60_000,
}, async () => {
  if (!connectionString) return

  const suffix = randomUUID()
  const projectInput = {
    projectKey: 'mcp-project-' + suffix,
    name: 'MCP native continuity project',
    metadata: { suite: 'mcp-stdio', schema_version: 1 },
  }
  const agentInput = {
    agentKey: 'mcp-agent-' + suffix,
    name: 'MCP native continuity agent',
    role: 'developer',
    capabilities: { remember: true, decide: true, compile_context: true },
  }
  let firstSession = await connect()

  try {
    const listed = await firstSession.client.listTools()
    assert.deepEqual(listed.tools.map((tool) => tool.name), [...FORGE_MCP_TOOL_NAMES])
    assert.match(firstSession.stderr.join(''), /ready on stdio/)

    const status = await call(firstSession.client, 'forge_status', {})
    assert.equal(status.schemaVersion, '0.1.3')
    assert.ok(Number.parseInt(String(status.serverVersion), 10) >= 14)

    const project = await call(firstSession.client, 'forge_register_project', projectInput)
    const agent = await call(firstSession.client, 'forge_register_agent', agentInput)
    await call(firstSession.client, 'forge_assign_agent', {
      projectId: project.id,
      agentId: agent.id,
      assignmentRole: 'developer',
    })

    const taskInput = {
      projectId: project.id,
      taskKey: 'TASK-MCP-' + suffix,
      title: 'Prove continuity through MCP stdio',
      objective: 'Recover the same context after replacing the MCP server process',
      assignedAgentId: agent.id,
      status: 'ready',
      priority: 'high',
      idempotencyKey: 'mcp-task-' + suffix,
    }
    const task = await call(firstSession.client, 'forge_create_task', taskInput)
    const activeTask = await call(firstSession.client, 'forge_update_task_status', {
      projectId: project.id,
      taskId: task.id,
      expectedVersion: task.version,
      status: 'in_progress',
    })
    assert.equal(activeTask.version, 2)

    const execution = await call(firstSession.client, 'forge_start_execution', {
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      executionKey: 'EXEC-MCP-' + suffix,
      policyVersion: 'local-static-v1',
      metadata: { transport: 'stdio' },
      idempotencyKey: 'mcp-execution-' + suffix,
    })

    const memory = await call(firstSession.client, 'forge_remember', {
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      executionId: execution.id,
      memoryType: 'observation',
      epistemicState: 'verified',
      trustLevel: 'internal',
      title: 'MCP transport result',
      content: 'The FORGE MCP stdio boundary persisted this memory.',
      importance: 'high',
      provenance: {
        sourceKind: 'execution',
        sourceRef: execution.id,
        sourceVersion: String(execution.version),
        evidence: { test: 'native-mcp-stdio' },
      },
      idempotencyKey: 'mcp-memory-' + suffix,
    })

    const decision = await call(firstSession.client, 'forge_save_decision', {
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      executionId: execution.id,
      decisionKey: 'DEC-MCP-' + suffix,
      title: 'Keep MCP as a thin adapter',
      decisionText: 'MCP translates protocol calls into Gateway use cases without owning persistence.',
      rationale: 'This preserves the tested application and database boundaries.',
      status: 'accepted',
      idempotencyKey: 'mcp-decision-' + suffix,
    })

    const profileInput = {
      profileKey: 'mcp-profile-' + suffix,
      provider: 'test-provider',
      model: 'deterministic-3d',
      dimensions: 3,
      distanceMetric: 'cosine',
      metadata: { suite: 'mcp-stdio' },
    }
    const profile = await call(
      firstSession.client,
      'forge_register_embedding_profile',
      profileInput,
    )
    const profileReplay = await call(
      firstSession.client,
      'forge_register_embedding_profile',
      profileInput,
    )
    assert.equal(profileReplay.id, profile.id)

    const initialCandidatePage = await call(
      firstSession.client,
      'forge_list_embedding_candidates',
      {
        projectId: project.id,
        profileKey: profile.profileKey,
        sourceKinds: ['memory', 'decision'],
        limit: 50,
        maxTextChars: 40,
      },
    )
    const initialCandidates = initialCandidatePage.items as Array<Record<string, unknown>>
    assert.ok(initialCandidates.some((candidate) => candidate.sourceId === memory.id))
    assert.ok(initialCandidates.some((candidate) => candidate.sourceId === decision.id))
    assert.ok(initialCandidates.every((candidate) => candidate.status === 'missing'))

    const memoryEmbeddingInput = {
      projectId: project.id,
      profileKey: profile.profileKey,
      sourceKind: 'memory',
      sourceId: memory.id,
      sourceVersion: memory.version,
      embedding: [1, 0, 0],
      agentId: agent.id,
      executionId: execution.id,
      idempotencyKey: 'mcp-embedding-memory-' + suffix,
    }
    const memoryEmbedding = await call(
      firstSession.client,
      'forge_put_embedding',
      memoryEmbeddingInput,
    )
    await call(firstSession.client, 'forge_put_embedding', {
      projectId: project.id,
      profileKey: profile.profileKey,
      sourceKind: 'decision',
      sourceId: decision.id,
      sourceVersion: decision.version,
      embedding: [0, 1, 0],
      agentId: agent.id,
      executionId: execution.id,
      idempotencyKey: 'mcp-embedding-decision-' + suffix,
    })

    const invalidVector = await firstSession.client.callTool({
      name: 'forge_put_embedding',
      arguments: {
        ...memoryEmbeddingInput,
        embedding: [],
        idempotencyKey: 'mcp-invalid-vector-' + suffix,
      },
    })
    assert.equal(invalidVector.isError, true)

    const compiled = await call(firstSession.client, 'forge_compile_context', {
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      executionId: execution.id,
      idempotencyKey: 'mcp-context-' + suffix,
    })
    assert.equal((compiled.memories as Array<Record<string, unknown>>)[0]?.id, memory.id)
    assert.equal((compiled.decisions as Array<Record<string, unknown>>)[0]?.id, decision.id)

    await firstSession.client.close()
    firstSession = await connect()

    const recoveredProject = await call(firstSession.client, 'forge_get_project', {
      projectKey: projectInput.projectKey,
    })
    const recoveredAgent = await call(firstSession.client, 'forge_get_agent', {
      projectId: project.id,
      agentKey: agentInput.agentKey,
    })
    const recoveredTask = await call(firstSession.client, 'forge_get_task', {
      projectId: project.id,
      taskKey: taskInput.taskKey,
    })
    const recoveredExecution = await call(firstSession.client, 'forge_get_execution', {
      projectId: project.id,
      executionKey: 'EXEC-MCP-' + suffix,
    })
    assert.equal(recoveredProject.id, project.id)
    assert.equal(recoveredAgent.id, agent.id)
    assert.equal(recoveredTask.id, task.id)
    assert.equal(recoveredExecution.id, execution.id)

    const projectCatalog = await call(firstSession.client, 'forge_list_projects', {
      status: 'active',
      limit: 100,
    })
    assert.ok(
      (projectCatalog.items as Array<Record<string, unknown>>)
        .some((item) => item.id === project.id),
    )

    const taskCatalog = await call(firstSession.client, 'forge_list_tasks', {
      projectId: project.id,
      status: 'in_progress',
      priority: 'high',
      assignedAgentId: agent.id,
    })
    assert.deepEqual(
      (taskCatalog.items as Array<Record<string, unknown>>).map((item) => item.id),
      [task.id],
    )

    const executionCatalog = await call(firstSession.client, 'forge_list_executions', {
      projectId: project.id,
      status: 'running',
      taskId: task.id,
      agentId: agent.id,
    })
    assert.deepEqual(
      (executionCatalog.items as Array<Record<string, unknown>>).map((item) => item.id),
      [execution.id],
    )

    const memoryCatalog = await call(firstSession.client, 'forge_list_memories', {
      projectId: project.id,
      taskId: task.id,
      memoryType: 'observation',
      importance: 'high',
    })
    const memorySummary = (memoryCatalog.items as Array<Record<string, unknown>>)[0]
    assert.equal(memorySummary?.id, memory.id)
    assert.equal('content' in (memorySummary ?? {}), false)

    const decisionCatalog = await call(firstSession.client, 'forge_list_decisions', {
      projectId: project.id,
      taskId: task.id,
      status: 'accepted',
    })
    const decisionSummary = (decisionCatalog.items as Array<Record<string, unknown>>)[0]
    assert.equal(decisionSummary?.id, decision.id)
    assert.equal('decisionText' in (decisionSummary ?? {}), false)

    const remainingCandidatePage = await call(
      firstSession.client,
      'forge_list_embedding_candidates',
      {
        projectId: project.id,
        profileKey: profile.profileKey,
        sourceKinds: ['memory', 'decision'],
        limit: 50,
      },
    )
    const remainingCandidates = remainingCandidatePage.items as Array<Record<string, unknown>>
    assert.equal(remainingCandidates.some((candidate) => candidate.sourceId === memory.id), false)
    assert.equal(remainingCandidates.some((candidate) => candidate.sourceId === decision.id), false)

    const semanticResults = await call(firstSession.client, 'forge_semantic_search', {
      projectId: project.id,
      profileKey: profile.profileKey,
      queryEmbedding: [0.9, 0.1, 0],
      sourceKinds: ['memory', 'decision'],
      limit: 10,
    }) as unknown as Array<Record<string, unknown>>
    assert.deepEqual(semanticResults.map((item) => item.sourceId), [memory.id, decision.id])
    assert.ok(Number(semanticResults[0]?.score) > Number(semanticResults[1]?.score))
    assert.equal(semanticResults[0]?.stale, false)

    const candidateTexts = await call(
      firstSession.client,
      'forge_get_semantic_candidate_texts',
      {
        projectId: project.id,
        candidates: semanticResults.map((result) => ({
          sourceKind: result.sourceKind,
          sourceId: result.sourceId,
          sourceVersion: result.currentSourceVersion,
        })),
        maxTextChars: 32_000,
      },
    ) as unknown as Array<Record<string, unknown>>
    assert.deepEqual(
      candidateTexts.map((candidate) => candidate.sourceId),
      semanticResults.map((candidate) => candidate.sourceId),
    )
    assert.ok(String(candidateTexts[0]?.text).includes(String(memory.content)))
    assert.ok(String(candidateTexts[1]?.text).includes(String(decision.decisionText)))

    const replayedEmbedding = await call(
      firstSession.client,
      'forge_put_embedding',
      memoryEmbeddingInput,
    )
    assert.equal(replayedEmbedding.id, memoryEmbedding.id)

    const replayedTask = await call(firstSession.client, 'forge_create_task', taskInput)
    assert.equal(replayedTask.id, task.id)

    const loaded = await call(firstSession.client, 'forge_load_context', {
      projectId: project.id,
      packageId: compiled.packageId,
    })
    assert.equal(loaded.packageHash, compiled.packageHash)
    assert.equal((loaded.task as Record<string, unknown>).id, task.id)
    assert.equal((loaded.memories as Array<Record<string, unknown>>)[0]?.id, memory.id)
    assert.equal((loaded.decisions as Array<Record<string, unknown>>)[0]?.id, decision.id)
    assert.deepEqual(loaded.staleSources, [])

    const finished = await call(firstSession.client, 'forge_finish_execution', {
      projectId: project.id,
      executionId: execution.id,
      agentId: agent.id,
      expectedVersion: execution.version,
      status: 'succeeded',
      details: { context_package_id: compiled.packageId },
    })
    assert.equal(finished.status, 'succeeded')

    const audit = await call(firstSession.client, 'forge_get_audit_trail', {
      projectId: project.id,
      executionId: execution.id,
    })
    assert.deepEqual(
      (audit as unknown as Array<Record<string, unknown>>).map((entry) => entry.action),
      [
        'execution.start',
        'memory.remember',
        'decision.save',
        'embedding.put',
        'embedding.put',
        'context.compile',
        'execution.finish',
      ],
    )
  } finally {
    await firstSession.client.close().catch(() => undefined)
  }
})
