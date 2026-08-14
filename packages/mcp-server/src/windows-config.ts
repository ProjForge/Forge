import { readFileSync } from 'node:fs'
import { join, win32 } from 'node:path'

export interface McpWindowsConfig {
  host: string
  port: number
  name: string
  user: string
  credentialPath: string
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
  return value.trim()
}

export function loadMcpWindowsConfig(configRoot: string): McpWindowsConfig {
  const path = join(configRoot, 'workbench.json')
  let root: Record<string, unknown>
  try { root = object(JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as unknown, 'config') }
  catch (error) { throw new Error(`Invalid shared FORGE configuration at ${path}: ${error instanceof Error ? error.message : 'unknown error'}`) }
  const database = object(root.database, 'database')
  const port = database.port ?? 5432
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535) throw new TypeError('database.port must be an integer between 1 and 65535')
  const credentialFile = text(database.credentialFile, 'database.credentialFile')
  if (win32.basename(credentialFile) !== credentialFile) throw new TypeError('database.credentialFile must be a file name')
  return {
    host: text(database.host, 'database.host'), port: Number(port), name: text(database.name, 'database.name'),
    user: text(database.user, 'database.user'),
    credentialPath: join(configRoot, credentialFile),
  }
}

export function databaseUrl(config: McpWindowsConfig, password: string): string {
  const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host
  return `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(password)}@${host}:${config.port}/${encodeURIComponent(config.name)}`
}
