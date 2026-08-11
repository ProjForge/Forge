import { randomUUID } from 'node:crypto'
import { ForgePersistenceGateway } from '../index.js'

const connectionString = process.env.FORGE_DATABASE_URL
if (!connectionString) throw new Error('FORGE_DATABASE_URL is required')

const suffix = randomUUID()
let gateway = ForgePersistenceGateway.connect({ connectionString })

try {
  const runtime = await gateway.assertReady()
  const project = await gateway.registerProject({
    projectKey: `smoke-project-${suffix}`,
    name: 'FORGE Gateway smoke project',
  })
  const agent = await gateway.registerAgent({
    agentKey: `smoke-agent-${suffix}`,
    name: 'FORGE Gateway smoke agent',
    role: 'validation',
  })
  await gateway.assignAgent(project.id, agent.id, 'validation')
  const task = await gateway.createTask({
    projectId: project.id,
    taskKey: `SMOKE-${suffix}`,
    title: 'Validate Gateway continuity',
    assignedAgentId: agent.id,
    idempotencyKey: `smoke-task-${suffix}`,
  })
  const execution = await gateway.startExecution({
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
    executionKey: `SMOKE-EXEC-${suffix}`,
    idempotencyKey: `smoke-execution-${suffix}`,
  })
  await gateway.remember({
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
    executionId: execution.id,
    memoryType: 'observation',
    content: 'Smoke flow reached persistent memory.',
    provenance: { sourceKind: 'execution', sourceRef: execution.id },
    idempotencyKey: `smoke-memory-${suffix}`,
  })
  await gateway.saveDecision({
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
    executionId: execution.id,
    decisionKey: `SMOKE-DEC-${suffix}`,
    title: 'Smoke decision',
    decisionText: 'The Gateway persists the first vertical slice.',
    idempotencyKey: `smoke-decision-${suffix}`,
  })
  const context = await gateway.compileContinuationContext({
    projectId: project.id,
    taskId: task.id,
    agentId: agent.id,
    executionId: execution.id,
    idempotencyKey: `smoke-context-${suffix}`,
  })

  await gateway.close()
  gateway = ForgePersistenceGateway.connect({ connectionString })
  const recovered = await gateway.loadContinuationContext(project.id, context.packageId)
  const audit = await gateway.getAuditTrail(project.id, execution.id)

  process.stdout.write(`${JSON.stringify({
    runtime,
    projectId: project.id,
    taskId: task.id,
    executionId: execution.id,
    contextPackageId: recovered.packageId,
    recoveredMemories: recovered.memories.length,
    recoveredDecisions: recovered.decisions.length,
    staleSources: recovered.staleSources.length,
    auditRecords: audit.length,
  }, null, 2)}\n`)
} finally {
  await gateway.close().catch(() => undefined)
}
