import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const maximumStatusBytes = 64 * 1024

export type RecoveryHealthState = 'healthy' | 'degraded' | 'failed' | 'unconfigured'

export interface RecoveryHealthComponent {
  state: RecoveryHealthState
  updatedAt: string | null
  summary: string
  checks?: readonly { name: string; status: 'PASS' | 'INFO' | 'FAIL'; detail: string }[]
}

export interface RecoveryHealth {
  overall: RecoveryHealthState
  logical: RecoveryHealthComponent
  pitr: RecoveryHealthComponent
  walTransport: RecoveryHealthComponent
  baseBackup: RecoveryHealthComponent
}

export interface RecoveryHealthConfig {
  logicalStatusPath?: string
  pitrStatusPath?: string
  walTransportStatusPath?: string
  baseBackupStatusPath?: string
  logicalMaxAgeHours?: number
  pitrMaxAgeMinutes?: number
  walTransportMaxAgeMinutes?: number
  baseBackupMaxAgeHours?: number
}

export interface RecoveryHealthPort { read(): Promise<RecoveryHealth> }

const unconfigured = (summary = 'No configurado.'): RecoveryHealthComponent => ({ state: 'unconfigured', updatedAt: null, summary })

export function unconfiguredRecoveryHealth(): RecoveryHealth {
  return {
    overall: 'unconfigured', logical: unconfigured(), pitr: unconfigured(),
    walTransport: unconfigured(), baseBackup: unconfigured(),
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Status must be a JSON object')
  return value as Record<string, unknown>
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('Status timestamp is invalid')
  return new Date(value).toISOString()
}

function stale(updatedAt: string, maximumAgeMs: number, now: Date): boolean {
  return now.getTime() - Date.parse(updatedAt) > maximumAgeMs
}

function bounded(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : fallback
}

async function statusFile(path: string | undefined): Promise<Record<string, unknown> | null> {
  if (!path) return null
  if (!isAbsolute(path)) throw new Error('Recovery status path must be absolute')
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumStatusBytes) throw new Error('Recovery status file is unsafe')
    return record(JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as unknown)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

async function component(path: string | undefined, maximumAgeMs: number, now: Date, parser: (root: Record<string, unknown>) => RecoveryHealthComponent): Promise<RecoveryHealthComponent> {
  if (!path) return unconfigured()
  try {
    const root = await statusFile(path)
    if (!root) return { state: 'failed', updatedAt: null, summary: 'El archivo de estado configurado no existe.' }
    const parsed = parser(root)
    if (parsed.updatedAt && parsed.state === 'healthy' && stale(parsed.updatedAt, maximumAgeMs, now)) {
      return { ...parsed, state: 'degraded', summary: 'El último estado correcto está fuera de su ventana de frescura.' }
    }
    return parsed
  } catch {
    return { state: 'failed', updatedAt: null, summary: 'El archivo de estado no es válido o no se puede leer.' }
  }
}

function logical(root: Record<string, unknown>): RecoveryHealthComponent {
  const updatedAt = timestamp(root.completedAt)
  if (root.status !== 'ok') return { state: 'failed', updatedAt, summary: 'La última copia lógica informó un fallo.' }
  const replicas = Array.isArray(root.replicas) ? root.replicas.length : 0
  if (replicas === 0) return { state: 'failed', updatedAt, summary: 'La copia lógica no confirmó ninguna réplica.' }
  return { state: 'healthy', updatedAt, summary: `${replicas} réplica${replicas === 1 ? '' : 's'} autenticada${replicas === 1 ? '' : 's'}.` }
}

function pitr(root: Record<string, unknown>): RecoveryHealthComponent {
  const updatedAt = timestamp(root.checkedAt)
  const checks = Array.isArray(root.checks) ? root.checks.slice(0, 20).map((value) => {
    const item = record(value)
    const status: 'PASS' | 'INFO' | 'FAIL' = item.status === 'PASS' || item.status === 'INFO' || item.status === 'FAIL' ? item.status : 'FAIL'
    return { name: bounded(item.name, 'unknown'), status, detail: bounded(item.detail, 'Sin detalle.') }
  }) : []
  if (root.status === 'FAIL' || checks.some((check) => check.status === 'FAIL')) {
    return { state: 'failed', updatedAt, summary: 'El monitor PITR detectó un fallo.', checks }
  }
  if (root.status !== 'PASS') return { state: 'degraded', updatedAt, summary: 'PITR todavía no está activo.', checks }
  return { state: 'healthy', updatedAt, summary: 'Archivado y ventanas de recuperación dentro del objetivo.', checks }
}

function physical(root: Record<string, unknown>, label: string): RecoveryHealthComponent {
  const updatedAt = timestamp(root.completedAt)
  if (root.status !== 'PASS' || root.packageOnly === true) return { state: 'failed', updatedAt, summary: `${label} no confirmó transporte remoto autenticado.` }
  return { state: 'healthy', updatedAt, summary: `${label} se completó y autenticó.` }
}

function overall(components: RecoveryHealthComponent[]): RecoveryHealthState {
  const configured = components.filter((item) => item.state !== 'unconfigured')
  if (configured.length === 0) return 'unconfigured'
  if (configured.some((item) => item.state === 'failed')) return 'failed'
  if (configured.some((item) => item.state === 'degraded')) return 'degraded'
  return 'healthy'
}

export class FileRecoveryHealth implements RecoveryHealthPort {
  constructor(private readonly config: RecoveryHealthConfig, private readonly now: () => Date = () => new Date()) {}

  async read(): Promise<RecoveryHealth> {
    const now = this.now()
    const logicalStatus = await component(this.config.logicalStatusPath, (this.config.logicalMaxAgeHours ?? 8) * 3_600_000, now, logical)
    const pitrStatus = await component(this.config.pitrStatusPath, (this.config.pitrMaxAgeMinutes ?? 10) * 60_000, now, pitr)
    const walTransport = await component(this.config.walTransportStatusPath, (this.config.walTransportMaxAgeMinutes ?? 10) * 60_000, now, (root) => physical(root, 'Transporte WAL'))
    const baseBackup = await component(this.config.baseBackupStatusPath, (this.config.baseBackupMaxAgeHours ?? 30) * 3_600_000, now, (root) => physical(root, 'La base física'))
    return { overall: overall([logicalStatus, pitrStatus, walTransport, baseBackup]), logical: logicalStatus, pitr: pitrStatus, walTransport, baseBackup }
  }
}
