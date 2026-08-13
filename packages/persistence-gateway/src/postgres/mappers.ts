import type {
  Agent,
  AuditRecord,
  Decision,
  DecisionCatalogItem,
  EmbeddingProfile,
  EmbeddingRecord,
  Execution,
  Memory,
  MemoryCatalogItem,
  Project,
  ProjectAgentAssignment,
  ProjectAgentCatalogItem,
  ContinuationPackageCatalogItem,
  SemanticSearchResult,
  Task,
} from '../domain/types.js'
import type { JsonObject, JsonValue } from '../domain/json.js'

export type DatabaseRow = Record<string, unknown>

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return new Date(value).toISOString()
  throw new TypeError('Expected a PostgreSQL timestamp')
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value)
}

function jsonObject(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject
  return {}
}

function jsonArray(value: unknown): JsonValue[] {
  return Array.isArray(value) ? value as JsonValue[] : []
}

export function mapProject(row: DatabaseRow): Project {
  return {
    id: String(row.id),
    projectKey: String(row.project_key),
    name: String(row.name),
    description: row.description === null ? null : String(row.description),
    status: row.status as Project['status'],
    metadata: jsonObject(row.metadata),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function mapAgent(row: DatabaseRow): Agent {
  return {
    id: String(row.id),
    agentKey: String(row.agent_key),
    name: String(row.name),
    role: row.role === null ? null : String(row.role),
    status: row.status as Agent['status'],
    capabilities: jsonObject(row.capabilities),
    metadata: jsonObject(row.metadata),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function mapAssignment(row: DatabaseRow): ProjectAgentAssignment {
  return {
    projectId: String(row.project_id),
    agentId: String(row.agent_id),
    assignmentRole: row.assignment_role === null ? null : String(row.assignment_role),
    status: row.status as ProjectAgentAssignment['status'],
    version: Number(row.version),
    assignedAt: iso(row.assigned_at),
    updatedAt: iso(row.updated_at),
  }
}

export function mapProjectAgentCatalogItem(row: DatabaseRow): ProjectAgentCatalogItem {
  return {
    ...mapAgent(row),
    assignmentRole: row.assignment_role === null ? null : String(row.assignment_role),
    assignmentStatus: row.assignment_status as ProjectAgentAssignment['status'],
    assignmentVersion: Number(row.assignment_version),
    assignedAt: iso(row.assigned_at),
  }
}

export function mapContinuationPackageCatalogItem(row: DatabaseRow): ContinuationPackageCatalogItem {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    executionId: row.execution_id === null ? null : String(row.execution_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    packageHash: String(row.package_hash),
    itemCount: Number(row.item_count),
    createdAt: iso(row.created_at),
  }
}

export function mapTask(row: DatabaseRow): Task {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskKey: String(row.task_key),
    title: String(row.title),
    objective: row.objective === null ? null : String(row.objective),
    assignedAgentId: row.assigned_agent_id === null ? null : String(row.assigned_agent_id),
    status: row.status as Task['status'],
    priority: row.priority as Task['priority'],
    metadata: jsonObject(row.metadata),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function mapMemory(row: DatabaseRow): Memory {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    createdByAgentId: row.created_by_agent_id === null ? null : String(row.created_by_agent_id),
    memoryType: row.memory_type as Memory['memoryType'],
    epistemicState: row.epistemic_state as Memory['epistemicState'],
    trustLevel: row.trust_level as Memory['trustLevel'],
    title: row.title === null ? null : String(row.title),
    content: String(row.content),
    summary: row.summary === null ? null : String(row.summary),
    importance: row.importance as Memory['importance'],
    metadata: jsonObject(row.metadata),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function mapDecision(row: DatabaseRow): Decision {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    createdByAgentId: row.created_by_agent_id === null ? null : String(row.created_by_agent_id),
    decisionKey: String(row.decision_key),
    title: String(row.title),
    decisionText: String(row.decision_text),
    rationale: row.rationale === null ? null : String(row.rationale),
    alternatives: jsonArray(row.alternatives),
    consequences: jsonArray(row.consequences),
    status: row.status as Decision['status'],
    metadata: jsonObject(row.metadata),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function mapDecisionCatalogItem(row: DatabaseRow): DecisionCatalogItem {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    createdByAgentId: row.created_by_agent_id === null ? null : String(row.created_by_agent_id),
    decisionKey: String(row.decision_key),
    title: String(row.title),
    rationale: row.rationale === null ? null : String(row.rationale),
    status: row.status as DecisionCatalogItem['status'],
    metadata: jsonObject(row.metadata),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function mapMemoryCatalogItem(row: DatabaseRow): MemoryCatalogItem {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    createdByAgentId: row.created_by_agent_id === null ? null : String(row.created_by_agent_id),
    memoryType: row.memory_type as MemoryCatalogItem['memoryType'],
    epistemicState: row.epistemic_state as MemoryCatalogItem['epistemicState'],
    trustLevel: row.trust_level as MemoryCatalogItem['trustLevel'],
    title: row.title === null ? null : String(row.title),
    summary: row.summary === null ? null : String(row.summary),
    importance: row.importance as MemoryCatalogItem['importance'],
    metadata: jsonObject(row.metadata),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function mapExecution(row: DatabaseRow): Execution {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    taskId: row.task_id === null ? null : String(row.task_id),
    agentId: row.agent_id === null ? null : String(row.agent_id),
    executionKey: row.execution_key === null ? null : String(row.execution_key),
    status: row.status as Execution['status'],
    policyVersion: row.policy_version === null ? null : String(row.policy_version),
    metadata: jsonObject(row.metadata),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
  }
}

export function mapEmbeddingProfile(row: DatabaseRow): EmbeddingProfile {
  return {
    id: String(row.id),
    profileKey: String(row.profile_key),
    provider: String(row.provider),
    model: String(row.model),
    dimensions: Number(row.dimensions),
    distanceMetric: row.distance_metric as EmbeddingProfile['distanceMetric'],
    status: row.status as EmbeddingProfile['status'],
    metadata: jsonObject(row.metadata),
    version: Number(row.version),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function mapEmbeddingRecord(row: DatabaseRow): EmbeddingRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    profileId: String(row.profile_id),
    profileKey: String(row.profile_key),
    sourceKind: row.source_kind as EmbeddingRecord['sourceKind'],
    sourceId: String(row.source_id),
    sourceVersion: Number(row.source_version),
    dimensions: Number(row.dimensions),
    metadata: jsonObject(row.metadata),
    createdAt: iso(row.created_at),
  }
}

export function mapSemanticSearchResult(row: DatabaseRow): SemanticSearchResult {
  const embeddedSourceVersion = row.embedded_source_version === null
    ? null
    : Number(row.embedded_source_version)
  const currentSourceVersion = Number(row.current_source_version)
  return {
    embeddingId: String(row.embedding_id),
    projectId: String(row.project_id),
    profileId: String(row.profile_id),
    profileKey: String(row.profile_key),
    sourceKind: row.source_kind as SemanticSearchResult['sourceKind'],
    sourceId: String(row.source_id),
    embeddedSourceVersion,
    currentSourceVersion,
    stale: embeddedSourceVersion === null || embeddedSourceVersion !== currentSourceVersion,
    title: row.title === null ? null : String(row.title),
    summary: row.summary === null ? null : String(row.summary),
    distance: Number(row.distance),
    score: Number(row.score),
    metadata: jsonObject(row.metadata),
  }
}

export function mapAuditRecord(row: DatabaseRow): AuditRecord {
  return {
    id: String(row.id),
    action: String(row.action),
    authorizationDecision: row.authorization_decision as AuditRecord['authorizationDecision'],
    resource: row.resource === null ? null : String(row.resource),
    details: jsonObject(row.details),
    recordedAt: iso(row.recorded_at),
  }
}
