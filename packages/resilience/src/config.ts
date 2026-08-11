import { existsSync } from 'node:fs'
import path from 'node:path'

const SAFE_LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/

export function backupLabel(value: string | undefined, now = new Date()): string {
  const label = value ?? `forge-${now.toISOString().replace(/[:.]/g, '-')}`
  if (!SAFE_LABEL.test(label)) throw new Error('Backup label must contain only letters, numbers, dot, underscore or dash')
  return label
}

export function requireDatabaseUrl(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`)
  const parsed = new URL(value)
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`${name} must be a PostgreSQL URL`)
  }
  if (!parsed.hostname || parsed.pathname.length <= 1) throw new Error(`${name} must include host and database`)
  return value
}

export function validatePassphrase(value: Uint8Array | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)
  if (bytes.length < 20) {
    bytes.fill(0)
    throw new Error('Backup passphrase must be at least 20 bytes')
  }
  return bytes
}

function executableNames(tool: string): string[] {
  return process.platform === 'win32' ? [`${tool}.exe`, tool] : [tool]
}

function candidateDirectories(explicitDirectory?: string): string[] {
  const directories: string[] = []
  if (explicitDirectory) directories.push(path.resolve(explicitDirectory))
  if (process.env.FORGE_POSTGRES_BIN) directories.push(path.resolve(process.env.FORGE_POSTGRES_BIN))
  directories.push(...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean))

  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    for (let major = 30; major >= 14; major -= 1) {
      directories.push(path.join(programFiles, 'PostgreSQL', String(major), 'bin'))
    }
  } else {
    directories.push('/usr/local/bin', '/usr/bin')
  }
  return [...new Set(directories)]
}

export function resolvePostgresTool(tool: 'pg_dump' | 'pg_restore', explicitDirectory?: string): string {
  for (const directory of candidateDirectories(explicitDirectory)) {
    for (const name of executableNames(tool)) {
      const candidate = path.join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error(`${tool} was not found; set FORGE_POSTGRES_BIN or --postgres-bin`)
}

export function safeConnection(connectionString: string): { connectionArgument: string; environment: NodeJS.ProcessEnv } {
  const parsed = new URL(requireDatabaseUrl(connectionString, 'database connection'))
  const password = decodeURIComponent(parsed.password)
  parsed.password = ''

  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP',
    'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH',
  ]
  const environment: NodeJS.ProcessEnv = {}
  for (const name of allowed) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  if (password) environment.PGPASSWORD = password
  return { connectionArgument: parsed.toString(), environment }
}
