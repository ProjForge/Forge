import type { EmbeddingCandidateCursor, EmbeddingDistanceMetric, EmbeddingSourceKind } from 'forge-persistence-gateway'
import type { EmbeddingWorkerRetryOptions } from './types.js'
import type { OpenAiCompatibleEmbeddingProviderOptions } from './providers/openai-compatible.js'

export interface EmbeddingWorkerEnvironment {
  databaseUrl: string
  projectId: string
  profileKey: string
  dimensions: number
  distanceMetric: EmbeddingDistanceMetric
  sourceKinds: readonly EmbeddingSourceKind[]
  cursor?: EmbeddingCandidateCursor
  pageSize: number
  maxCandidates: number
  maxTextChars: number
  inputPrefix?: string
  queryPrefix?: string
  rejectTruncatedText: boolean
  agentId?: string
  executionId?: string
  retry: EmbeddingWorkerRetryOptions
  provider: OpenAiCompatibleEmbeddingProviderOptions
  continuous: boolean
  pollIntervalMs: number
  errorDelayMs: number
  statusFile?: string
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new TypeError(`${name} is required`)
  return value
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = env[name] === undefined ? fallback : Number(env[name])
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase()
  if (value === undefined || value === '') return fallback
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new TypeError(`${name} must be true or false`)
}

function sourceKinds(env: NodeJS.ProcessEnv): readonly EmbeddingSourceKind[] {
  const values = (env.FORGE_EMBEDDING_SOURCE_KINDS ?? 'memory,decision,document_chunk')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const supported = new Set<EmbeddingSourceKind>(['memory', 'decision', 'document_chunk'])
  if (values.length < 1 || values.some((value) => !supported.has(value as EmbeddingSourceKind))) {
    throw new TypeError('FORGE_EMBEDDING_SOURCE_KINDS contains an unsupported value')
  }
  return values as EmbeddingSourceKind[]
}

function distanceMetric(env: NodeJS.ProcessEnv): EmbeddingDistanceMetric {
  const value = env.FORGE_EMBEDDING_DISTANCE_METRIC?.trim() ?? 'cosine'
  if (value !== 'cosine' && value !== 'l2' && value !== 'inner_product') {
    throw new TypeError('FORGE_EMBEDDING_DISTANCE_METRIC is invalid')
  }
  return value
}

function cursor(env: NodeJS.ProcessEnv): EmbeddingCandidateCursor | undefined {
  const sourceKind = env.FORGE_EMBEDDING_CURSOR_KIND?.trim()
  const sourceId = env.FORGE_EMBEDDING_CURSOR_ID?.trim()
  if (!sourceKind && !sourceId) return undefined
  if (!sourceKind || !sourceId) {
    throw new TypeError('FORGE_EMBEDDING_CURSOR_KIND and FORGE_EMBEDDING_CURSOR_ID must be supplied together')
  }
  if (sourceKind !== 'memory' && sourceKind !== 'decision' && sourceKind !== 'document_chunk') {
    throw new TypeError('FORGE_EMBEDDING_CURSOR_KIND is invalid')
  }
  return { sourceKind, sourceId }
}

export function loadEmbeddingWorkerEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingWorkerEnvironment {
  const baseUrl = env.FORGE_EMBEDDING_BASE_URL?.trim() || 'https://api.openai.com/v1'
  const apiKey = env.FORGE_EMBEDDING_API_KEY?.trim()
  if (new URL(baseUrl).hostname === 'api.openai.com' && !apiKey) {
    throw new TypeError('FORGE_EMBEDDING_API_KEY is required for api.openai.com')
  }
  const configuredCursor = cursor(env)
  const inputPrefix = env.FORGE_EMBEDDING_INPUT_PREFIX?.trim()
  const queryPrefix = env.FORGE_EMBEDDING_QUERY_PREFIX?.trim()
  return {
    databaseUrl: required(env, 'FORGE_DATABASE_URL'),
    projectId: required(env, 'FORGE_PROJECT_ID'),
    profileKey: required(env, 'FORGE_EMBEDDING_PROFILE_KEY'),
    dimensions: integer(env, 'FORGE_EMBEDDING_DIMENSIONS', 0, 1, 4096),
    distanceMetric: distanceMetric(env),
    sourceKinds: sourceKinds(env),
    ...(configuredCursor ? { cursor: configuredCursor } : {}),
    pageSize: integer(env, 'FORGE_EMBEDDING_PAGE_SIZE', 20, 1, 50),
    maxCandidates: integer(env, 'FORGE_EMBEDDING_MAX_CANDIDATES', 100, 1, 10_000),
    maxTextChars: integer(env, 'FORGE_EMBEDDING_MAX_TEXT_CHARS', 8_000, 1, 32_000),
    ...(inputPrefix ? { inputPrefix } : {}),
    ...(queryPrefix ? { queryPrefix } : {}),
    rejectTruncatedText: boolean(env, 'FORGE_EMBEDDING_REJECT_TRUNCATED', false),
    ...(env.FORGE_AGENT_ID?.trim() ? { agentId: env.FORGE_AGENT_ID.trim() } : {}),
    ...(env.FORGE_EXECUTION_ID?.trim() ? { executionId: env.FORGE_EXECUTION_ID.trim() } : {}),
    retry: {
      maxAttempts: integer(env, 'FORGE_EMBEDDING_MAX_ATTEMPTS', 4, 1, 10),
      baseDelayMs: integer(env, 'FORGE_EMBEDDING_RETRY_BASE_MS', 250, 1, 60_000),
      maxDelayMs: integer(env, 'FORGE_EMBEDDING_RETRY_MAX_MS', 5_000, 1, 300_000),
    },
    provider: {
      baseUrl,
      model: required(env, 'FORGE_EMBEDDING_MODEL'),
      timeoutMs: integer(env, 'FORGE_EMBEDDING_TIMEOUT_MS', 30_000, 1, 300_000),
      sendDimensions: boolean(env, 'FORGE_EMBEDDING_SEND_DIMENSIONS', true),
      name: env.FORGE_EMBEDDING_PROVIDER_NAME?.trim() || 'openai-compatible',
      ...(apiKey ? { apiKey } : {}),
      ...(env.OPENAI_ORGANIZATION?.trim() ? { organization: env.OPENAI_ORGANIZATION.trim() } : {}),
      ...(env.OPENAI_PROJECT?.trim() ? { project: env.OPENAI_PROJECT.trim() } : {}),
    },
    continuous: boolean(env, 'FORGE_EMBEDDING_CONTINUOUS', false),
    pollIntervalMs: integer(env, 'FORGE_EMBEDDING_POLL_INTERVAL_MS', 30_000, 1_000, 3_600_000),
    errorDelayMs: integer(env, 'FORGE_EMBEDDING_ERROR_DELAY_MS', 15_000, 1_000, 3_600_000),
    ...(env.FORGE_EMBEDDING_STATUS_FILE?.trim() ? { statusFile: env.FORGE_EMBEDDING_STATUS_FILE.trim() } : {}),
  }
}
