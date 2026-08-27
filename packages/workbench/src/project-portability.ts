import {
  canonicalize,
  hashJson,
  type JsonObject,
  type PortableProjectPayloadV1,
} from 'forge-semantic-bridge/workbench'

export const MAX_PORTABLE_BUNDLE_BYTES = 4 * 1024 * 1024
const MAX_BUNDLE_AGENTS = 500
const MAX_BUNDLE_TASKS = 5_000
const MAX_BUNDLE_MEMORIES = 10_000
const MAX_BUNDLE_DECISIONS = 5_000
export const MAX_ONBOARDING_FILES = 64
export const MAX_ONBOARDING_FILE_CHARS = 32_000
export const MAX_ONBOARDING_TOTAL_CHARS = 1_000_000

export interface PortableProjectBundleV1 {
  format: 'forge-project'
  formatVersion: 1
  createdAt: string
  checksum: { algorithm: 'sha256'; value: string }
  payload: PortableProjectPayloadV1
}

export interface OnboardingFileInput {
  path: string
  content: string
}

export interface OnboardingProjectInput {
  projectKey: string
  name: string
  description?: string
  files: OnboardingFileInput[]
}

const allowedRootFiles = /^(readme|agents|changelog|contributing|security|roadmap)(\.(md|mdx|txt|rst))?$|^(package\.json|cargo\.toml|pyproject\.toml|go\.mod|requirements\.txt|pom\.xml|build\.gradle(?:\.kts)?|composer\.json)$/i
const allowedDocExtension = /\.(md|mdx|txt|rst)$/i
const blockedSegment = /^(\.git|node_modules|vendor|dist|build|target|coverage|\.next|\.venv|venv)$/i
const blockedName = /(^|[._-])(env|secret|secrets|credential|credentials|token|tokens|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|id_rsa|id_ed25519)([._-]|$)|^(\.npmrc|\.pypirc|\.netrc|\.aws)$|\.(pem|key|pfx|p12|keystore)$/i

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, name: string, max: number, nullable = false): string | null {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
  if (value.length > max) throw new TypeError(`${name} exceeds ${max} characters`)
  return value
}

function optionalNullableText(value: unknown, name: string, max: number): string | null {
  return value === undefined || value === null ? null : text(value, name, max, false)
}

