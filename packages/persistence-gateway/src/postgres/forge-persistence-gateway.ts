import pg, { type PoolClient } from 'pg'
import { createHash } from 'node:crypto'
import {
  ConflictError,
  NotFoundError,
  OptimisticLockError,
  SchemaCompatibilityError,
} from '../domain/errors.js'
import { hashJson, stableStringify, type JsonObject } from '../domain/json.js'
import type {
  Agent,
  AuditRecord,
  CatalogPage,
  CompileContinuationInput,
  ContinuationPackage,
  CreateTaskInput,
  Decision,
  DecisionCatalogItem,
  EmbeddingCandidate,
  EmbeddingCandidatePage,
  EmbeddingDistanceMetric,
  EmbeddingProfile,
  EmbeddingRecord,
  EmbeddingSourceKind,
  Execution,
  ExecutionStatus,
  GetSemanticCandidateTextsInput,
  ListDecisionsInput,
  ListEmbeddingCandidatesInput,
  ListExecutionsInput,
  ListMemoriesInput,
  ListProjectsInput,
  ListTasksInput,
  Memory,
  MemoryCatalogItem,
  Project,
  ProjectAgentAssignment,
  PutEmbeddingInput,
  RegisterAgentInput,
  RegisterEmbeddingProfileInput,
  RegisterProjectInput,
  RememberInput,
  SaveDecisionInput,
  SemanticSearchInput,
  SemanticSearchResult,
  SemanticCandidateText,
  StartExecutionInput,
  Task,
  TaskStatus,
} from '../domain/types.js'
import { runIdempotent } from './idempotency.js'
import {
  mapAgent,
  mapAssignment,
  mapAuditRecord,
  mapDecision,
  mapDecisionCatalogItem,
  mapEmbeddingProfile,
  mapEmbeddingRecord,
  mapExecution,
  mapMemory,
  mapMemoryCatalogItem,
  mapProject,
  mapSemanticSearchResult,
  mapTask,
  type DatabaseRow,
} from './mappers.js'

const { Pool } = pg
const DEFAULT_CATALOG_LIMIT = 20
const MAX_CATALOG_LIMIT = 100
const DEFAULT_SEMANTIC_LIMIT = 10
const MAX_SEMANTIC_LIMIT = 50
const MAX_EMBEDDING_DIMENSIONS = 4_096
const DEFAULT_EMBEDDING_CANDIDATE_LIMIT = 20
const MAX_EMBEDDING_CANDIDATE_LIMIT = 50
const DEFAULT_EMBEDDING_TEXT_CHARS = 8_000
const MAX_EMBEDDING_TEXT_CHARS = 32_000
const MAX_SEMANTIC_CANDIDATES = 50

interface ContextPackageRow extends DatabaseRow {
  id: string
  project_id: string
  execution_id: string | null
  package_hash: string
  created_at: Date | string
}

interface ContextItemRow extends DatabaseRow {
  source_kind: string
  source_ref: string
  source_version: string | null
}

function nonEmpty(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`${name} must not be empty`)
  return normalized
}

function firstRow(rows: DatabaseRow[], entity: string): DatabaseRow {
  const row = rows[0]
  if (!row) throw new Error(`Expected ${entity} row from PostgreSQL`)
  return row
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function catalogLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_CATALOG_LIMIT
  if (!Number.isInteger(value) || value < 1 || value > MAX_CATALOG_LIMIT) {
    throw new TypeError(`limit must be an integer between 1 and ${MAX_CATALOG_LIMIT}`)
  }
  return value
}

function catalogPage<T extends { id: string; createdAt: string }>(
  rows: DatabaseRow[],
  limit: number,
  mapper: (row: DatabaseRow) => T,
): CatalogPage<T> {
  const items = rows.slice(0, limit).map(mapper)
  const last = items.at(-1)
  return {
    items,
    nextCursor: rows.length > limit && last
      ? { createdAt: last.createdAt, id: last.id }
      : null,
  }
}

function embeddingVector(name: string, value: readonly number[]): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EMBEDDING_DIMENSIONS) {
    throw new TypeError(`${name} must contain between 1 and ${MAX_EMBEDDING_DIMENSIONS} numbers`)
  }
  if (value.some((component) => typeof component !== 'number' || !Number.isFinite(component))) {
    throw new TypeError(`${name} must contain only finite numbers`)
  }
  return [...value]
}

function vectorLiteral(value: readonly number[]): string {
  return `[${value.join(',')}]`
}

function assertProfileVector(profile: EmbeddingProfile, vector: number[], name: string): void {
  if (vector.length !== profile.dimensions) {
    throw new TypeError(`${name} dimension mismatch: expected ${profile.dimensions}, got ${vector.length}`)
  }
  if (profile.distanceMetric === 'cosine' && vector.every((component) => component === 0)) {
    throw new TypeError(`${name} must not be a zero vector for cosine distance`)
  }
}

function embeddingSourceColumn(sourceKind: EmbeddingSourceKind): string {
  switch (sourceKind) {
    case 'memory': return 'memory_id'
    case 'decision': return 'decision_id'
    case 'document_chunk': return 'document_chunk_id'
  }
  throw new TypeError(`Unsupported embedding source kind: ${String(sourceKind)}`)
}

function distanceOperator(metric: EmbeddingDistanceMetric): '<=>' | '<->' | '<#>' {
  switch (metric) {
    case 'cosine': return '<=>'
    case 'l2': return '<->'
    case 'inner_product': return '<#>'
  }
  throw new TypeError(`Unsupported embedding distance metric: ${String(metric)}`)
}

function embeddingCandidatePage(
  rows: DatabaseRow[],
  limit: number,
  profile: EmbeddingProfile,
): EmbeddingCandidatePage {
  const items: EmbeddingCandidate[] = rows.slice(0, limit).map((row) => {
    const text = String(row.embedding_input)
    return {
      projectId: String(row.project_id),
      sourceKind: row.source_kind as EmbeddingSourceKind,
      sourceId: String(row.source_id),
      sourceVersion: Number(row.source_version),
      status: row.candidate_status as EmbeddingCandidate['status'],
      title: row.title === null ? null : String(row.title),
      text,
      textTruncated: row.text_truncated === true,
      inputHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    }
  })
  const last = items.at(-1)
  return {
    profile,
    items,
    nextCursor: rows.length > limit && last
      ? { sourceKind: last.sourceKind, sourceId: last.sourceId }
      : null,
  }
}

export class ForgePersistenceGateway {
  private constructor(private readonly pool: InstanceType<typeof Pool>) {}

