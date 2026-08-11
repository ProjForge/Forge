import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
  ForgeGatewayError,
  type CompileContinuationInput,
  type CreateTaskInput,
  type JsonObject,
  type ListDecisionsInput,
  type ListEmbeddingCandidatesInput,
  type ListExecutionsInput,
  type ListMemoriesInput,
  type ListProjectsInput,
  type ListTasksInput,
  type PutEmbeddingInput,
  type RegisterAgentInput,
  type RegisterEmbeddingProfileInput,
  type RegisterProjectInput,
  type RememberInput,
  type SaveDecisionInput,
  type SemanticSearchInput,
  type StartExecutionInput,
  type ForgePersistenceGateway,
  type GetSemanticCandidateTextsInput,
} from 'forge-persistence-gateway'
import {
  agentLookupInputSchema,
  agentInputSchema,
  assignmentInputSchema,
  auditTrailInputSchema,
  compileContextInputSchema,
  decisionCatalogInputSchema,
  decisionInputSchema,
  embeddingCandidateInputSchema,
  embeddingProfileInputSchema,
  executionCatalogInputSchema,
  executionLookupInputSchema,
  executionInputSchema,
  finishExecutionInputSchema,
  loadContextInputSchema,
  memoryCatalogInputSchema,
  memoryInputSchema,
  projectLookupInputSchema,
  projectCatalogInputSchema,
  projectInputSchema,
  putEmbeddingInputSchema,
  semanticSearchInputSchema,
  semanticCandidateTextsInputSchema,
  taskLookupInputSchema,
  taskCatalogInputSchema,
  taskInputSchema,
  taskStatusInputSchema,
} from './schemas.js'

export const FORGE_MCP_TOOL_NAMES = [
  'forge_status',
  'forge_register_project',
  'forge_register_agent',
  'forge_assign_agent',
  'forge_create_task',
  'forge_update_task_status',
  'forge_start_execution',
  'forge_remember',
  'forge_save_decision',
  'forge_compile_context',
  'forge_load_context',
  'forge_finish_execution',
  'forge_get_audit_trail',
  'forge_get_project',
  'forge_get_agent',
  'forge_get_task',
  'forge_get_execution',
  'forge_list_projects',
  'forge_list_tasks',
  'forge_list_executions',
  'forge_list_memories',
  'forge_list_decisions',
  'forge_register_embedding_profile',
  'forge_list_embedding_candidates',
  'forge_put_embedding',
  'forge_semantic_search',
  'forge_get_semantic_candidate_texts',
] as const

export type ForgeGatewayPort = Pick<ForgePersistenceGateway,
  | 'assertReady'
  | 'getProjectByKey'
  | 'listProjects'
  | 'registerProject'
  | 'getAgentByKey'
  | 'registerAgent'
  | 'assignAgent'
  | 'createTask'
  | 'getTaskByKey'
  | 'listTasks'
  | 'updateTaskStatus'
  | 'startExecution'
  | 'getExecutionByKey'
  | 'listExecutions'
  | 'remember'
  | 'listMemories'
  | 'saveDecision'
  | 'listDecisions'
  | 'registerEmbeddingProfile'
  | 'listEmbeddingCandidates'
  | 'putEmbedding'
  | 'semanticSearch'
  | 'getSemanticCandidateTexts'
  | 'compileContinuationContext'
  | 'loadContinuationContext'
  | 'finishExecution'
  | 'getAuditTrail'
>

export interface ForgeMcpServerOptions {
  gateway: ForgeGatewayPort
  logger?: (message: string) => void
}

function success(value: unknown): CallToolResult {
  const body = { result: value }
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
  }
}

function failure(code: string, message: string): CallToolResult {
  const body = { error: { code, message } }
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true,
  }
}

function safeInternalLog(error: unknown): string {
  if (error instanceof Error) return error.name + ': ' + error.message
  return 'Non-Error rejection'
}

