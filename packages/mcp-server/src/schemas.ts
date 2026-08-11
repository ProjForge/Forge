import { z } from 'zod'

const nonEmpty = (label: string, max = 500) =>
  z.string().trim().min(1, label + ' must not be empty').max(max)

export const uuidSchema = z.string().uuid()
export const idempotencyKeySchema = nonEmpty('idempotencyKey', 200)
export const jsonObjectSchema = z.record(z.string(), z.json())

const embeddingVectorSchema = z.array(z.number().finite()).min(1).max(4_096)

const catalogCursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: uuidSchema,
}).strict()

const catalogPaginationShape = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: catalogCursorSchema.optional(),
}

export const projectInputSchema = z.object({
  projectKey: nonEmpty('projectKey', 200),
  name: nonEmpty('name', 500),
  description: z.string().max(10_000).optional(),
  metadata: jsonObjectSchema.optional(),
}).strict()

export const projectLookupInputSchema = z.object({
  projectKey: nonEmpty('projectKey', 200),
}).strict()

export const projectCatalogInputSchema = z.object({
  ...catalogPaginationShape,
  status: z.enum(['active', 'paused', 'archived']).optional(),
}).strict()

export const agentInputSchema = z.object({
  agentKey: nonEmpty('agentKey', 200),
  name: nonEmpty('name', 500),
  role: z.string().max(200).optional(),
  capabilities: jsonObjectSchema.optional(),
  metadata: jsonObjectSchema.optional(),
}).strict()

export const agentLookupInputSchema = z.object({
  projectId: uuidSchema,
  agentKey: nonEmpty('agentKey', 200),
}).strict()

export const assignmentInputSchema = z.object({
  projectId: uuidSchema,
  agentId: uuidSchema,
  assignmentRole: z.string().max(200).optional(),
}).strict()