  static connect(options: {
    connectionString: string
    maxConnections?: number
    statementTimeoutMs?: number
  }): ForgePersistenceGateway {
    return new ForgePersistenceGateway(new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: options.statementTimeoutMs ?? 15_000,
      application_name: 'forge-persistence-gateway-0.1.5',
    }))
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async assertReady(): Promise<{
    serverVersion: string
    schemaVersion: '0.1.1' | '0.1.2' | '0.1.3'
    vectorVersion: string | null
  }> {
    const schema = await this.pool.query<{ name: string }>(
      `SELECT name
         FROM forge.schema_migrations
        WHERE name IN (
          '0005_forge_schema_0_1_1.sql',
          '0006_forge_schema_0_1_2.sql',
          '0007_forge_schema_0_1_3.sql'
        )`,
    ).catch((error: unknown) => {
      throw new SchemaCompatibilityError(`FORGE schema metadata is unavailable: ${String(error)}`)
    })
    const migrations = new Set(schema.rows.map((row) => row.name))
    if (!migrations.has('0005_forge_schema_0_1_1.sql')) {
      throw new SchemaCompatibilityError('FORGE PostgreSQL Schema 0.1.1 is not fully applied')
    }

    const runtime = await this.pool.query<{
      server_version: string
      vector_version: string | null
    }>(
      `SELECT current_setting('server_version') AS server_version,
              (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version`,
    )
    const row = runtime.rows[0]
    if (!row) throw new SchemaCompatibilityError('PostgreSQL runtime metadata is unavailable')
    return {
      serverVersion: row.server_version,
      schemaVersion: migrations.has('0007_forge_schema_0_1_3.sql')
        ? '0.1.3'
        : migrations.has('0006_forge_schema_0_1_2.sql') ? '0.1.2' : '0.1.1',
      vectorVersion: row.vector_version,
    }
  }

  async registerProject(input: RegisterProjectInput): Promise<Project> {
    const projectKey = nonEmpty('projectKey', input.projectKey)
    const name = nonEmpty('name', input.name)
    const metadata = input.metadata ?? {}
    return this.transaction(async (client) => {
      const inserted = await client.query<DatabaseRow>(
        `INSERT INTO forge.projects(project_key, name, description, metadata)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (project_key) DO NOTHING
         RETURNING *`,
        [projectKey, name, input.description ?? null, JSON.stringify(metadata)],
      )
      if (inserted.rowCount === 1) return mapProject(firstRow(inserted.rows, 'project'))

      const existing = await client.query<DatabaseRow>(
        'SELECT * FROM forge.projects WHERE project_key = $1',
        [projectKey],
      )
      const project = mapProject(firstRow(existing.rows, 'project'))
      const matches = project.name === name
        && project.description === (input.description ?? null)
        && stableStringify(project.metadata) === stableStringify(metadata)
      if (!matches) throw new ConflictError(`Project key already exists with different registration data: ${projectKey}`)
      return project
    })
  }

  async getProjectByKey(projectKey: string): Promise<Project> {
    const normalizedKey = nonEmpty('projectKey', projectKey)
    const result = await this.pool.query<DatabaseRow>(
      'SELECT * FROM forge.projects WHERE project_key = $1',
      [normalizedKey],
    )
    if (result.rowCount === 0) throw new NotFoundError('Project', normalizedKey)
    return mapProject(firstRow(result.rows, 'project'))
  }

  async listProjects(input: ListProjectsInput = {}): Promise<CatalogPage<Project>> {
    const limit = catalogLimit(input.limit)
    const result = await this.pool.query<DatabaseRow>(
      `SELECT * FROM forge.projects
        WHERE ($1::text IS NULL OR status = $1)
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [
        input.status ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
        limit + 1,
      ],
    )
    return catalogPage(result.rows, limit, mapProject)
  }

  async registerEmbeddingProfile(
    input: RegisterEmbeddingProfileInput,
  ): Promise<EmbeddingProfile> {
    const profileKey = nonEmpty('profileKey', input.profileKey)
    const provider = nonEmpty('provider', input.provider)
    const model = nonEmpty('model', input.model)
    if (!Number.isInteger(input.dimensions)
      || input.dimensions < 1
      || input.dimensions > MAX_EMBEDDING_DIMENSIONS) {
      throw new TypeError(`dimensions must be an integer between 1 and ${MAX_EMBEDDING_DIMENSIONS}`)
    }
    const distanceMetric = input.distanceMetric ?? 'cosine'
    if (!['cosine', 'l2', 'inner_product'].includes(distanceMetric)) {
      throw new TypeError(`Unsupported embedding distance metric: ${String(distanceMetric)}`)
    }
    const metadata = input.metadata ?? {}
    await this.assertVectorReady()

    return this.transaction(async (client) => {
      const inserted = await client.query<DatabaseRow>(
        `INSERT INTO forge.embedding_profiles(
           profile_key, provider, model, dimensions, distance_metric, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (profile_key) DO NOTHING
         RETURNING *`,
        [profileKey, provider, model, input.dimensions, distanceMetric, JSON.stringify(metadata)],
      )
      if (inserted.rowCount === 1) {
        return mapEmbeddingProfile(firstRow(inserted.rows, 'embedding profile'))
      }

      const existing = await client.query<DatabaseRow>(
        'SELECT * FROM forge.embedding_profiles WHERE profile_key = $1',
        [profileKey],
      )
      const profile = mapEmbeddingProfile(firstRow(existing.rows, 'embedding profile'))
      const matches = profile.provider === provider
        && profile.model === model
        && profile.dimensions === input.dimensions
        && profile.distanceMetric === distanceMetric
        && profile.status === 'active'
        && stableStringify(profile.metadata) === stableStringify(metadata)
      if (!matches) {
        throw new ConflictError(
          `Embedding profile key already exists with different registration data: ${profileKey}`,
        )
      }
      return profile
    })
  }

  async registerAgent(input: RegisterAgentInput): Promise<Agent> {
    const agentKey = nonEmpty('agentKey', input.agentKey)
    const name = nonEmpty('name', input.name)
    const capabilities = input.capabilities ?? {}
    const metadata = input.metadata ?? {}
    return this.transaction(async (client) => {
      const inserted = await client.query<DatabaseRow>(
        `INSERT INTO forge.agents(agent_key, name, role, capabilities, metadata)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
         ON CONFLICT (agent_key) DO NOTHING
         RETURNING *`,
        [agentKey, name, input.role ?? null, JSON.stringify(capabilities), JSON.stringify(metadata)],
      )
      if (inserted.rowCount === 1) return mapAgent(firstRow(inserted.rows, 'agent'))

      const existing = await client.query<DatabaseRow>(
        'SELECT * FROM forge.agents WHERE agent_key = $1',
        [agentKey],
      )
      const agent = mapAgent(firstRow(existing.rows, 'agent'))
      const matches = agent.name === name
        && agent.role === (input.role ?? null)
        && stableStringify(agent.capabilities) === stableStringify(capabilities)
        && stableStringify(agent.metadata) === stableStringify(metadata)
      if (!matches) throw new ConflictError(`Agent key already exists with different registration data: ${agentKey}`)
      return agent
    })
  }

  async getAgentByKey(projectId: string, agentKey: string): Promise<Agent> {
    const normalizedKey = nonEmpty('agentKey', agentKey)
    const result = await this.pool.query<DatabaseRow>(
      `SELECT agent.*
         FROM forge.agents AS agent
         JOIN forge.project_agents AS assignment
           ON assignment.agent_id = agent.id
        WHERE assignment.project_id = $1
          AND agent.agent_key = $2`,
      [projectId, normalizedKey],
    )
    if (result.rowCount === 0) throw new NotFoundError('Agent', normalizedKey)
    return mapAgent(firstRow(result.rows, 'agent'))
  }

  async assignAgent(
    projectId: string,
    agentId: string,
    assignmentRole?: string,
  ): Promise<ProjectAgentAssignment> {
    return this.transaction(async (client) => {
      const inserted = await client.query<DatabaseRow>(
        `INSERT INTO forge.project_agents(project_id, agent_id, assignment_role)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, agent_id) DO NOTHING
         RETURNING *`,
        [projectId, agentId, assignmentRole ?? null],
      )
      if (inserted.rowCount === 1) return mapAssignment(firstRow(inserted.rows, 'assignment'))

      const existing = await client.query<DatabaseRow>(
        `SELECT * FROM forge.project_agents
          WHERE project_id = $1 AND agent_id = $2`,
        [projectId, agentId],
      )
      const assignment = mapAssignment(firstRow(existing.rows, 'assignment'))
      if (assignment.assignmentRole !== (assignmentRole ?? null)) {
        throw new ConflictError('Agent already has a different assignment role in this project')
      }
      return assignment
    })
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const request = {
      projectId: input.projectId,
      taskKey: nonEmpty('taskKey', input.taskKey),
      title: nonEmpty('title', input.title),
      objective: input.objective ?? null,
      assignedAgentId: input.assignedAgentId ?? null,
      status: input.status ?? 'ready',
      priority: input.priority ?? 'normal',
      metadata: input.metadata ?? {},
    }
    return this.transaction((client) => runIdempotent(client, {
      projectId: input.projectId,
      scope: 'task.create',
      key: nonEmpty('idempotencyKey', input.idempotencyKey),
      request,
    }, async () => {
      const result = await client.query<DatabaseRow>(
        `INSERT INTO forge.tasks(
           project_id, task_key, title, objective, assigned_agent_id, status, priority, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         RETURNING *`,
        [
          request.projectId,
          request.taskKey,
          request.title,
          request.objective,
          request.assignedAgentId,
          request.status,
          request.priority,
          JSON.stringify(request.metadata),
        ],
      )
      return mapTask(firstRow(result.rows, 'task'))
    }))
  }

  async getTaskByKey(projectId: string, taskKey: string): Promise<Task> {
    const normalizedKey = nonEmpty('taskKey', taskKey)
    const result = await this.pool.query<DatabaseRow>(
      `SELECT * FROM forge.tasks
        WHERE project_id = $1
          AND task_key = $2
          AND deleted_at IS NULL`,
      [projectId, normalizedKey],
    )
    if (result.rowCount === 0) throw new NotFoundError('Task', normalizedKey)
    return mapTask(firstRow(result.rows, 'task'))
  }

  async listTasks(input: ListTasksInput): Promise<CatalogPage<Task>> {
    const limit = catalogLimit(input.limit)
    const result = await this.pool.query<DatabaseRow>(
      `SELECT * FROM forge.tasks
        WHERE project_id = $1
          AND deleted_at IS NULL
          AND ($2::text IS NULL OR status = $2)
          AND ($3::text IS NULL OR priority = $3)
          AND ($4::uuid IS NULL OR assigned_agent_id = $4)
          AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $7`,
      [
        input.projectId,
        input.status ?? null,
        input.priority ?? null,
        input.assignedAgentId ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
        limit + 1,
      ],
    )
    return catalogPage(result.rows, limit, mapTask)
  }

  async updateTaskStatus(input: {
    projectId: string
    taskId: string
    expectedVersion: number
    status: TaskStatus
  }): Promise<Task> {
    const result = await this.pool.query<DatabaseRow>(
      `UPDATE forge.tasks
          SET status = $4,
              completed_at = CASE WHEN $4 = 'done' THEN now() ELSE completed_at END
        WHERE id = $1 AND project_id = $2 AND version = $3 AND deleted_at IS NULL
        RETURNING *`,
      [input.taskId, input.projectId, input.expectedVersion, input.status],
    )
    if (result.rowCount === 0) {
      throw new OptimisticLockError('Task', input.taskId, input.expectedVersion)
    }
    return mapTask(firstRow(result.rows, 'task'))
  }

  async startExecution(input: StartExecutionInput): Promise<Execution> {
    const request = {
      projectId: input.projectId,
      taskId: input.taskId,
      agentId: input.agentId,
      executionKey: nonEmpty('executionKey', input.executionKey),
      policyVersion: input.policyVersion ?? null,
      metadata: input.metadata ?? {},
    }
    return this.transaction((client) => runIdempotent(client, {
      projectId: input.projectId,
      scope: 'execution.start',
      key: nonEmpty('idempotencyKey', input.idempotencyKey),
      request,
    }, async () => {
      const result = await client.query<DatabaseRow>(
        `INSERT INTO forge.executions(
           project_id, task_id, agent_id, execution_key, status,
           policy_version, metadata, started_at
         ) VALUES ($1, $2, $3, $4, 'running', $5, $6::jsonb, now())
         RETURNING *`,
        [
          request.projectId,
          request.taskId,
          request.agentId,
          request.executionKey,
          request.policyVersion,
          JSON.stringify(request.metadata),
        ],
      )
      const execution = mapExecution(firstRow(result.rows, 'execution'))
      await this.appendEvent(client, {
        projectId: input.projectId,
        executionId: execution.id,
        agentId: input.agentId,
        eventType: 'execution.started',
        idempotencyKey: `execution.start:${input.idempotencyKey}`,
        payload: { task_id: input.taskId },
      })
      await this.appendAudit(client, {
        projectId: input.projectId,
        executionId: execution.id,
        contextPackageId: null,
        agentId: input.agentId,
        action: 'execution.start',
        resource: `forge.executions/${execution.id}`,
        details: { task_id: input.taskId },
      })
      return execution
    }))
  }

  async getExecutionByKey(projectId: string, executionKey: string): Promise<Execution> {
    const normalizedKey = nonEmpty('executionKey', executionKey)
    const result = await this.pool.query<DatabaseRow>(
      `SELECT * FROM forge.executions
        WHERE project_id = $1
          AND execution_key = $2`,
      [projectId, normalizedKey],
    )
    if (result.rowCount === 0) throw new NotFoundError('Execution', normalizedKey)
    return mapExecution(firstRow(result.rows, 'execution'))
  }

  async listExecutions(input: ListExecutionsInput): Promise<CatalogPage<Execution>> {
    const limit = catalogLimit(input.limit)
    const result = await this.pool.query<DatabaseRow>(
      `SELECT * FROM forge.executions
        WHERE project_id = $1
          AND ($2::text IS NULL OR status = $2)
          AND ($3::uuid IS NULL OR task_id = $3)
          AND ($4::uuid IS NULL OR agent_id = $4)
          AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $7`,
      [
        input.projectId,
        input.status ?? null,
        input.taskId ?? null,
        input.agentId ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
        limit + 1,
      ],
    )
    return catalogPage(result.rows, limit, mapExecution)
  }

  async remember(input: RememberInput): Promise<Memory> {
    const request = {
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      executionId: input.executionId ?? null,
      memoryType: input.memoryType,
      epistemicState: input.epistemicState ?? 'observed',
      trustLevel: input.trustLevel ?? 'agent_generated',
      title: input.title ?? null,
      content: nonEmpty('content', input.content),
      summary: input.summary ?? null,
      importance: input.importance ?? 'normal',
      metadata: input.metadata ?? {},
      provenance: input.provenance ?? null,
    }
    return this.transaction((client) => runIdempotent(client, {
      projectId: input.projectId,
      scope: 'memory.remember',
      key: nonEmpty('idempotencyKey', input.idempotencyKey),
      request,
    }, async () => {
      const result = await client.query<DatabaseRow>(
        `INSERT INTO forge.memories(
           project_id, task_id, created_by_agent_id, memory_type,
           epistemic_state, trust_level, title, content, summary,
           importance, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         RETURNING *`,
        [
          request.projectId,
          request.taskId,
          request.agentId,
          request.memoryType,
          request.epistemicState,
          request.trustLevel,
          request.title,
          request.content,
          request.summary,
          request.importance,
          JSON.stringify(request.metadata),
        ],
      )
      const memory = mapMemory(firstRow(result.rows, 'memory'))
      if (request.provenance) {
        await client.query(
          `INSERT INTO forge.memory_provenance(
             memory_id, source_kind, source_ref, source_version, evidence
           ) VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            memory.id,
            request.provenance.sourceKind,
            nonEmpty('provenance.sourceRef', request.provenance.sourceRef),
            request.provenance.sourceVersion ?? null,
            JSON.stringify(request.provenance.evidence ?? {}),
          ],
        )
      }
      await this.appendEvent(client, {
        projectId: input.projectId,
        executionId: request.executionId,
        agentId: request.agentId,
        eventType: 'memory.remembered',
        idempotencyKey: `memory.remember:${input.idempotencyKey}`,
        payload: { memory_id: memory.id, task_id: request.taskId },
      })
      await this.appendAudit(client, {
        projectId: input.projectId,
        executionId: request.executionId,
        contextPackageId: null,
        agentId: request.agentId,
        action: 'memory.remember',
        resource: `forge.memories/${memory.id}`,
        details: { task_id: request.taskId, importance: request.importance },
      })
      return memory
    }))
  }

  async listMemories(input: ListMemoriesInput): Promise<CatalogPage<MemoryCatalogItem>> {
    const limit = catalogLimit(input.limit)
    const result = await this.pool.query<DatabaseRow>(
      `SELECT id, project_id, task_id, created_by_agent_id, memory_type,
              epistemic_state, trust_level, title, summary, importance,
              metadata, version, created_at, updated_at
         FROM forge.memories
        WHERE project_id = $1
          AND deleted_at IS NULL
          AND status = 'active'
          AND ($2::uuid IS NULL OR task_id = $2)
          AND ($3::uuid IS NULL OR created_by_agent_id = $3)
          AND ($4::text IS NULL OR memory_type = $4)
          AND ($5::text IS NULL OR importance = $5)
          AND ($6::timestamptz IS NULL OR (created_at, id) < ($6::timestamptz, $7::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $8`,
      [
        input.projectId,
        input.taskId ?? null,
        input.createdByAgentId ?? null,
        input.memoryType ?? null,
        input.importance ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
        limit + 1,
      ],
    )
    return catalogPage(result.rows, limit, mapMemoryCatalogItem)
  }

  async saveDecision(input: SaveDecisionInput): Promise<Decision> {
    const request = {
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      executionId: input.executionId ?? null,
      decisionKey: nonEmpty('decisionKey', input.decisionKey),
      title: nonEmpty('title', input.title),
      decisionText: nonEmpty('decisionText', input.decisionText),
      rationale: input.rationale ?? null,
      alternatives: input.alternatives ?? [],
      consequences: input.consequences ?? [],
      status: input.status ?? 'accepted',
      metadata: input.metadata ?? {},
    }
    return this.transaction((client) => runIdempotent(client, {
      projectId: input.projectId,
      scope: 'decision.save',
      key: nonEmpty('idempotencyKey', input.idempotencyKey),
      request,
    }, async () => {
      const result = await client.query<DatabaseRow>(
        `INSERT INTO forge.decisions(
           project_id, task_id, created_by_agent_id, decision_key,
           title, decision_text, rationale, alternatives, consequences,
           status, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::jsonb)
         RETURNING *`,
        [
          request.projectId,
          request.taskId,
          request.agentId,
          request.decisionKey,
          request.title,
          request.decisionText,
          request.rationale,
          JSON.stringify(request.alternatives),
          JSON.stringify(request.consequences),
          request.status,
          JSON.stringify(request.metadata),
        ],
      )
      const decision = mapDecision(firstRow(result.rows, 'decision'))
      await this.appendEvent(client, {
        projectId: input.projectId,
        executionId: request.executionId,
        agentId: request.agentId,
        eventType: 'decision.saved',
        idempotencyKey: `decision.save:${input.idempotencyKey}`,
        payload: { decision_id: decision.id, task_id: request.taskId },
      })
      await this.appendAudit(client, {
        projectId: input.projectId,
        executionId: request.executionId,
        contextPackageId: null,
        agentId: request.agentId,
        action: 'decision.save',
        resource: `forge.decisions/${decision.id}`,
        details: { task_id: request.taskId, status: request.status },
      })
      return decision
    }))
  }

  async listDecisions(input: ListDecisionsInput): Promise<CatalogPage<DecisionCatalogItem>> {
    const limit = catalogLimit(input.limit)
    const result = await this.pool.query<DatabaseRow>(
      `SELECT id, project_id, task_id, created_by_agent_id, decision_key,
              title, rationale, status, metadata, version, created_at, updated_at
         FROM forge.decisions
        WHERE project_id = $1
          AND ($2::uuid IS NULL OR task_id = $2)
          AND ($3::uuid IS NULL OR created_by_agent_id = $3)
          AND ($4::text IS NULL OR status = $4)
          AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $7`,
      [
        input.projectId,
        input.taskId ?? null,
        input.createdByAgentId ?? null,
        input.status ?? null,
        input.cursor?.createdAt ?? null,
        input.cursor?.id ?? null,
        limit + 1,
      ],
    )
    return catalogPage(result.rows, limit, mapDecisionCatalogItem)
  }

  async listEmbeddingCandidates(
    input: ListEmbeddingCandidatesInput,
  ): Promise<EmbeddingCandidatePage> {
    const profileKey = nonEmpty('profileKey', input.profileKey)
    const limit = input.limit ?? DEFAULT_EMBEDDING_CANDIDATE_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EMBEDDING_CANDIDATE_LIMIT) {
      throw new TypeError(
        `limit must be an integer between 1 and ${MAX_EMBEDDING_CANDIDATE_LIMIT}`,
      )
    }
    const maxTextChars = input.maxTextChars ?? DEFAULT_EMBEDDING_TEXT_CHARS
    if (!Number.isInteger(maxTextChars)
      || maxTextChars < 1
      || maxTextChars > MAX_EMBEDDING_TEXT_CHARS) {
      throw new TypeError(
        `maxTextChars must be an integer between 1 and ${MAX_EMBEDDING_TEXT_CHARS}`,
      )
    }
    const allowedKinds = new Set<EmbeddingSourceKind>(['memory', 'decision', 'document_chunk'])
    const sourceKinds = input.sourceKinds ?? null
    if (sourceKinds !== null
      && (sourceKinds.length < 1 || sourceKinds.some((kind) => !allowedKinds.has(kind)))) {
      throw new TypeError('sourceKinds must contain supported source kinds')
    }
    if (input.cursor && !allowedKinds.has(input.cursor.sourceKind)) {
      throw new TypeError('cursor sourceKind must be supported')
    }
    await this.assertVectorReady()

    const profileResult = await this.pool.query<DatabaseRow>(
      `SELECT *
         FROM forge.embedding_profiles
        WHERE profile_key = $1 AND status = 'active'`,
      [profileKey],
    )
    if (profileResult.rowCount !== 1) {
      throw new NotFoundError('Active embedding profile', profileKey)
    }
    const profile = mapEmbeddingProfile(firstRow(profileResult.rows, 'embedding profile'))

    const result = await this.pool.query<DatabaseRow>(
      `WITH sources AS (
         SELECT memory.project_id,
                'memory'::text AS source_kind,
                memory.id AS source_id,
                memory.version AS source_version,
                memory.title,
                concat_ws(E'\n\n',
                  NULLIF(btrim(memory.title), ''),
                  NULLIF(btrim(memory.summary), ''),
                  memory.content
                ) AS embedding_input
           FROM forge.memories AS memory
          WHERE memory.project_id = $1
            AND memory.deleted_at IS NULL
            AND memory.status = 'active'
         UNION ALL
         SELECT decision.project_id,
                'decision'::text,
                decision.id,
                decision.version,
                decision.title,
                concat_ws(E'\n\n',
                  NULLIF(btrim(decision.title), ''),
                  decision.decision_text,
                  NULLIF(btrim(decision.rationale), '')
                )
           FROM forge.decisions AS decision
          WHERE decision.project_id = $1
            AND decision.status IN ('draft', 'accepted')
         UNION ALL
         SELECT chunk.project_id,
                'document_chunk'::text,
                chunk.id,
                chunk.version,
                document.title,
                concat_ws(E'\n\n', NULLIF(btrim(document.title), ''), chunk.content)
           FROM forge.document_chunks AS chunk
           JOIN forge.documents AS document
             ON document.id = chunk.document_id
            AND document.project_id = chunk.project_id
          WHERE chunk.project_id = $1
            AND chunk.deleted_at IS NULL
            AND document.deleted_at IS NULL
       ), candidates AS (
         SELECT source.*,
                EXISTS (
                  SELECT 1
                    FROM forge.embeddings AS embedding
                   WHERE embedding.project_id = source.project_id
                     AND embedding.profile_id = $2
                     AND (
                       (source.source_kind = 'memory' AND embedding.memory_id = source.source_id)
                       OR (source.source_kind = 'decision' AND embedding.decision_id = source.source_id)
                       OR (source.source_kind = 'document_chunk'
                           AND embedding.document_chunk_id = source.source_id)
                     )
                ) AS has_history
           FROM sources AS source
          WHERE ($3::text[] IS NULL OR source.source_kind = ANY($3))
            AND (
              $4::text IS NULL
              OR source.source_kind > $4
              OR (source.source_kind = $4 AND source.source_id > $5::uuid)
            )
            AND NOT EXISTS (
              SELECT 1
                FROM forge.embeddings AS current_embedding
               WHERE current_embedding.project_id = source.project_id
                 AND current_embedding.profile_id = $2
                 AND current_embedding.source_version = source.source_version
                 AND (
                   (source.source_kind = 'memory'
                    AND current_embedding.memory_id = source.source_id)
                   OR (source.source_kind = 'decision'
                       AND current_embedding.decision_id = source.source_id)
                   OR (source.source_kind = 'document_chunk'
                       AND current_embedding.document_chunk_id = source.source_id)
                 )
            )
       )
       SELECT project_id, source_kind, source_id, source_version, title,
              CASE WHEN has_history THEN 'stale' ELSE 'missing' END AS candidate_status,
              left(embedding_input, $6) AS embedding_input,
              char_length(embedding_input) > $6 AS text_truncated
         FROM candidates
        ORDER BY source_kind ASC, source_id ASC
        LIMIT $7`,
      [
        input.projectId,
        profile.id,
        sourceKinds,
        input.cursor?.sourceKind ?? null,
        input.cursor?.sourceId ?? null,
        maxTextChars,
        limit + 1,
      ],
    )
    return embeddingCandidatePage(result.rows, limit, profile)
  }

  async putEmbedding(input: PutEmbeddingInput): Promise<EmbeddingRecord> {
    const profileKey = nonEmpty('profileKey', input.profileKey)
    const vector = embeddingVector('embedding', input.embedding)
    const sourceColumn = embeddingSourceColumn(input.sourceKind)
    if (!Number.isInteger(input.sourceVersion) || input.sourceVersion < 1) {
      throw new TypeError('sourceVersion must be a positive integer')
    }
    const request = {
      projectId: input.projectId,
      profileKey,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      embedding: vector,
      agentId: input.agentId ?? null,
      executionId: input.executionId ?? null,
      metadata: input.metadata ?? {},
    }
    await this.assertVectorReady()

    return this.transaction((client) => runIdempotent(client, {
      projectId: input.projectId,
      scope: 'embedding.put',
      key: nonEmpty('idempotencyKey', input.idempotencyKey),
      request,
    }, async () => {
      const profileResult = await client.query<DatabaseRow>(
        `SELECT *
           FROM forge.embedding_profiles
          WHERE profile_key = $1 AND status = 'active'`,
        [profileKey],
      )
      if (profileResult.rowCount !== 1) {
        throw new NotFoundError('Active embedding profile', profileKey)
      }
      const profile = mapEmbeddingProfile(firstRow(profileResult.rows, 'embedding profile'))
      assertProfileVector(profile, vector, 'embedding')

      const currentSourceVersion = await this.loadEmbeddingSourceVersion(
        client,
        input.projectId,
        input.sourceKind,
        input.sourceId,
      )
      if (currentSourceVersion !== input.sourceVersion) {
        throw new OptimisticLockError('Embedding source', input.sourceId, input.sourceVersion)
      }

      const metadata = {
        ...request.metadata,
        forge_source_version: currentSourceVersion,
      }
      const literal = vectorLiteral(vector)
      const inserted = await client.query<DatabaseRow>(
        `INSERT INTO forge.embeddings(
           project_id, profile_id, ${sourceColumn}, source_version, embedding, metadata
         ) VALUES ($1, $2, $3, $4, $5::vector, $6::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING id, project_id, profile_id, source_version, metadata, created_at,
                   vector_dims(embedding) AS dimensions`,
        [
          input.projectId,
          profile.id,
          input.sourceId,
          currentSourceVersion,
          literal,
          JSON.stringify(metadata),
        ],
      )

      let row = inserted.rows[0]
      if (!row) {
        const existing = await client.query<DatabaseRow>(
          `SELECT id, project_id, profile_id, source_version, metadata, created_at,
                  vector_dims(embedding) AS dimensions,
                  embedding = $5::vector AS same_embedding
             FROM forge.embeddings
            WHERE project_id = $1 AND profile_id = $2 AND ${sourceColumn} = $3
              AND source_version = $4`,
          [input.projectId, profile.id, input.sourceId, currentSourceVersion, literal],
        )
        row = existing.rows[0]
        if (!row) {
          throw new ConflictError('Embedding uniqueness conflict could not be reconstructed')
        }
        const sameMetadata = stableStringify(row.metadata) === stableStringify(metadata)
        if (row.same_embedding !== true || !sameMetadata) {
          throw new ConflictError(
            `Embedding already exists with different data: ${profileKey}/${input.sourceKind}/${input.sourceId}`,
          )
        }
      } else {
        await this.appendEvent(client, {
          projectId: input.projectId,
          executionId: request.executionId,
          agentId: request.agentId,
          eventType: 'embedding.stored',
          idempotencyKey: `embedding.put:${input.idempotencyKey}`,
          payload: {
            embedding_id: String(row.id),
            profile_id: profile.id,
            source_kind: input.sourceKind,
            source_id: input.sourceId,
            source_version: currentSourceVersion,
          },
        })
        await this.appendAudit(client, {
          projectId: input.projectId,
          executionId: request.executionId,
          contextPackageId: null,
          agentId: request.agentId,
          action: 'embedding.put',
          resource: `forge.embeddings/${String(row.id)}`,
          details: {
            profile_key: profileKey,
            source_kind: input.sourceKind,
            source_id: input.sourceId,
            source_version: currentSourceVersion,
          },
        })
      }

      return mapEmbeddingRecord({
        ...row,
        profile_key: profile.profileKey,
        source_kind: input.sourceKind,
        source_id: input.sourceId,
        source_version: currentSourceVersion,
      })
    }))
  }

  async semanticSearch(input: SemanticSearchInput): Promise<SemanticSearchResult[]> {
    const profileKey = nonEmpty('profileKey', input.profileKey)
    const queryVector = embeddingVector('queryEmbedding', input.queryEmbedding)
    const limit = input.limit ?? DEFAULT_SEMANTIC_LIMIT
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEMANTIC_LIMIT) {
      throw new TypeError(`limit must be an integer between 1 and ${MAX_SEMANTIC_LIMIT}`)
    }
    if (input.minScore !== undefined && !Number.isFinite(input.minScore)) {
      throw new TypeError('minScore must be finite')
    }
    const sourceKinds = input.sourceKinds ?? null
    const allowedKinds = new Set<EmbeddingSourceKind>(['memory', 'decision', 'document_chunk'])
    if (sourceKinds !== null
      && (sourceKinds.length < 1 || sourceKinds.some((kind) => !allowedKinds.has(kind)))) {
      throw new TypeError('sourceKinds must contain supported source kinds')
    }
    await this.assertVectorReady()

    const profileResult = await this.pool.query<DatabaseRow>(
      `SELECT *
         FROM forge.embedding_profiles
        WHERE profile_key = $1 AND status = 'active'`,
      [profileKey],
    )
    if (profileResult.rowCount !== 1) {
      throw new NotFoundError('Active embedding profile', profileKey)
    }
    const profile = mapEmbeddingProfile(firstRow(profileResult.rows, 'embedding profile'))
    assertProfileVector(profile, queryVector, 'queryEmbedding')

    const operator = distanceOperator(profile.distanceMetric)
    const scoreExpression = profile.distanceMetric === 'cosine'
      ? '1.0 - distance'
      : profile.distanceMetric === 'l2'
        ? '1.0 / (1.0 + distance)'
        : '-distance'
    const result = await this.pool.query<DatabaseRow>(
      `WITH candidates AS (
         SELECT e.id AS embedding_id,
                e.project_id,
                e.profile_id,
                e.embedding,
                e.metadata,
                CASE
                  WHEN e.memory_id IS NOT NULL THEN 'memory'
                  WHEN e.decision_id IS NOT NULL THEN 'decision'
                  ELSE 'document_chunk'
                END AS source_kind,
                COALESCE(e.memory_id, e.decision_id, e.document_chunk_id) AS source_id,
                e.source_version AS embedded_source_version,
                COALESCE(m.version, d.version, c.version) AS current_source_version,
                CASE
                  WHEN e.memory_id IS NOT NULL THEN m.title
                  WHEN e.decision_id IS NOT NULL THEN d.title
                  ELSE doc.title
                END AS title,
                CASE
                  WHEN e.memory_id IS NOT NULL
                    THEN COALESCE(m.summary, left(m.content, 500))
                  WHEN e.decision_id IS NOT NULL
                    THEN COALESCE(d.rationale, left(d.decision_text, 500))
                  ELSE left(c.content, 500)
                END AS summary
           FROM forge.embeddings e
           LEFT JOIN forge.memories m
             ON m.id = e.memory_id AND m.project_id = e.project_id
           LEFT JOIN forge.decisions d
             ON d.id = e.decision_id AND d.project_id = e.project_id
           LEFT JOIN forge.document_chunks c
             ON c.id = e.document_chunk_id AND c.project_id = e.project_id
           LEFT JOIN forge.documents doc
             ON doc.id = c.document_id AND doc.project_id = c.project_id
          WHERE e.project_id = $1
            AND e.profile_id = $2
            AND (
              (e.memory_id IS NOT NULL AND m.deleted_at IS NULL AND m.status = 'active')
              OR (e.decision_id IS NOT NULL AND d.status IN ('draft', 'accepted'))
              OR (e.document_chunk_id IS NOT NULL
                  AND c.deleted_at IS NULL AND doc.deleted_at IS NULL)
            )
       ), ranked AS (
         SELECT *, embedding ${operator} $3::vector AS distance
           FROM candidates
          WHERE ($4::text[] IS NULL OR source_kind = ANY($4))
            AND ($5::boolean OR embedded_source_version = current_source_version)
       ), scored AS (
         SELECT *, ${scoreExpression} AS score
           FROM ranked
       )
       SELECT embedding_id, project_id, profile_id, $6::text AS profile_key,
              source_kind, source_id, embedded_source_version,
              current_source_version, title, summary, distance, score, metadata
         FROM scored
        WHERE ($7::double precision IS NULL OR score >= $7)
        ORDER BY distance ASC, source_kind ASC, source_id ASC
        LIMIT $8`,
      [
        input.projectId,
        profile.id,
        vectorLiteral(queryVector),
        sourceKinds,
        input.includeStale ?? false,
        profile.profileKey,
        input.minScore ?? null,
        limit,
      ],
    )
    return result.rows.map(mapSemanticSearchResult)
  }

  async getSemanticCandidateTexts(
    input: GetSemanticCandidateTextsInput,
  ): Promise<SemanticCandidateText[]> {
    if (!Array.isArray(input.candidates)
      || input.candidates.length < 1
      || input.candidates.length > MAX_SEMANTIC_CANDIDATES) {
      throw new TypeError(
        `candidates must contain between 1 and ${MAX_SEMANTIC_CANDIDATES} references`,
      )
    }
    const maxTextChars = input.maxTextChars ?? DEFAULT_EMBEDDING_TEXT_CHARS
    if (!Number.isInteger(maxTextChars)
      || maxTextChars < 1
      || maxTextChars > MAX_EMBEDDING_TEXT_CHARS) {
      throw new TypeError(
        `maxTextChars must be an integer between 1 and ${MAX_EMBEDDING_TEXT_CHARS}`,
      )
    }
    const allowedKinds = new Set<EmbeddingSourceKind>(['memory', 'decision', 'document_chunk'])
    const uniqueRefs = new Set<string>()
    for (const candidate of input.candidates) {
      if (!allowedKinds.has(candidate.sourceKind)) {
        throw new TypeError('candidate sourceKind must be supported')
      }
      if (!candidate.sourceId.trim()) throw new TypeError('candidate sourceId must not be empty')
      if (!Number.isInteger(candidate.sourceVersion) || candidate.sourceVersion < 1) {
        throw new TypeError('candidate sourceVersion must be a positive integer')
      }
      const key = `${candidate.sourceKind}/${candidate.sourceId}/${candidate.sourceVersion}`
      if (uniqueRefs.has(key)) throw new TypeError(`duplicate semantic candidate: ${key}`)
      uniqueRefs.add(key)
    }

    const result = await this.pool.query<DatabaseRow>(
      `WITH requested AS (
         SELECT request.source_kind,
                request.source_id,
                request.source_version,
                request.ordinal
           FROM unnest($2::text[], $3::uuid[], $4::bigint[]) WITH ORDINALITY
                AS request(source_kind, source_id, source_version, ordinal)
       ), sources AS (
         SELECT memory.project_id,
                'memory'::text AS source_kind,
                memory.id AS source_id,
                memory.version AS source_version,
                memory.title,
                concat_ws(E'\n\n',
                  NULLIF(btrim(memory.title), ''),
                  NULLIF(btrim(memory.summary), ''),
                  memory.content
                ) AS candidate_text
           FROM forge.memories AS memory
          WHERE memory.project_id = $1
            AND memory.deleted_at IS NULL
            AND memory.status = 'active'
         UNION ALL
         SELECT decision.project_id,
                'decision'::text,
                decision.id,
                decision.version,
                decision.title,
                concat_ws(E'\n\n',
                  NULLIF(btrim(decision.title), ''),
                  decision.decision_text,
                  NULLIF(btrim(decision.rationale), '')
                )
           FROM forge.decisions AS decision
          WHERE decision.project_id = $1
            AND decision.status IN ('draft', 'accepted')
         UNION ALL
         SELECT chunk.project_id,
                'document_chunk'::text,
                chunk.id,
                chunk.version,
                document.title,
                concat_ws(E'\n\n', NULLIF(btrim(document.title), ''), chunk.content)
           FROM forge.document_chunks AS chunk
           JOIN forge.documents AS document
             ON document.id = chunk.document_id
            AND document.project_id = chunk.project_id
          WHERE chunk.project_id = $1
            AND chunk.deleted_at IS NULL
            AND document.deleted_at IS NULL
       )
       SELECT source.project_id,
              source.source_kind,
              source.source_id,
              source.source_version,
              source.title,
              left(source.candidate_text, $5) AS candidate_text,
              char_length(source.candidate_text) > $5 AS text_truncated
         FROM requested AS request
         JOIN sources AS source
           ON source.source_kind = request.source_kind
          AND source.source_id = request.source_id
          AND source.source_version = request.source_version
        ORDER BY request.ordinal`,
      [
        input.projectId,
        input.candidates.map((candidate) => candidate.sourceKind),
        input.candidates.map((candidate) => candidate.sourceId),
        input.candidates.map((candidate) => candidate.sourceVersion),
        maxTextChars,
      ],
    )

    if (result.rows.length !== input.candidates.length) {
      const found = new Set(result.rows.map((row) => (
        `${String(row.source_kind)}/${String(row.source_id)}/${Number(row.source_version)}`
      )))
      const missing = input.candidates.find((candidate) => !found.has(
        `${candidate.sourceKind}/${candidate.sourceId}/${candidate.sourceVersion}`,
      ))
      const ref = missing
        ? `${missing.sourceKind}/${missing.sourceId}@${missing.sourceVersion}`
        : 'unknown'
      throw new NotFoundError('Current semantic candidate', ref)
    }

    return result.rows.map((row) => ({
      projectId: String(row.project_id),
      sourceKind: row.source_kind as EmbeddingSourceKind,
      sourceId: String(row.source_id),
      sourceVersion: Number(row.source_version),
      title: row.title === null ? null : String(row.title),
      text: String(row.candidate_text),
      textTruncated: row.text_truncated === true,
    }))
  }

  async compileContinuationContext(input: CompileContinuationInput): Promise<ContinuationPackage> {
    const memoryLimit = input.memoryLimit ?? 20
    const decisionLimit = input.decisionLimit ?? 20
    if (!Number.isInteger(memoryLimit) || memoryLimit < 1 || memoryLimit > 100) {
      throw new RangeError('memoryLimit must be between 1 and 100')
    }
    if (!Number.isInteger(decisionLimit) || decisionLimit < 1 || decisionLimit > 100) {
      throw new RangeError('decisionLimit must be between 1 and 100')
    }
    const request = {
      projectId: input.projectId,
      taskId: input.taskId,
      agentId: input.agentId,
      executionId: input.executionId,
      memoryLimit,
      decisionLimit,
    }
    return this.transaction((client) => runIdempotent(client, {
      projectId: input.projectId,
      scope: 'context.compile',
      key: nonEmpty('idempotencyKey', input.idempotencyKey),
      request,
    }, async () => {
      const taskResult = await client.query<DatabaseRow>(
        `SELECT * FROM forge.tasks
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [input.taskId, input.projectId],
      )
      if (taskResult.rowCount === 0) throw new NotFoundError('Task', input.taskId)
      const task = mapTask(firstRow(taskResult.rows, 'task'))

      const executionResult = await client.query(
        `SELECT 1 FROM forge.executions
          WHERE id = $1 AND project_id = $2 AND task_id = $3 AND agent_id = $4`,
        [input.executionId, input.projectId, input.taskId, input.agentId],
      )
      if (executionResult.rowCount === 0) throw new NotFoundError('Execution', input.executionId)

      const memoriesResult = await client.query<DatabaseRow>(
        `SELECT * FROM forge.memories
          WHERE project_id = $1
            AND deleted_at IS NULL
            AND status = 'active'
            AND (task_id = $2 OR (task_id IS NULL AND memory_type = 'project'))
          ORDER BY CASE importance
                     WHEN 'critical' THEN 4
                     WHEN 'high' THEN 3
                     WHEN 'normal' THEN 2
                     ELSE 1
                   END DESC,
                   updated_at DESC
          LIMIT $3`,
        [input.projectId, input.taskId, memoryLimit],
      )
      const memories = memoriesResult.rows.map(mapMemory)

      const decisionsResult = await client.query<DatabaseRow>(
        `SELECT * FROM forge.decisions
          WHERE project_id = $1
            AND task_id = $2
            AND status IN ('accepted', 'draft')
          ORDER BY updated_at DESC
          LIMIT $3`,
        [input.projectId, input.taskId, decisionLimit],
      )
      const decisions = decisionsResult.rows.map(mapDecision)
      const packageHash = hashJson({ schema_version: 1, task, memories, decisions })
      const packageResult = await client.query<ContextPackageRow>(
        `INSERT INTO forge.context_packages(
           project_id, execution_id, package_hash, metadata
         ) VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id, project_id, execution_id, package_hash, created_at`,
        [
          input.projectId,
          input.executionId,
          packageHash,
          JSON.stringify({ schema_version: 1, purpose: 'task_continuation', task_id: input.taskId }),
        ],
      )
      const contextPackage = packageResult.rows[0]
      if (!contextPackage) throw new Error('Expected context package row from PostgreSQL')

      const sources = [
        { kind: 'task', ref: task.id, version: task.version, hash: hashJson(task) },
        ...memories.map((memory) => ({ kind: 'memory', ref: memory.id, version: memory.version, hash: hashJson(memory) })),
        ...decisions.map((decision) => ({ kind: 'decision', ref: decision.id, version: decision.version, hash: hashJson(decision) })),
      ]
      for (const [position, source] of sources.entries()) {
        await client.query(
          `INSERT INTO forge.context_package_items(
             context_package_id, project_id, position, source_kind,
             source_ref, source_version, content_hash, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, '{"schema_version":1}'::jsonb)`,
          [contextPackage.id, input.projectId, position, source.kind, source.ref, String(source.version), source.hash],
        )
      }

      await this.appendEvent(client, {
        projectId: input.projectId,
        executionId: input.executionId,
        agentId: input.agentId,
        eventType: 'context.compiled',
        idempotencyKey: `context.compile:${input.idempotencyKey}`,
        payload: {
          context_package_id: contextPackage.id,
          task_id: input.taskId,
          memory_count: memories.length,
          decision_count: decisions.length,
        },
      })
      await this.appendAudit(client, {
        projectId: input.projectId,
        executionId: input.executionId,
        contextPackageId: contextPackage.id,
        agentId: input.agentId,
        action: 'context.compile',
        resource: `forge.context_packages/${contextPackage.id}`,
        details: { task_id: input.taskId, package_hash: packageHash },
      })

      return {
        packageId: contextPackage.id,
        projectId: contextPackage.project_id,
        executionId: contextPackage.execution_id,
        packageHash: contextPackage.package_hash,
        createdAt: iso(contextPackage.created_at),
        task,
        memories,
        decisions,
        staleSources: [],
      }
    }))
  }

  async loadContinuationContext(projectId: string, packageId: string): Promise<ContinuationPackage> {
    const packageResult = await this.pool.query<ContextPackageRow>(
      `SELECT id, project_id, execution_id, package_hash, created_at
         FROM forge.context_packages
        WHERE id = $1 AND project_id = $2`,
      [packageId, projectId],
    )
    const contextPackage = packageResult.rows[0]
    if (!contextPackage) throw new NotFoundError('Context package', packageId)

    const itemsResult = await this.pool.query<ContextItemRow>(
      `SELECT source_kind, source_ref, source_version
         FROM forge.context_package_items
        WHERE context_package_id = $1 AND project_id = $2
        ORDER BY position`,
      [packageId, projectId],
    )
    const taskItem = itemsResult.rows.find((item) => item.source_kind === 'task')
    if (!taskItem) throw new SchemaCompatibilityError(`Context package has no task source: ${packageId}`)

    const taskResult = await this.pool.query<DatabaseRow>(
      'SELECT * FROM forge.tasks WHERE id = $1 AND project_id = $2',
      [taskItem.source_ref, projectId],
    )
    if (taskResult.rowCount === 0) throw new NotFoundError('Task', taskItem.source_ref)
    const task = mapTask(firstRow(taskResult.rows, 'task'))

    const memoryItems = itemsResult.rows.filter((item) => item.source_kind === 'memory')
    const decisionItems = itemsResult.rows.filter((item) => item.source_kind === 'decision')
    const memories = await this.loadMemories(projectId, memoryItems.map((item) => item.source_ref))
    const decisions = await this.loadDecisions(projectId, decisionItems.map((item) => item.source_ref))
    const memoryById = new Map(memories.map((memory) => [memory.id, memory]))
    const decisionById = new Map(decisions.map((decision) => [decision.id, decision]))
    const orderedMemories = memoryItems.map((item) => {
      const memory = memoryById.get(item.source_ref)
      if (!memory) throw new NotFoundError('Memory', item.source_ref)
      return memory
    })
    const orderedDecisions = decisionItems.map((item) => {
      const decision = decisionById.get(item.source_ref)
      if (!decision) throw new NotFoundError('Decision', item.source_ref)
      return decision
    })

    const currentVersions = new Map<string, number>([
      [`task:${task.id}`, task.version],
      ...orderedMemories.map((memory) => [`memory:${memory.id}`, memory.version] as const),
      ...orderedDecisions.map((decision) => [`decision:${decision.id}`, decision.version] as const),
    ])
    const staleSources: ContinuationPackage['staleSources'] = []
    for (const item of itemsResult.rows) {
      if (item.source_kind !== 'task' && item.source_kind !== 'memory' && item.source_kind !== 'decision') continue
      const currentVersion = currentVersions.get(`${item.source_kind}:${item.source_ref}`)
      const packagedVersion = Number(item.source_version)
      if (currentVersion !== undefined && currentVersion !== packagedVersion) {
        staleSources.push({
          sourceKind: item.source_kind,
          sourceRef: item.source_ref,
          packagedVersion,
          currentVersion,
        })
      }
    }

    return {
      packageId: contextPackage.id,
      projectId: contextPackage.project_id,
      executionId: contextPackage.execution_id,
      packageHash: contextPackage.package_hash,
      createdAt: iso(contextPackage.created_at),
      task,
      memories: orderedMemories,
      decisions: orderedDecisions,
      staleSources,
    }
  }

  async finishExecution(input: {
    projectId: string
    executionId: string
    agentId: string
    expectedVersion: number
    status: Extract<ExecutionStatus, 'succeeded' | 'failed' | 'cancelled'>
    details?: JsonObject
  }): Promise<Execution> {
    return this.transaction(async (client) => {
      const result = await client.query<DatabaseRow>(
        `UPDATE forge.executions
            SET status = $5, completed_at = now()
          WHERE id = $1 AND project_id = $2 AND agent_id = $3 AND version = $4
          RETURNING *`,
        [input.executionId, input.projectId, input.agentId, input.expectedVersion, input.status],
      )
      if (result.rowCount === 0) {
        throw new OptimisticLockError('Execution', input.executionId, input.expectedVersion)
      }
      const execution = mapExecution(firstRow(result.rows, 'execution'))
      await this.appendEvent(client, {
        projectId: input.projectId,
        executionId: input.executionId,
        agentId: input.agentId,
        eventType: `execution.${input.status}`,
        idempotencyKey: `execution.finish:${input.executionId}:v${execution.version}`,
        payload: input.details ?? {},
      })
      await this.appendAudit(client, {
        projectId: input.projectId,
        executionId: input.executionId,
        contextPackageId: null,
        agentId: input.agentId,
        action: 'execution.finish',
        resource: `forge.executions/${input.executionId}`,
        details: { status: input.status, ...(input.details ?? {}) },
      })
      return execution
    })
  }

  async getAuditTrail(projectId: string, executionId: string): Promise<AuditRecord[]> {
    const result = await this.pool.query<DatabaseRow>(
      `SELECT * FROM forge.audit_log
        WHERE project_id = $1 AND execution_id = $2
        ORDER BY recorded_at, id`,
      [projectId, executionId],
    )
    return result.rows.map(mapAuditRecord)
  }

  private async assertVectorReady(): Promise<void> {
    const result = await this.pool.query<{ ready: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_extension WHERE extname = 'vector'
       )
       AND to_regclass('forge.embedding_profiles') IS NOT NULL
       AND to_regclass('forge.embeddings') IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM forge.schema_migrations
          WHERE name = '0007_forge_schema_0_1_3.sql'
       ) AS ready`,
    )
    if (result.rows[0]?.ready !== true) {
      throw new SchemaCompatibilityError('FORGE versioned vector layer is not applied')
    }
  }

  private async loadEmbeddingSourceVersion(
    client: PoolClient,
    projectId: string,
    sourceKind: EmbeddingSourceKind,
    sourceId: string,
  ): Promise<number> {
    let version: string | number | undefined
    switch (sourceKind) {
      case 'memory':
        version = (await client.query<{ version: string | number }>(
          `SELECT version
             FROM forge.memories
            WHERE id = $1 AND project_id = $2
              AND deleted_at IS NULL AND status = 'active'`,
          [sourceId, projectId],
        )).rows[0]?.version
        break
      case 'decision':
        version = (await client.query<{ version: string | number }>(
          `SELECT version
             FROM forge.decisions
            WHERE id = $1 AND project_id = $2
              AND status IN ('draft', 'accepted')`,
          [sourceId, projectId],
        )).rows[0]?.version
        break
      case 'document_chunk':
        version = (await client.query<{ version: string | number }>(
          `SELECT chunk.version
             FROM forge.document_chunks chunk
             JOIN forge.documents document
               ON document.id = chunk.document_id
              AND document.project_id = chunk.project_id
            WHERE chunk.id = $1 AND chunk.project_id = $2
              AND chunk.deleted_at IS NULL AND document.deleted_at IS NULL`,
          [sourceId, projectId],
        )).rows[0]?.version
        break
    }
    if (version === undefined) throw new NotFoundError('Active embedding source', sourceId)
    return Number(version)
  }

  private async loadMemories(projectId: string, ids: string[]): Promise<Memory[]> {
    if (ids.length === 0) return []
    const result = await this.pool.query<DatabaseRow>(
      'SELECT * FROM forge.memories WHERE project_id = $1 AND id = ANY($2::uuid[])',
      [projectId, ids],
    )
    return result.rows.map(mapMemory)
  }

  private async loadDecisions(projectId: string, ids: string[]): Promise<Decision[]> {
    if (ids.length === 0) return []
    const result = await this.pool.query<DatabaseRow>(
      'SELECT * FROM forge.decisions WHERE project_id = $1 AND id = ANY($2::uuid[])',
      [projectId, ids],
    )
    return result.rows.map(mapDecision)
  }

  private async appendEvent(client: PoolClient, input: {
    projectId: string
    executionId: string | null
    agentId: string | null
    eventType: string
    idempotencyKey: string
    payload: JsonObject
  }): Promise<void> {
    await client.query(
      `INSERT INTO forge.events(
         project_id, execution_id, agent_id, event_type, idempotency_key, payload
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        input.projectId,
        input.executionId,
        input.agentId,
        input.eventType,
        input.idempotencyKey,
        JSON.stringify(input.payload),
      ],
    )
  }

  private async appendAudit(client: PoolClient, input: {
    projectId: string
    executionId: string | null
    contextPackageId: string | null
    agentId: string | null
    action: string
    resource: string
    details: JsonObject
  }): Promise<void> {
    await client.query(
      `INSERT INTO forge.audit_log(
         project_id, execution_id, context_package_id, agent_id,
         action, authorization_decision, resource, details
       ) VALUES ($1, $2, $3, $4, $5, 'not_applicable', $6, $7::jsonb)`,
      [
        input.projectId,
        input.executionId,
        input.contextPackageId,
        input.agentId,
        input.action,
        input.resource,
        JSON.stringify(input.details),
      ],
    )
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
}