async function invoke(
  operation: () => Promise<unknown>,
  logger: (message: string) => void,
): Promise<CallToolResult> {
  try {
    return success(await operation())
  } catch (error) {
    if (error instanceof ForgeGatewayError) {
      return failure(error.code, error.message)
    }
    logger('Unhandled FORGE MCP tool error: ' + safeInternalLog(error))
    return failure('INTERNAL_ERROR', 'The FORGE operation failed unexpectedly')
  }
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const appendAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

export function createForgeMcpServer(options: ForgeMcpServerOptions): McpServer {
  const logger = options.logger ?? ((message: string) => console.error(message))
  const server = new McpServer(
    { name: 'forge-mcp-server', version: '0.1.5' },
    {
      instructions: [
        'Use forge_status before the first workflow operation.',
        'Reuse returned UUIDs instead of inventing identifiers.',
        'After a restart, recover entities through stable-key lookup tools.',
        'Use catalog cursors unchanged when requesting the next page.',
        'Use a stable idempotencyKey when retrying create, remember, decision, embedding, execution or context operations.',
        'Supply precomputed embedding vectors that match the registered profile; FORGE does not call a model provider.',
        'Discover missing or stale embedding candidates in bounded pages and reuse each cursor unchanged.',
        'Always preserve projectId scoping and expectedVersion values returned by FORGE.',
      ].join(' '),
    },
  )

  server.registerTool(
    'forge_status',
    {
      title: 'Check FORGE status',
      description: 'Verify PostgreSQL, compatible FORGE schema and optional pgvector readiness.',
      annotations: readOnlyAnnotations,
    },
    async () => invoke(() => options.gateway.assertReady(), logger),
  )

  server.registerTool(
    'forge_register_project',
    {
      title: 'Register FORGE project',
      description: 'Register or replay a generic project by stable projectKey.',
      inputSchema: projectInputSchema,
      annotations: appendAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.registerProject(input as RegisterProjectInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_register_agent',
    {
      title: 'Register FORGE agent',
      description: 'Register or replay a generic agent by stable agentKey.',
      inputSchema: agentInputSchema,
      annotations: appendAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.registerAgent(input as RegisterAgentInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_assign_agent',
    {
      title: 'Assign agent to project',
      description: 'Create or replay a project-scoped agent assignment.',
      inputSchema: assignmentInputSchema,
      annotations: appendAnnotations,
    },
    async ({ projectId, agentId, assignmentRole }) => invoke(
      () => options.gateway.assignAgent(projectId, agentId, assignmentRole),
      logger,
    ),
  )

  server.registerTool(
    'forge_create_task',
    {
      title: 'Create FORGE task',
      description: 'Create an idempotent project-scoped task.',
      inputSchema: taskInputSchema,
      annotations: appendAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.createTask(input as CreateTaskInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_update_task_status',
    {
      title: 'Update task status',
      description: 'Update task status using its current optimistic-lock version.',
      inputSchema: taskStatusInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => invoke(() => options.gateway.updateTaskStatus(input), logger),
  )

  server.registerTool(
    'forge_start_execution',
    {
      title: 'Start FORGE execution',
      description: 'Start an idempotent task execution for an assigned agent.',
      inputSchema: executionInputSchema,
      annotations: appendAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.startExecution(input as StartExecutionInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_remember',
    {
      title: 'Persist FORGE memory',
      description: 'Persist an idempotent project memory with optional provenance.',
      inputSchema: memoryInputSchema,
      annotations: appendAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.remember(input as RememberInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_save_decision',
    {
      title: 'Persist FORGE decision',
      description: 'Persist an idempotent project decision and its rationale.',
      inputSchema: decisionInputSchema,
      annotations: appendAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.saveDecision(input as SaveDecisionInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_compile_context',
    {
      title: 'Compile continuation context',
      description: 'Materialize an immutable, idempotent context package for task continuation.',
      inputSchema: compileContextInputSchema,
      annotations: appendAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.compileContinuationContext(input as CompileContinuationInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_load_context',
    {
      title: 'Load continuation context',
      description: 'Load a project-scoped context package and report stale source versions.',
      inputSchema: loadContextInputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ projectId, packageId }) => invoke(
      () => options.gateway.loadContinuationContext(projectId, packageId),
      logger,
    ),
  )

  server.registerTool(
    'forge_finish_execution',
    {
      title: 'Finish FORGE execution',
      description: 'Finalize an execution using its current optimistic-lock version.',
      inputSchema: finishExecutionInputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectId, executionId, agentId, expectedVersion, status, details }) => invoke(
      () => options.gateway.finishExecution({
        projectId,
        executionId,
        agentId,
        expectedVersion,
        status,
        ...(details === undefined ? {} : { details: details as JsonObject }),
      }),
      logger,
    ),
  )

  server.registerTool(
    'forge_get_audit_trail',
    {
      title: 'Read execution audit trail',
      description: 'Read the ordered, append-only audit trail for a project execution.',
      inputSchema: auditTrailInputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ projectId, executionId }) => invoke(
      () => options.gateway.getAuditTrail(projectId, executionId),
      logger,
    ),
  )

  server.registerTool(
    'forge_get_project',
    {
      title: 'Find FORGE project',
      description: 'Recover a project by its stable projectKey.',
      inputSchema: projectLookupInputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ projectKey }) => invoke(
      () => options.gateway.getProjectByKey(projectKey),
      logger,
    ),
  )

  server.registerTool(
    'forge_get_agent',
    {
      title: 'Find assigned FORGE agent',
      description: 'Recover an agent by stable agentKey within an assigned project.',
      inputSchema: agentLookupInputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ projectId, agentKey }) => invoke(
      () => options.gateway.getAgentByKey(projectId, agentKey),
      logger,
    ),
  )

  server.registerTool(
    'forge_get_task',
    {
      title: 'Find FORGE task',
      description: 'Recover a non-deleted task by projectId and stable taskKey.',
      inputSchema: taskLookupInputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ projectId, taskKey }) => invoke(
      () => options.gateway.getTaskByKey(projectId, taskKey),
      logger,
    ),
  )

  server.registerTool(
    'forge_get_execution',
    {
      title: 'Find FORGE execution',
      description: 'Recover an execution by projectId and stable executionKey.',
      inputSchema: executionLookupInputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ projectId, executionKey }) => invoke(
      () => options.gateway.getExecutionByKey(projectId, executionKey),
      logger,
    ),
  )

  server.registerTool(
    'forge_list_projects',
    {
      title: 'List FORGE projects',
      description: 'List projects with optional status filter and stable keyset pagination.',
      inputSchema: projectCatalogInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.listProjects(input as ListProjectsInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_list_tasks',
    {
      title: 'List FORGE tasks',
      description: 'List non-deleted project tasks with filters and stable keyset pagination.',
      inputSchema: taskCatalogInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.listTasks(input as ListTasksInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_list_executions',
    {
      title: 'List FORGE executions',
      description: 'List project executions with filters and stable keyset pagination.',
      inputSchema: executionCatalogInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.listExecutions(input as ListExecutionsInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_list_memories',
    {
      title: 'List FORGE memories',
      description: 'List active project memory summaries without loading full content.',
      inputSchema: memoryCatalogInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.listMemories(input as ListMemoriesInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_list_decisions',
    {
      title: 'List FORGE decisions',
      description: 'List project decision summaries without loading full decision bodies.',
      inputSchema: decisionCatalogInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.listDecisions(input as ListDecisionsInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_register_embedding_profile',
    {
      title: 'Register embedding profile',
      description: 'Register or replay a provider-agnostic vector-space contract by stable profileKey.',
      inputSchema: embeddingProfileInputSchema,
      annotations: appendAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.registerEmbeddingProfile(input as RegisterEmbeddingProfileInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_list_embedding_candidates',
    {
      title: 'List embedding candidates',
      description: 'List bounded, deterministic source texts whose current version is not indexed for a profile.',
      inputSchema: embeddingCandidateInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.listEmbeddingCandidates(input as ListEmbeddingCandidatesInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_put_embedding',
    {
      title: 'Store source embedding',
      description: 'Store one precomputed, project-scoped embedding for a versioned FORGE source.',
      inputSchema: putEmbeddingInputSchema,
      annotations: appendAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.putEmbedding(input as PutEmbeddingInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_semantic_search',
    {
      title: 'Search FORGE semantically',
      description: 'Rank current project knowledge with a precomputed query vector and registered distance metric.',
      inputSchema: semanticSearchInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.semanticSearch(input as SemanticSearchInput),
      logger,
    ),
  )

  server.registerTool(
    'forge_get_semantic_candidate_texts',
    {
      title: 'Get semantic candidate texts',
      description: 'Load bounded full text for version-bound semantic candidates in one project, preserving candidate order.',
      inputSchema: semanticCandidateTextsInputSchema,
      annotations: readOnlyAnnotations,
    },
    async (input) => invoke(
      () => options.gateway.getSemanticCandidateTexts(input as GetSemanticCandidateTextsInput),
      logger,
    ),
  )

  return server
}