export const taskInputSchema = z.object({
  projectId: uuidSchema,
  taskKey: nonEmpty('taskKey', 200),
  title: nonEmpty('title', 1_000),
  objective: z.string().max(100_000).optional(),
  assignedAgentId: uuidSchema.optional(),
  status: z.enum(['proposed', 'ready', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  metadata: jsonObjectSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict()

export const taskLookupInputSchema = z.object({
  projectId: uuidSchema,
  taskKey: nonEmpty('taskKey', 200),
}).strict()

export const taskCatalogInputSchema = z.object({
  ...catalogPaginationShape,
  projectId: uuidSchema,
  status: z.enum(['proposed', 'ready', 'in_progress', 'blocked', 'done', 'cancelled']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  assignedAgentId: uuidSchema.optional(),
}).strict()

export const taskStatusInputSchema = z.object({
  projectId: uuidSchema,
  taskId: uuidSchema,
  expectedVersion: z.number().int().positive(),
  status: z.enum(['proposed', 'ready', 'in_progress', 'blocked', 'done', 'cancelled']),
}).strict()

export const executionInputSchema = z.object({
  projectId: uuidSchema,
  taskId: uuidSchema,
  agentId: uuidSchema,
  executionKey: nonEmpty('executionKey', 200),
  policyVersion: z.string().max(200).optional(),
  metadata: jsonObjectSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict()

export const executionLookupInputSchema = z.object({
  projectId: uuidSchema,
  executionKey: nonEmpty('executionKey', 200),
}).strict()

export const executionCatalogInputSchema = z.object({
  ...catalogPaginationShape,
  projectId: uuidSchema,
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
  taskId: uuidSchema.optional(),
  agentId: uuidSchema.optional(),
}).strict()

export const memoryCatalogInputSchema = z.object({
  ...catalogPaginationShape,
  projectId: uuidSchema,
  taskId: uuidSchema.optional(),
  createdByAgentId: uuidSchema.optional(),
  memoryType: z.enum(['episodic', 'semantic', 'project', 'observation', 'execution_summary']).optional(),
  importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
}).strict()

export const decisionCatalogInputSchema = z.object({
  ...catalogPaginationShape,
  projectId: uuidSchema,
  taskId: uuidSchema.optional(),
  createdByAgentId: uuidSchema.optional(),
  status: z.enum(['draft', 'accepted', 'rejected', 'superseded', 'deprecated']).optional(),
}).strict()

export const embeddingProfileInputSchema = z.object({
  profileKey: nonEmpty('profileKey', 200),
  provider: nonEmpty('provider', 500),
  model: nonEmpty('model', 500),
  dimensions: z.number().int().min(1).max(4_096),
  distanceMetric: z.enum(['cosine', 'l2', 'inner_product']).optional(),
  metadata: jsonObjectSchema.optional(),
}).strict()

const embeddingCandidateCursorSchema = z.object({
  sourceKind: z.enum(['memory', 'decision', 'document_chunk']),
  sourceId: uuidSchema,
}).strict()

export const embeddingCandidateInputSchema = z.object({
  projectId: uuidSchema,
  profileKey: nonEmpty('profileKey', 200),
  sourceKinds: z.array(z.enum(['memory', 'decision', 'document_chunk'])).min(1).max(3).optional(),
  cursor: embeddingCandidateCursorSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
  maxTextChars: z.number().int().min(1).max(32_000).optional(),
}).strict()

export const putEmbeddingInputSchema = z.object({
  projectId: uuidSchema,
  profileKey: nonEmpty('profileKey', 200),
  sourceKind: z.enum(['memory', 'decision', 'document_chunk']),
  sourceId: uuidSchema,
  sourceVersion: z.number().int().positive(),
  embedding: embeddingVectorSchema,
  agentId: uuidSchema.optional(),
  executionId: uuidSchema.optional(),
  metadata: jsonObjectSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict()

export const semanticSearchInputSchema = z.object({
  projectId: uuidSchema,
  profileKey: nonEmpty('profileKey', 200),
  queryEmbedding: embeddingVectorSchema,
  sourceKinds: z.array(z.enum(['memory', 'decision', 'document_chunk'])).min(1).max(3).optional(),
  includeStale: z.boolean().optional(),
  minScore: z.number().finite().optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict()

const semanticCandidateRefSchema = z.object({
  sourceKind: z.enum(['memory', 'decision', 'document_chunk']),
  sourceId: uuidSchema,
  sourceVersion: z.number().int().positive(),
}).strict()

export const semanticCandidateTextsInputSchema = z.object({
  projectId: uuidSchema,
  candidates: z.array(semanticCandidateRefSchema).min(1).max(50),
  maxTextChars: z.number().int().min(1).max(32_000).optional(),
}).strict()

export const memoryInputSchema = z.object({
  projectId: uuidSchema,
  taskId: uuidSchema.optional(),
  agentId: uuidSchema.optional(),
  executionId: uuidSchema.optional(),
  memoryType: z.enum(['episodic', 'semantic', 'project', 'observation', 'execution_summary']),
  epistemicState: z.enum([
    'verified',
    'supported',
    'observed',
    'inferred',
    'hypothesis',
    'conflicting',
    'unknown',
    'invalid',
  ]).optional(),
  trustLevel: z.enum(['trusted', 'internal', 'agent_generated', 'external', 'untrusted']).optional(),
  title: z.string().max(1_000).optional(),
  content: nonEmpty('content', 1_000_000),
  summary: z.string().max(100_000).optional(),
  importance: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  metadata: jsonObjectSchema.optional(),
  provenance: z.object({
    sourceKind: z.enum(['document', 'decision', 'execution', 'agent', 'user', 'tool', 'external']),
    sourceRef: nonEmpty('sourceRef', 1_000),
    sourceVersion: z.string().max(200).optional(),
    evidence: jsonObjectSchema.optional(),
  }).strict().optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict()

export const decisionInputSchema = z.object({
  projectId: uuidSchema,
  taskId: uuidSchema.optional(),
  agentId: uuidSchema.optional(),
  executionId: uuidSchema.optional(),
  decisionKey: nonEmpty('decisionKey', 200),
  title: nonEmpty('title', 1_000),
  decisionText: nonEmpty('decisionText', 1_000_000),
  rationale: z.string().max(100_000).optional(),
  alternatives: z.array(z.json()).max(100).optional(),
  consequences: z.array(z.json()).max(100).optional(),
  status: z.enum(['draft', 'accepted', 'rejected', 'superseded', 'deprecated']).optional(),
  metadata: jsonObjectSchema.optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict()

export const compileContextInputSchema = z.object({
  projectId: uuidSchema,
  taskId: uuidSchema,
  agentId: uuidSchema,
  executionId: uuidSchema,
  memoryLimit: z.number().int().min(1).max(100).optional(),
  decisionLimit: z.number().int().min(1).max(100).optional(),
  idempotencyKey: idempotencyKeySchema,
}).strict()

export const loadContextInputSchema = z.object({
  projectId: uuidSchema,
  packageId: uuidSchema,
}).strict()

export const finishExecutionInputSchema = z.object({
  projectId: uuidSchema,
  executionId: uuidSchema,
  agentId: uuidSchema,
  expectedVersion: z.number().int().positive(),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  details: jsonObjectSchema.optional(),
}).strict()

export const auditTrailInputSchema = z.object({
  projectId: uuidSchema,
  executionId: uuidSchema,
}).strict()
