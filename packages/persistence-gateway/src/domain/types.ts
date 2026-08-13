import type { JsonObject, JsonValue } from './json.js'

export type ProjectStatus = 'active' | 'paused' | 'archived'
export type AgentStatus = 'active' | 'disabled' | 'retired' | 'quarantined'
export type TaskStatus = 'proposed' | 'ready' | 'in_progress' | 'blocked' | 'done' | 'cancelled'
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical'
export type MemoryType = 'episodic' | 'semantic' | 'project' | 'observation' | 'execution_summary'
export type EpistemicState = 'verified' | 'supported' | 'observed' | 'inferred' | 'hypothesis' | 'conflicting' | 'unknown' | 'invalid'
export type TrustLevel = 'trusted' | 'internal' | 'agent_generated' | 'external' | 'untrusted'
export type Importance = 'low' | 'normal' | 'high' | 'critical'
export type DecisionStatus = 'draft' | 'accepted' | 'rejected' | 'superseded' | 'deprecated'
export type ExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type ProvenanceKind = 'document' | 'decision' | 'execution' | 'agent' | 'user' | 'tool' | 'external'
export type EmbeddingDistanceMetric = 'cosine' | 'l2' | 'inner_product'
export type EmbeddingSourceKind = 'memory' | 'decision' | 'document_chunk'
export type EmbeddingCandidateStatus = 'missing' | 'stale'

export interface Project {
  id: string
  projectKey: string
  name: string
  description: string | null
  status: ProjectStatus
  metadata: JsonObject
  version: number
  createdAt: string
  updatedAt: string
}

export interface Agent {
  id: string
  agentKey: string
  name: string
  role: string | null
  status: AgentStatus
  capabilities: JsonObject
  metadata: JsonObject
  version: number
  createdAt: string
  updatedAt: string
}

export interface ProjectAgentAssignment {
  projectId: string
  agentId: string
  assignmentRole: string | null
  status: 'active' | 'inactive'
  version: number
  assignedAt: string
  updatedAt: string
}

export interface ProjectAgentCatalogItem extends Agent {
  assignmentRole: string | null
  assignmentStatus: ProjectAgentAssignment['status']
  assignmentVersion: number
  assignedAt: string
}

export interface Task {
  id: string
  projectId: string
  taskKey: string
  title: string
  objective: string | null
  assignedAgentId: string | null
  status: TaskStatus
  priority: TaskPriority
  metadata: JsonObject
  version: number
  createdAt: string
  updatedAt: string
}

export interface Memory {
  id: string
  projectId: string
  taskId: string | null
  createdByAgentId: string | null
  memoryType: MemoryType
  epistemicState: EpistemicState
  trustLevel: TrustLevel
  title: string | null
  content: string
  summary: string | null
  importance: Importance
  metadata: JsonObject
  version: number
  createdAt: string
  updatedAt: string
}

export interface Decision {
  id: string
  projectId: string
  taskId: string | null
  createdByAgentId: string | null
  decisionKey: string
  title: string
  decisionText: string
  rationale: string | null
  alternatives: JsonValue[]
  consequences: JsonValue[]
  status: DecisionStatus
  metadata: JsonObject
  version: number
  createdAt: string
  updatedAt: string
}

