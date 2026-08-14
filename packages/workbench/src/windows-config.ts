import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, win32 } from 'node:path'

export interface WindowsWorkbenchConfig {
  database: {
    host: string
    port: number
    name: string
    user: string
    credentialFile: string
  }
  workbench: { port: number }
  embedding: {
    baseUrl: string
    model: string
    profileKey: string
    dimensions: number
    queryPrefix: string
    rerankerModel: string
  }
}

export const defaultWindowsConfig: WindowsWorkbenchConfig = {
  database: {
    host: '127.0.0.1', port: 5432, name: 'forge',
    user: 'forge_runtime', credentialFile: 'forge-runtime.dpapi',
  },
  workbench: { port: 7334 },
  embedding: {
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'text-embedding-qwen3-embedding-0.6b',
    profileKey: 'qwen3-embedding-0.6b-q8-1024-forge-retrieval-v1',
    dimensions: 1024,
    queryPrefix: 'Instruct: Given a user question about a software project, retrieve the most relevant project decision or memory that answers the question\nQuery:',
    rerankerModel: 'forge-reranker-qwen35-9b',
  },
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, name: string, fallback?: string): string {
  const candidate = value === undefined ? fallback : value
  if (typeof candidate !== 'string' || !candidate.trim()) throw new TypeError(`${name} must be a non-empty string`)
  return candidate.trim()
}

function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const candidate = value === undefined ? fallback : value
  if (!Number.isInteger(candidate) || (candidate as number) < minimum || (candidate as number) > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return candidate as number
}

export function parseWindowsConfig(value: unknown): WindowsWorkbenchConfig {
  const root = record(value, 'config')
  const database = record(root.database, 'database')
  const workbench = root.workbench === undefined ? {} : record(root.workbench, 'workbench')
  const embedding = root.embedding === undefined ? {} : record(root.embedding, 'embedding')
  const credentialFile = string(database.credentialFile, 'database.credentialFile', 'workbench.dpapi')
  if (win32.basename(credentialFile) !== credentialFile) throw new TypeError('database.credentialFile must be a file name')
  return {
    database: {
      host: string(database.host, 'database.host'),
      port: integer(database.port, 'database.port', 5432, 1, 65_535),
      name: string(database.name, 'database.name'),
      user: string(database.user, 'database.user'),
      credentialFile,
    },
    workbench: { port: integer(workbench.port, 'workbench.port', 7334, 1, 65_535) },
    embedding: {
      baseUrl: string(embedding.baseUrl, 'embedding.baseUrl', defaultWindowsConfig.embedding.baseUrl),
      model: string(embedding.model, 'embedding.model', defaultWindowsConfig.embedding.model),
      profileKey: string(embedding.profileKey, 'embedding.profileKey', defaultWindowsConfig.embedding.profileKey),
      dimensions: integer(embedding.dimensions, 'embedding.dimensions', 1024, 1, 16_384),
      queryPrefix: string(embedding.queryPrefix, 'embedding.queryPrefix', defaultWindowsConfig.embedding.queryPrefix),
      rerankerModel: string(embedding.rerankerModel, 'embedding.rerankerModel', defaultWindowsConfig.embedding.rerankerModel),
    },
  }
}

export function loadWindowsConfig(configRoot: string): WindowsWorkbenchConfig {
  const path = join(configRoot, 'workbench.json')
  try { return parseWindowsConfig(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as unknown) }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return defaultWindowsConfig
    throw new Error(`Invalid FORGE Workbench configuration at ${path}: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}

export function databaseUrl(config: WindowsWorkbenchConfig['database'], password: string): string {
  const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host
  return `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(password)}@${host}:${config.port}/${encodeURIComponent(config.name)}`
}

export function runtimeEnvironment(config: WindowsWorkbenchConfig, password: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    FORGE_DATABASE_URL: databaseUrl(config.database, password),
    FORGE_WORKBENCH_PORT: String(config.workbench.port),
    FORGE_EMBEDDING_BASE_URL: config.embedding.baseUrl,
    FORGE_EMBEDDING_MODEL: config.embedding.model,
    FORGE_EMBEDDING_PROFILE_KEY: config.embedding.profileKey,
    FORGE_EMBEDDING_DIMENSIONS: String(config.embedding.dimensions),
    FORGE_EMBEDDING_QUERY_PREFIX: config.embedding.queryPrefix,
    FORGE_RERANKER_MODEL: config.embedding.rerankerModel,
    ...base,
  }
}

export function recoveryHealthEnvironment(configRoot: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    FORGE_LOGICAL_RECOVERY_STATUS: join(configRoot, 'resilience-status.json'),
  }
  try {
    const policy = JSON.parse(readFileSync(join(configRoot, 'pitr-policy.json'), 'utf8').replace(/^\uFEFF/, '')) as { outputDirectory?: unknown }
    if (typeof policy.outputDirectory !== 'string' || !isAbsolute(policy.outputDirectory)) return result
    const statusRoot = join(dirname(policy.outputDirectory), 'status')
    result.FORGE_PITR_MONITOR_STATUS = join(statusRoot, 'pitr-monitor.json')
    result.FORGE_PHYSICAL_UPLOADER_STATUS = join(statusRoot, 'physical-uploader.json')
    result.FORGE_PHYSICAL_BASEBACKUP_STATUS = join(statusRoot, 'physical-basebackup.json')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new Error('Invalid FORGE PITR policy used for health discovery')
  }
  return result
}
