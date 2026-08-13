import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  ConflictError,
  type EmbeddingCandidate,
  type EmbeddingCandidateCursor,
  ForgePersistenceGateway,
  IdempotencyConflictError,
  NotFoundError,
  OptimisticLockError,
} from '../../src/index.js'

const connectionString = process.env.FORGE_DATABASE_URL

test('persists and reconstructs a complete task continuation flow', {
  skip: connectionString ? false : 'FORGE_DATABASE_URL is not configured',
  timeout: 30_000,
}, async () => {
  if (!connectionString) return

  const suffix = randomUUID()
  let gateway = ForgePersistenceGateway.connect({ connectionString })

  try {
    const runtime = await gateway.assertReady()
    assert.equal(runtime.schemaVersion, '0.1.3')
    assert.ok(Number.parseInt(runtime.serverVersion, 10) >= 14)

    const projectInput = {
      projectKey: `gateway-project-${suffix}`,
      name: 'Gateway integration project',
      metadata: { schema_version: 1, suite: 'continuity' },
    } as const
    const project = await gateway.registerProject(projectInput)
    const projectReplay = await gateway.registerProject({
      ...projectInput,
      metadata: { suite: 'continuity', schema_version: 1 },
    })
    assert.equal(projectReplay.id, project.id)
    await assert.rejects(
      gateway.registerProject({ ...projectInput, name: 'Different project' }),
      ConflictError,
    )

    const agentInput = {
      agentKey: `gateway-agent-${suffix}`,
      name: 'Gateway integration agent',
      role: 'developer',
      capabilities: { remember: true, decide: true, compile_context: true },
    } as const
    const agent = await gateway.registerAgent(agentInput)
    const agentReplay = await gateway.registerAgent(agentInput)
    assert.equal(agentReplay.id, agent.id)
    await gateway.assignAgent(project.id, agent.id, 'developer')

    const taskInput = {
      projectId: project.id,
      taskKey: `TASK-${suffix}`,
      title: 'Prove persistent task continuity',
      objective: 'Recover useful state after the Gateway process is replaced',
      assignedAgentId: agent.id,
      status: 'ready',
      priority: 'high',
      metadata: { schema_version: 1 },
      idempotencyKey: `task-create-${suffix}`,
    } as const
    const task = await gateway.createTask(taskInput)
    const taskReplay = await gateway.createTask(taskInput)
    assert.equal(taskReplay.id, task.id)
    await assert.rejects(
      gateway.createTask({ ...taskInput, title: 'A different request' }),
      IdempotencyConflictError,
    )

    const activeTask = await gateway.updateTaskStatus({
      projectId: project.id,
      taskId: task.id,
      expectedVersion: task.version,
      status: 'in_progress',
    })
    assert.equal(activeTask.version, 2)
    await assert.rejects(
      gateway.updateTaskStatus({
        projectId: project.id,
        taskId: task.id,
        expectedVersion: task.version,
        status: 'blocked',
      }),
      OptimisticLockError,
    )

    const catalogTask = await gateway.createTask({
      projectId: project.id,
      taskKey: `CATALOG-${suffix}`,
      title: 'Second task for catalog pagination',
      assignedAgentId: agent.id,
      status: 'ready',
      priority: 'normal',
      idempotencyKey: `catalog-task-${suffix}`,
    })
    const secondaryAgent = await gateway.registerAgent({
      agentKey: `gateway-secondary-agent-${suffix}`,
      name: 'Gateway secondary agent',
      role: 'reviewer',
    })
    await gateway.assignAgent(project.id, secondaryAgent.id, 'reviewer')
    const reassignedCatalogTask = await gateway.updateTaskAssignment({
      projectId: project.id,
      taskId: catalogTask.id,
      expectedVersion: catalogTask.version,
      assignedAgentId: secondaryAgent.id,
    })
    assert.equal(reassignedCatalogTask.assignedAgentId, secondaryAgent.id)
    await assert.rejects(
      gateway.updateTaskAssignment({
        projectId: project.id,
        taskId: catalogTask.id,
        expectedVersion: catalogTask.version,
        assignedAgentId: agent.id,
      }),
      OptimisticLockError,
    )

    const executionInput = {
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      executionKey: `EXEC-${suffix}`,
      policyVersion: 'local-static-v1',
      metadata: { environment: 'local' },
      idempotencyKey: `execution-start-${suffix}`,
    } as const
    const execution = await gateway.startExecution(executionInput)
    assert.equal(execution.status, 'running')

    const rollbackKey = `memory-rollback-${suffix}`
    await assert.rejects(gateway.remember({
      projectId: project.id,
      agentId: agent.id,
      executionId: randomUUID(),
      memoryType: 'observation',
      content: 'This transaction must roll back because its execution does not exist.',
      idempotencyKey: rollbackKey,
    }))
    await gateway.remember({
      projectId: project.id,
      agentId: agent.id,
      executionId: execution.id,
      memoryType: 'observation',
      content: 'The failed transaction released its idempotency key for a valid retry.',
      idempotencyKey: rollbackKey,
    })

    const memoryInput = {
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      executionId: execution.id,
      memoryType: 'observation',
      epistemicState: 'verified',
      trustLevel: 'internal',
      title: 'Schema validation result',
      content: 'FORGE PostgreSQL Schema 0.1.2 passed native server and restart validation.',
      importance: 'high',
      provenance: {
        sourceKind: 'execution',
        sourceRef: execution.id,
        sourceVersion: String(execution.version),
        evidence: { test: 'native-postgresql' },
      },
      idempotencyKey: `memory-${suffix}`,
    } as const
    const [memory, concurrentMemoryReplay] = await Promise.all([
      gateway.remember(memoryInput),
      gateway.remember(memoryInput),
    ])
    assert.equal(concurrentMemoryReplay.id, memory.id)

    const decision = await gateway.saveDecision({
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      executionId: execution.id,
      decisionKey: `DEC-${suffix}`,
      title: 'Keep transport outside the first Gateway slice',
      decisionText: 'Expose a typed library before adding REST or MCP.',
      rationale: 'This validates persistence boundaries without transport coupling.',
      alternatives: ['REST first', 'MCP first'],
      consequences: ['Transport remains future work'],
      status: 'accepted',
      idempotencyKey: `decision-${suffix}`,
    })

    const profileInput = {
      profileKey: `test-profile-${suffix}`,
      provider: 'test-provider',
      model: 'deterministic-3d',
      dimensions: 3,
      distanceMetric: 'cosine',
      metadata: { suite: 'continuity' },
    } as const
    const profile = await gateway.registerEmbeddingProfile(profileInput)
    const profileReplay = await gateway.registerEmbeddingProfile(profileInput)
    assert.equal(profileReplay.id, profile.id)
    await assert.rejects(
      gateway.registerEmbeddingProfile({ ...profileInput, dimensions: 2 }),
      ConflictError,
    )

    const initialCandidates: EmbeddingCandidate[] = []
    let candidateCursor: EmbeddingCandidateCursor | null = null
    do {
      const page = await gateway.listEmbeddingCandidates({
        projectId: project.id,
        profileKey: profile.profileKey,
        sourceKinds: ['memory', 'decision'],
        ...(candidateCursor ? { cursor: candidateCursor } : {}),
        limit: 1,
        maxTextChars: 40,
      })
      assert.equal(page.profile.id, profile.id)
      initialCandidates.push(...page.items)
      candidateCursor = page.nextCursor
    } while (candidateCursor)
    assert.equal(
      new Set(initialCandidates.map((candidate) => candidate.sourceId)).size,
      initialCandidates.length,
    )
    const memoryCandidate = initialCandidates.find((candidate) => candidate.sourceId === memory.id)
    const decisionCandidate = initialCandidates.find((candidate) => candidate.sourceId === decision.id)
    assert.equal(memoryCandidate?.status, 'missing')
    assert.equal(decisionCandidate?.status, 'missing')
    assert.equal(memoryCandidate?.sourceVersion, memory.version)
    assert.equal(memoryCandidate?.textTruncated, true)
    assert.match(memoryCandidate?.inputHash ?? '', /^[0-9a-f]{64}$/)
    const checkpointCandidate = initialCandidates.find((candidate) => (
      candidate.sourceKind === 'memory' && candidate.sourceId !== memory.id
    ))
    assert.ok(checkpointCandidate)

    const memoryEmbeddingInput = {
      projectId: project.id,
      profileKey: profile.profileKey,
      sourceKind: 'memory',
      sourceId: memory.id,
      sourceVersion: memory.version,
      embedding: [1, 0, 0],
      agentId: agent.id,
      executionId: execution.id,
      metadata: { source_hash: 'memory-v1' },
      idempotencyKey: `embedding-memory-${suffix}`,
    } as const
    const memoryEmbedding = await gateway.putEmbedding(memoryEmbeddingInput)
    assert.equal(memoryEmbedding.sourceId, memory.id)
    assert.equal(memoryEmbedding.dimensions, 3)
    await gateway.putEmbedding({
      projectId: project.id,
      profileKey: profile.profileKey,
      sourceKind: 'decision',
      sourceId: decision.id,
      sourceVersion: decision.version,
      embedding: [0, 1, 0],
      agentId: agent.id,
      executionId: execution.id,
      idempotencyKey: `embedding-decision-${suffix}`,
    })
    await assert.rejects(
      gateway.putEmbedding({
        ...memoryEmbeddingInput,
        sourceVersion: memory.version + 1,
        idempotencyKey: `embedding-stale-source-${suffix}`,
      }),
      OptimisticLockError,
    )
    await assert.rejects(
      gateway.putEmbedding({
        ...memoryEmbeddingInput,
        embedding: [0, 0, 1],
        idempotencyKey: `embedding-conflict-${suffix}`,
      }),
      ConflictError,
    )
    await assert.rejects(
      gateway.putEmbedding({
        ...memoryEmbeddingInput,
        embedding: [1, 0],
        idempotencyKey: `embedding-wrong-dim-${suffix}`,
      }),
      /dimension mismatch/i,
    )

    const remainingCandidates = await gateway.listEmbeddingCandidates({
      projectId: project.id,
      profileKey: profile.profileKey,
      sourceKinds: ['memory', 'decision'],
      limit: 50,
      maxTextChars: 40,
    })
    assert.equal(remainingCandidates.items.some((candidate) => candidate.sourceId === memory.id), false)
    assert.equal(remainingCandidates.items.some((candidate) => candidate.sourceId === decision.id), false)

    const compileInput = {
      projectId: project.id,
      taskId: task.id,
      agentId: agent.id,
      executionId: execution.id,
      idempotencyKey: `context-${suffix}`,
    }
    const compiled = await gateway.compileContinuationContext(compileInput)
    assert.equal(compiled.task.id, task.id)
    assert.deepEqual(compiled.memories.map((item) => item.id), [memory.id])
    assert.deepEqual(compiled.decisions.map((item) => item.id), [decision.id])
    assert.deepEqual(compiled.staleSources, [])
    const packageId = compiled.packageId

    await gateway.close()
    gateway = ForgePersistenceGateway.connect({ connectionString })

    const recoveredProject = await gateway.getProjectByKey(projectInput.projectKey)
    const recoveredAgent = await gateway.getAgentByKey(project.id, agentInput.agentKey)
    const recoveredTask = await gateway.getTaskByKey(project.id, taskInput.taskKey)
    const recoveredExecution = await gateway.getExecutionByKey(
      project.id,
      executionInput.executionKey,
    )
    assert.equal(recoveredProject.id, project.id)
    assert.equal(recoveredAgent.id, agent.id)
    assert.equal(recoveredTask.id, task.id)
    assert.equal(recoveredExecution.id, execution.id)

    const projectCatalog = await gateway.listProjects({ status: 'active', limit: 100 })
    assert.ok(projectCatalog.items.some((item) => item.id === project.id))

    const agentCatalog = await gateway.listProjectAgents({ projectId: project.id, status: 'active' })
    assert.deepEqual(
      new Set(agentCatalog.items.map((item) => item.id)),
      new Set([agent.id, secondaryAgent.id]),
    )
    assert.equal(agentCatalog.items.find((item) => item.id === agent.id)?.assignmentRole, 'developer')

    const completeTaskCatalog = await gateway.listTasks({ projectId: project.id, limit: 10 })
    assert.deepEqual(
      new Set(completeTaskCatalog.items.map((item) => item.id)),
      new Set([task.id, catalogTask.id]),
    )
    const firstTaskPage = await gateway.listTasks({ projectId: project.id, limit: 1 })
    assert.equal(firstTaskPage.items.length, 1)
    assert.ok(firstTaskPage.nextCursor)
    const secondTaskPage = await gateway.listTasks({
      projectId: project.id,
      limit: 1,
      cursor: firstTaskPage.nextCursor,
    })
    assert.equal(secondTaskPage.items.length, 1)
    assert.notEqual(secondTaskPage.items[0]?.id, firstTaskPage.items[0]?.id)
    assert.equal(secondTaskPage.nextCursor, null)

    const activeTaskCatalog = await gateway.listTasks({
      projectId: project.id,
      status: 'in_progress',
      priority: 'high',
      assignedAgentId: agent.id,
    })
    assert.deepEqual(activeTaskCatalog.items.map((item) => item.id), [task.id])

    const executionCatalog = await gateway.listExecutions({
      projectId: project.id,
      status: 'running',
      taskId: task.id,
      agentId: agent.id,
    })
    assert.deepEqual(executionCatalog.items.map((item) => item.id), [execution.id])

    const memoryCatalog = await gateway.listMemories({
      projectId: project.id,
      taskId: task.id,
      createdByAgentId: agent.id,
      memoryType: 'observation',
      importance: 'high',
    })
    assert.deepEqual(memoryCatalog.items.map((item) => item.id), [memory.id])
    assert.equal('content' in (memoryCatalog.items[0] ?? {}), false)

    const decisionCatalog = await gateway.listDecisions({
      projectId: project.id,
      taskId: task.id,
      createdByAgentId: agent.id,
      status: 'accepted',
    })
    assert.deepEqual(decisionCatalog.items.map((item) => item.id), [decision.id])
    assert.equal('decisionText' in (decisionCatalog.items[0] ?? {}), false)

    const recoveredCandidates = await gateway.listEmbeddingCandidates({
      projectId: project.id,
      profileKey: profile.profileKey,
      sourceKinds: ['memory'],
      limit: 50,
      maxTextChars: 40,
    })
    const recoveredCheckpoint = recoveredCandidates.items.find(
      (candidate) => candidate.sourceId === checkpointCandidate.sourceId,
    )
    assert.equal(recoveredCheckpoint?.inputHash, checkpointCandidate.inputHash)
    assert.equal(recoveredCheckpoint?.sourceVersion, checkpointCandidate.sourceVersion)

    const semanticResults = await gateway.semanticSearch({
      projectId: project.id,
      profileKey: profile.profileKey,
      queryEmbedding: [0.9, 0.1, 0],
      sourceKinds: ['memory', 'decision'],
      limit: 10,
    })
    assert.deepEqual(semanticResults.map((item) => item.sourceId), [memory.id, decision.id])
    assert.ok((semanticResults[0]?.score ?? 0) > (semanticResults[1]?.score ?? 0))
    assert.equal(semanticResults[0]?.stale, false)
    assert.equal(semanticResults[0]?.embeddedSourceVersion, memory.version)

    const hydratedCandidates = await gateway.getSemanticCandidateTexts({
      projectId: project.id,
      candidates: [
        { sourceKind: 'decision', sourceId: decision.id, sourceVersion: decision.version },
        { sourceKind: 'memory', sourceId: memory.id, sourceVersion: memory.version },
      ],
      maxTextChars: 32_000,
    })
    assert.deepEqual(
      hydratedCandidates.map((candidate) => candidate.sourceId),
      [decision.id, memory.id],
    )
    assert.ok(hydratedCandidates[0]?.text.includes(decision.decisionText))
    assert.ok(hydratedCandidates[1]?.text.includes(memory.content))
    assert.ok(hydratedCandidates.every((candidate) => candidate.projectId === project.id))
    assert.ok(hydratedCandidates.every((candidate) => candidate.textTruncated === false))
    await assert.rejects(
      gateway.getSemanticCandidateTexts({
        projectId: project.id,
        candidates: [{
          sourceKind: 'memory',
          sourceId: memory.id,
          sourceVersion: memory.version + 1,
        }],
      }),
      NotFoundError,
    )

    const highScoreResults = await gateway.semanticSearch({
      projectId: project.id,
      profileKey: profile.profileKey,
      queryEmbedding: [1, 0, 0],
      minScore: 0.5,
    })
    assert.deepEqual(highScoreResults.map((item) => item.sourceId), [memory.id])
    await assert.rejects(
      gateway.semanticSearch({
        projectId: project.id,
        profileKey: profile.profileKey,
        queryEmbedding: [1, 0],
      }),
      /dimension mismatch/i,
    )

    const persistentEmbeddingReplay = await gateway.putEmbedding(memoryEmbeddingInput)
    assert.equal(persistentEmbeddingReplay.id, memoryEmbedding.id)

    const persistentTaskReplay = await gateway.createTask(taskInput)
    assert.equal(persistentTaskReplay.id, task.id)
    const persistentContextReplay = await gateway.compileContinuationContext(compileInput)
    assert.equal(persistentContextReplay.packageId, packageId)

    const loaded = await gateway.loadContinuationContext(project.id, packageId)
    assert.equal(loaded.packageHash, compiled.packageHash)
    assert.equal(loaded.task.objective, taskInput.objective)
    assert.equal(loaded.memories[0]?.content, memory.content)
    assert.equal(loaded.decisions[0]?.decisionText, decision.decisionText)
    assert.deepEqual(loaded.staleSources, [])
    const contextCatalog = await gateway.listContinuationPackages({ projectId: project.id })
    assert.deepEqual(contextCatalog.items.map((item) => item.id), [packageId])
    assert.equal(contextCatalog.items[0]?.taskId, task.id)
    assert.equal(contextCatalog.items[0]?.itemCount, 3)

    const completedTask = await gateway.updateTaskStatus({
      projectId: project.id,
      taskId: task.id,
      expectedVersion: activeTask.version,
      status: 'done',
    })
    assert.equal(completedTask.version, 3)
    const stalePackage = await gateway.loadContinuationContext(project.id, packageId)
    assert.deepEqual(stalePackage.staleSources.map((source) => source.sourceKind), ['task'])

    const finished = await gateway.finishExecution({
      projectId: project.id,
      executionId: execution.id,
      agentId: agent.id,
      expectedVersion: execution.version,
      status: 'succeeded',
      details: { context_package_id: packageId },
    })
    assert.equal(finished.status, 'succeeded')

    const audit = await gateway.getAuditTrail(project.id, execution.id)
    assert.deepEqual(audit.map((record) => record.action), [
      'execution.start',
      'memory.remember',
      'memory.remember',
      'decision.save',
      'embedding.put',
      'embedding.put',
      'context.compile',
      'execution.finish',
    ])

    const otherProject = await gateway.registerProject({
      projectKey: `gateway-other-project-${suffix}`,
      name: 'Other project',
    })
    await assert.rejects(
      gateway.getAgentByKey(otherProject.id, agentInput.agentKey),
      NotFoundError,
    )
    await assert.rejects(
      gateway.getTaskByKey(otherProject.id, taskInput.taskKey),
      NotFoundError,
    )
    await assert.rejects(
      gateway.getExecutionByKey(otherProject.id, executionInput.executionKey),
      NotFoundError,
    )
    await assert.rejects(
      gateway.getProjectByKey(`missing-project-${suffix}`),
      NotFoundError,
    )
    assert.deepEqual((await gateway.listTasks({ projectId: otherProject.id })).items, [])
    assert.deepEqual((await gateway.listExecutions({ projectId: otherProject.id })).items, [])
    assert.deepEqual((await gateway.listMemories({ projectId: otherProject.id })).items, [])
    assert.deepEqual((await gateway.listDecisions({ projectId: otherProject.id })).items, [])
    assert.deepEqual((await gateway.listProjectAgents({ projectId: otherProject.id })).items, [])
    assert.deepEqual((await gateway.listContinuationPackages({ projectId: otherProject.id })).items, [])
    assert.deepEqual((await gateway.listEmbeddingCandidates({
      projectId: otherProject.id,
      profileKey: profile.profileKey,
    })).items, [])
    assert.deepEqual(await gateway.semanticSearch({
      projectId: otherProject.id,
      profileKey: profile.profileKey,
      queryEmbedding: [1, 0, 0],
    }), [])
    await assert.rejects(
      gateway.getSemanticCandidateTexts({
        projectId: otherProject.id,
        candidates: [{
          sourceKind: 'memory',
          sourceId: memory.id,
          sourceVersion: memory.version,
        }],
      }),
      NotFoundError,
    )
    await assert.rejects(
      gateway.loadContinuationContext(otherProject.id, packageId),
      NotFoundError,
    )
  } finally {
    await gateway.close().catch(() => undefined)
  }
})