export interface Execution {
  id: string
  projectId: string
  taskId: string | null
  agentId: string | null
  executionKey: string | null
  status: ExecutionStatus
  policyVersion: string | null
  metadata: JsonObject
  version: number
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

export interface EmbeddingProfile {
  id: string
  profileKey: string
  provider: string
  model: string
  dimensions: number
  distanceMetric: EmbeddingDistanceMetric
  status: 'active' | 'inactive'
  metadata: JsonObject
  version: number
  createdAt: string
  updatedAt: string
}

export interface EmbeddingRecord {
  id: string
  projectId: string
  profileId: string
  profileKey: string
  sourceKind: EmbeddingSourceKind
  sourceId: string
  sourceVersion: number
  dimensions: number
  metadata: JsonObject
  createdAt: string
}

export interface SemanticSearchResult {
  embeddingId: string
  projectId: string
  profileId: string
  profileKey: string
  sourceKind: EmbeddingSourceKind
  sourceId: string
  embeddedSourceVersion: number | null
  currentSourceVersion: number
  stale: boolean
  title: string | null
  summary: string | null
  distance: number
  score: number
  metadata: JsonObject
}

export interface SemanticCandidateRef {
  sourceKind: EmbeddingSourceKind
  sourceId: string
  sourceVersion: number
}

export interface SemanticCandidateText extends SemanticCandidateRef {
  projectId: string
  title: string | null
  text: string
  textTruncated: boolean
}

export interface EmbeddingCandidateCursor {
  sourceKind: EmbeddingSourceKind
  sourceId: string
}

export interface EmbeddingCandidate {
  projectId: string
  sourceKind: EmbeddingSourceKind
  sourceId: string
  sourceVersion: number
  status: EmbeddingCandidateStatus
  title: string | null
  text: string
  textTruncated: boolean
  inputHash: string
}

export interface EmbeddingCandidatePage {
  profile: EmbeddingProfile
  items: EmbeddingCandidate[]
  nextCursor: EmbeddingCandidateCursor | null
}

export interface CatalogCursor {
  createdAt: string
  id: string
}

export interface CatalogPage<T> {
  items: T[]
  nextCursor: CatalogCursor | null
}

export interface ContinuationPackageCatalogItem {
  id: string
  projectId: string
  executionId: string | null
  taskId: string | null
  packageHash: string
  itemCount: number
  createdAt: string
}

export interface MemoryCatalogItem {
  id: string
  projectId: string
  taskId: string | null
  createdByAgentId: string | null
  memoryType: MemoryType
  epistemicState: EpistemicState
  trustLevel: TrustLevel
  title: string | null
  summary: string | null
  importance: Importance
  metadata: JsonObject
  version: number
  createdAt: string
  updatedAt: string
}

export interface DecisionCatalogItem {
  id: string
  projectId: string
  taskId: string | null
  createdByAgentId: string | null
  decisionKey: string
  title: string
  rationale: string | null
  status: DecisionStatus
  metadata: JsonObject
  version: number
  createdAt: string
  updatedAt: string
}

interface CatalogPaginationInput {
  limit?: number
  cursor?: CatalogCursor
}

export interface ListProjectsInput extends CatalogPaginationInput {
  status?: ProjectStatus
}

export interface ListProjectAgentsInput extends CatalogPaginationInput {
  projectId: string
  status?: ProjectAgentAssignment['status']
}

export interface ListContinuationPackagesInput extends CatalogPaginationInput {
  projectId: string
  executionId?: string
}

export interface ListTasksInput extends CatalogPaginationInput {
  projectId: string
  status?: TaskStatus
  priority?: TaskPriority
  assignedAgentId?: string
}

export interface ListExecutionsInput extends CatalogPaginationInput {
  projectId: string
  status?: ExecutionStatus
  taskId?: string
  agentId?: string
}

export interface ListMemoriesInput extends CatalogPaginationInput {
  projectId: string
  taskId?: string
  createdByAgentId?: string
  memoryType?: MemoryType
  importance?: Importance
}

export interface ListDecisionsInput extends CatalogPaginationInput {
  projectId: string
  taskId?: string
  createdByAgentId?: string
  status?: DecisionStatus
}

export interface RegisterProjectInput {
  projectKey: string
  name: string
  description?: string
  metadata?: JsonObject
}

export interface RegisterAgentInput {
  agentKey: string
  name: string
  role?: string
  capabilities?: JsonObject
  metadata?: JsonObject
}

export interface RegisterEmbeddingProfileInput {
  profileKey: string
  provider: string
  model: string
  dimensions: number
  distanceMetric?: EmbeddingDistanceMetric
  metadata?: JsonObject
}

export interface PutEmbeddingInput {
  projectId: string
  profileKey: string
  sourceKind: EmbeddingSourceKind
  sourceId: string
  sourceVersion: number
  embedding: readonly number[]
  agentId?: string
  executionId?: string
  metadata?: JsonObject
  idempotencyKey: string
}

export interface SemanticSearchInput {
  projectId: string
  profileKey: string
  queryEmbedding: readonly number[]
  sourceKinds?: readonly EmbeddingSourceKind[]
  includeStale?: boolean
  minScore?: number
  limit?: number
}

export interface GetSemanticCandidateTextsInput {
  projectId: string
  candidates: readonly SemanticCandidateRef[]
  maxTextChars?: number
}

export interface ListEmbeddingCandidatesInput {
  projectId: string
  profileKey: string
  sourceKinds?: readonly EmbeddingSourceKind[]
  cursor?: EmbeddingCandidateCursor
  limit?: number
  maxTextChars?: number
}

export interface CreateTaskInput {
  projectId: string
  taskKey: string
  title: string
  objective?: string
  assignedAgentId?: string
  status?: TaskStatus
  priority?: TaskPriority
  metadata?: JsonObject
  idempotencyKey: string
}

export interface StartExecutionInput {
  projectId: string
  taskId: string
  agentId: string
  executionKey: string
  policyVersion?: string
  metadata?: JsonObject
  idempotencyKey: string
}

export interface RememberInput {
  projectId: string
  taskId?: string
  agentId?: string
  executionId?: string
  memoryType: MemoryType
  epistemicState?: EpistemicState
  trustLevel?: TrustLevel
  title?: string
  content: string
  summary?: string
  importance?: Importance
  metadata?: JsonObject
  provenance?: {
    sourceKind: ProvenanceKind
    sourceRef: string
    sourceVersion?: string
    evidence?: JsonObject
  }
  idempotencyKey: string
}

export interface SaveDecisionInput {
  projectId: string
  taskId?: string
  agentId?: string
  executionId?: string
  decisionKey: string
  title: string
  decisionText: string
  rationale?: string
  alternatives?: JsonValue[]
  consequences?: JsonValue[]
  status?: DecisionStatus
  metadata?: JsonObject
  idempotencyKey: string
}

export interface CompileContinuationInput {
  projectId: string
  taskId: string
  agentId: string
  executionId: string
  memoryLimit?: number
  decisionLimit?: number
  idempotencyKey: string
}

export interface ContinuationPackage {
  packageId: string
  projectId: string
  executionId: string | null
  packageHash: string
  createdAt: string
  task: Task
  memories: Memory[]
  decisions: Decision[]
  staleSources: Array<{
    sourceKind: 'task' | 'memory' | 'decision'
    sourceRef: string
    packagedVersion: number
    currentVersion: number
  }>
}

export interface AuditRecord {
  id: string
  action: string
  authorizationDecision: 'allowed' | 'denied' | 'not_applicable'
  resource: string | null
  details: JsonObject
  recordedAt: string
}