function list(value: unknown, name: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`)
  if (value.length > max) throw new TypeError(`${name} exceeds ${max} entries`)
  return value
}

function choice<T extends string>(value: unknown, name: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new TypeError(`${name} is unsupported`)
  return value as T
}

function jsonObject(value: unknown, name: string): JsonObject {
  const normalized = canonicalize(value)
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) throw new TypeError(`${name} must be a JSON object`)
  return normalized as JsonObject
}

function nullableReference(value: unknown, name: string): string | null {
  return value === null ? null : text(value, name, 500, false)
}

function uniqueIndex<T>(items: T[], keyOf: (item: T) => string, name: string): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    const key = keyOf(item)
    if (result.has(key)) throw new TypeError(`${name} contains a duplicate key: ${key}`)
    result.set(key, item)
  }
  return result
}

function parsePayload(value: unknown): PortableProjectPayloadV1 {
  const source = record(value, 'payload')
  if (source.formatVersion !== 1 || source.sourceSchemaVersion !== '0.1.3') throw new TypeError('Unsupported FORGE project payload version')
  const project = record(source.project, 'payload.project')
  const agents = list(source.agents, 'payload.agents', MAX_BUNDLE_AGENTS).map((entry, index) => {
    const agent = record(entry, `payload.agents[${index}]`)
    return {
      agentKey: text(agent.agentKey, 'agentKey', 200)!,
      name: text(agent.name, 'agent name', 500)!,
      role: optionalNullableText(agent.role, 'agent role', 200),
      capabilities: jsonObject(agent.capabilities, 'agent capabilities'),
      metadata: jsonObject(agent.metadata, 'agent metadata'),
      assignmentRole: optionalNullableText(agent.assignmentRole, 'assignment role', 200),
    }
  })
  const tasks = list(source.tasks, 'payload.tasks', MAX_BUNDLE_TASKS).map((entry, index) => {
    const task = record(entry, `payload.tasks[${index}]`)
    return {
      taskKey: text(task.taskKey, 'taskKey', 200)!,
      title: text(task.title, 'task title', 500)!,
      objective: optionalNullableText(task.objective, 'task objective', 4_000),
      assignedAgentKey: nullableReference(task.assignedAgentKey, 'assignedAgentKey'),
      status: choice(task.status, 'task status', ['proposed', 'ready', 'in_progress', 'blocked', 'done', 'cancelled'] as const),
      priority: choice(task.priority, 'task priority', ['low', 'normal', 'high', 'critical'] as const),
      metadata: jsonObject(task.metadata, 'task metadata'),
    }
  })
  const memories = list(source.memories, 'payload.memories', MAX_BUNDLE_MEMORIES).map((entry, index) => {
    const memory = record(entry, `payload.memories[${index}]`)
    return {
      portableId: text(memory.portableId, 'memory portableId', 500)!,
      taskKey: nullableReference(memory.taskKey, 'memory taskKey'),
      createdByAgentKey: nullableReference(memory.createdByAgentKey, 'memory createdByAgentKey'),
      memoryType: choice(memory.memoryType, 'memory type', ['episodic', 'semantic', 'project', 'observation', 'execution_summary'] as const),
      epistemicState: choice(memory.epistemicState, 'memory epistemic state', ['verified', 'supported', 'observed', 'inferred', 'hypothesis', 'conflicting', 'unknown', 'invalid'] as const),
      trustLevel: choice(memory.trustLevel, 'memory trust level', ['trusted', 'internal', 'agent_generated', 'external', 'untrusted'] as const),
      title: optionalNullableText(memory.title, 'memory title', 500),
      content: text(memory.content, 'memory content', 32_000)!,
      summary: optionalNullableText(memory.summary, 'memory summary', 4_000),
      importance: choice(memory.importance, 'memory importance', ['low', 'normal', 'high', 'critical'] as const),
      metadata: jsonObject(memory.metadata, 'memory metadata'),
      provenance: list(memory.provenance, 'memory provenance', 100).map((item, provenanceIndex) => {
        const provenance = record(item, `memory provenance[${provenanceIndex}]`)
        return {
          sourceKind: choice(provenance.sourceKind, 'provenance sourceKind', ['document', 'decision', 'execution', 'agent', 'user', 'tool', 'external'] as const),
          sourceRef: text(provenance.sourceRef, 'provenance sourceRef', 2_000)!,
          sourceVersion: optionalNullableText(provenance.sourceVersion, 'provenance sourceVersion', 500),
          evidence: jsonObject(provenance.evidence, 'provenance evidence'),
        }
      }),
    }
  })
  const decisions = list(source.decisions, 'payload.decisions', MAX_BUNDLE_DECISIONS).map((entry, index) => {
    const decision = record(entry, `payload.decisions[${index}]`)
    return {
      decisionKey: text(decision.decisionKey, 'decisionKey', 200)!,
      taskKey: nullableReference(decision.taskKey, 'decision taskKey'),
      createdByAgentKey: nullableReference(decision.createdByAgentKey, 'decision createdByAgentKey'),
      title: text(decision.title, 'decision title', 500)!,
      decisionText: text(decision.decisionText, 'decision text', 32_000)!,
      rationale: optionalNullableText(decision.rationale, 'decision rationale', 32_000),
      alternatives: list(decision.alternatives, 'decision alternatives', 100).map((item) => canonicalize(item)),
      consequences: list(decision.consequences, 'decision consequences', 100).map((item) => canonicalize(item)),
      status: choice(decision.status, 'decision status', ['draft', 'accepted', 'rejected', 'superseded', 'deprecated'] as const),
      supersedesDecisionKey: nullableReference(decision.supersedesDecisionKey, 'supersedesDecisionKey'),
      metadata: jsonObject(decision.metadata, 'decision metadata'),
    }
  })
  const omitted = list(source.omitted, 'payload.omitted', 5)
  const expectedOmitted = ['embeddings', 'executions', 'context_packages', 'events', 'audit_log'] as const
  if (omitted.length !== expectedOmitted.length || expectedOmitted.some((item, index) => omitted[index] !== item)) {
    throw new TypeError('Portable payload omission contract is invalid')
  }
  const agentByKey = uniqueIndex(agents, (agent) => agent.agentKey, 'payload.agents')
  const taskByKey = uniqueIndex(tasks, (task) => task.taskKey, 'payload.tasks')
  uniqueIndex(memories, (memory) => memory.portableId, 'payload.memories')
  const decisionByKey = uniqueIndex(decisions, (decision) => decision.decisionKey, 'payload.decisions')
  for (const task of tasks) {
    if (task.assignedAgentKey && !agentByKey.has(task.assignedAgentKey)) throw new TypeError(`Task references an unknown agent: ${task.assignedAgentKey}`)
  }
  for (const memory of memories) {
    if (memory.taskKey && !taskByKey.has(memory.taskKey)) throw new TypeError(`Memory references an unknown task: ${memory.taskKey}`)
    if (memory.createdByAgentKey && !agentByKey.has(memory.createdByAgentKey)) throw new TypeError(`Memory references an unknown agent: ${memory.createdByAgentKey}`)
  }
  for (const decision of decisions) {
    if (decision.taskKey && !taskByKey.has(decision.taskKey)) throw new TypeError(`Decision references an unknown task: ${decision.taskKey}`)
    if (decision.createdByAgentKey && !agentByKey.has(decision.createdByAgentKey)) throw new TypeError(`Decision references an unknown agent: ${decision.createdByAgentKey}`)
    if (decision.supersedesDecisionKey && !decisionByKey.has(decision.supersedesDecisionKey)) throw new TypeError(`Decision references an unknown superseded decision: ${decision.supersedesDecisionKey}`)
    const visited = new Set<string>()
    let cursor = decision
    while (cursor.supersedesDecisionKey) {
      if (visited.has(cursor.decisionKey)) throw new TypeError(`Decision supersession contains a cycle: ${decision.decisionKey}`)
      visited.add(cursor.decisionKey)
      cursor = decisionByKey.get(cursor.supersedesDecisionKey)!
    }
  }
  return {
    formatVersion: 1,
    sourceSchemaVersion: '0.1.3',
    project: {
      projectKey: text(project.projectKey, 'projectKey', 200)!,
      name: text(project.name, 'project name', 500)!,
      description: optionalNullableText(project.description, 'project description', 4_000),
      metadata: jsonObject(project.metadata, 'project metadata'),
    },
    agents,
    tasks,
    memories,
    decisions,
    omitted: expectedOmitted,
  }
}

export function createPortableProjectBundle(payload: PortableProjectPayloadV1, createdAt = new Date().toISOString()): PortableProjectBundleV1 {
  const validated = parsePayload(payload)
  const bundle: PortableProjectBundleV1 = {
    format: 'forge-project',
    formatVersion: 1,
    createdAt,
    checksum: { algorithm: 'sha256', value: hashJson(validated) },
    payload: validated,
  }
  if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > MAX_PORTABLE_BUNDLE_BYTES) throw new TypeError('Portable project exceeds the 4 MiB v1 limit')
  return bundle
}

export function parsePortableProjectBundle(value: unknown): PortableProjectBundleV1 {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PORTABLE_BUNDLE_BYTES) throw new TypeError('Portable project exceeds the 4 MiB v1 limit')
  const bundle = record(value, 'bundle')
  if (bundle.format !== 'forge-project' || bundle.formatVersion !== 1) throw new TypeError('Unsupported FORGE project bundle')
  const createdAt = text(bundle.createdAt, 'createdAt', 100)!
  if (!Number.isFinite(Date.parse(createdAt))) throw new TypeError('createdAt must be an ISO timestamp')
  const checksum = record(bundle.checksum, 'checksum')
  if (checksum.algorithm !== 'sha256' || typeof checksum.value !== 'string' || !/^[0-9a-f]{64}$/i.test(checksum.value)) {
    throw new TypeError('Bundle checksum is invalid')
  }
  const payload = parsePayload(bundle.payload)
  const actual = hashJson(payload)
  if (actual !== checksum.value.toLowerCase()) throw new TypeError('Bundle checksum mismatch')
  return {
    format: 'forge-project',
    formatVersion: 1,
    createdAt,
    checksum: { algorithm: 'sha256', value: actual },
    payload,
  }
}

export function normalizeOnboardingPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '')
  const segments = normalized.split('/')
  if (!normalized || normalized.startsWith('/') || /^[a-z]:\//i.test(normalized) || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TypeError('Repository files must use safe relative paths')
  }
  if (segments.some((segment) => blockedSegment.test(segment) || blockedName.test(segment))) {
    throw new TypeError(`Repository file is excluded for safety: ${normalized}`)
  }
  const basename = segments.at(-1)!
  const allowed = segments.length === 1 ? allowedRootFiles.test(basename) : allowedDocExtension.test(basename) && /^(docs?|documentation|adr|architecture|decisions)$/i.test(segments[0]!)
  if (!allowed) throw new TypeError(`Repository file type is not supported: ${normalized}`)
  return normalized
}

export function createOnboardingPayload(input: OnboardingProjectInput): PortableProjectPayloadV1 {
  const projectKey = text(input.projectKey, 'projectKey', 200)!
  const name = text(input.name, 'project name', 500)!
  const description = input.description === undefined || !input.description.trim() ? null : text(input.description, 'project description', 4_000)!
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_ONBOARDING_FILES) {
    throw new TypeError(`files must contain between 1 and ${MAX_ONBOARDING_FILES} supported documents`)
  }
  let total = 0
  const seen = new Set<string>()
  const memories = input.files.map((file) => {
    const path = normalizeOnboardingPath(file.path)
    const pathKey = path.toLocaleLowerCase()
    if (seen.has(pathKey)) throw new TypeError(`Repository file is duplicated: ${path}`)
    seen.add(pathKey)
    const content = text(file.content, `content for ${path}`, MAX_ONBOARDING_FILE_CHARS)!
    if (content.includes('\0')) throw new TypeError(`Repository file is not text: ${path}`)
    total += content.length
    if (total > MAX_ONBOARDING_TOTAL_CHARS) throw new TypeError(`Repository content exceeds ${MAX_ONBOARDING_TOTAL_CHARS} characters`)
    const contentHash = hashJson(content)
    return {
      portableId: `repository:${hashJson({ path, contentHash })}`,
      taskKey: null,
      createdByAgentKey: null,
      memoryType: 'project' as const,
      epistemicState: 'observed' as const,
      trustLevel: 'internal' as const,
      title: path,
      content,
      summary: `Imported from ${path}`,
      importance: /readme|agents|architecture|adr/i.test(path) ? 'high' as const : 'normal' as const,
      metadata: { onboarding: { relativePath: path, contentHash } },
      provenance: [{ sourceKind: 'document' as const, sourceRef: path, sourceVersion: contentHash, evidence: { imported: true } }],
    }
  })
  return {
    formatVersion: 1,
    sourceSchemaVersion: '0.1.3',
    project: { projectKey, name, description, metadata: { onboarding: { kind: 'repository', fileCount: memories.length } } },
    agents: [],
    tasks: [],
    memories,
    decisions: [],
    omitted: ['embeddings', 'executions', 'context_packages', 'events', 'audit_log'],
  }
}
