import type { SemanticBridgeProfile } from './types.js'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new TypeError(`${name} is required`)
  return value
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback?: number): number {
  const raw = env[name]
  const value = raw === undefined && fallback !== undefined ? fallback : Number(raw)
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`)
  return value
}

export interface SemanticBridgeConfig {
  databaseUrl: string
  baseUrl: string
  model: string
  apiKey?: string
  profile: SemanticBridgeProfile
  timeoutMs: number
  sendDimensions: boolean
  reranker?: {
    baseUrl: string
    model: string
    apiKey?: string
    timeoutMs: number
    candidateCount: number
    maxTextChars: number
  }
}

export function loadSemanticBridgeConfig(env: NodeJS.ProcessEnv = process.env): SemanticBridgeConfig {
  const apiKey = env.FORGE_EMBEDDING_API_KEY?.trim()
  const queryPrefix = env.FORGE_EMBEDDING_QUERY_PREFIX?.trim()
  const rerankerModel = env.FORGE_RERANKER_MODEL?.trim()
  const rerankerApiKey = env.FORGE_RERANKER_API_KEY?.trim()
  const baseUrl = required(env, 'FORGE_EMBEDDING_BASE_URL')
  return {
    databaseUrl: required(env, 'FORGE_DATABASE_URL'),
    baseUrl,
    model: required(env, 'FORGE_EMBEDDING_MODEL'),
    ...(apiKey ? { apiKey } : {}),
    profile: {
      profileKey: required(env, 'FORGE_EMBEDDING_PROFILE_KEY'),
      dimensions: integer(env, 'FORGE_EMBEDDING_DIMENSIONS'),
      ...(queryPrefix ? { queryPrefix } : {}),
    },
    timeoutMs: integer(env, 'FORGE_EMBEDDING_TIMEOUT_MS', 30_000),
    sendDimensions: env.FORGE_EMBEDDING_SEND_DIMENSIONS !== 'false',
    ...(rerankerModel ? {
      reranker: {
        baseUrl: env.FORGE_RERANKER_BASE_URL?.trim() || baseUrl,
        model: rerankerModel,
        ...(rerankerApiKey ? { apiKey: rerankerApiKey } : {}),
        timeoutMs: integer(env, 'FORGE_RERANKER_TIMEOUT_MS', 30_000),
        candidateCount: integer(env, 'FORGE_RERANKER_CANDIDATES', 5),
        maxTextChars: integer(env, 'FORGE_RERANKER_MAX_TEXT_CHARS', 8_000),
      },
    } : {}),
  }
}
