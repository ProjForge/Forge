import { statusFile, type RecoveryHealthComponent } from './recovery-health.js'

export interface OperationalHealthConfig {
  baseUrl: string
  model: string
  apiKey?: string
  statusPath?: string
  projectId?: string
}
export interface OperationalHealth {
  semantic: RecoveryHealthComponent
  indexing: RecoveryHealthComponent & { projectId: string | null }
}
export interface OperationalHealthPort { read(): Promise<OperationalHealth> }

export class LocalOperationalHealth implements OperationalHealthPort {
  constructor(private readonly config: OperationalHealthConfig, private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date()) {}

  async read(): Promise<OperationalHealth> {
    const [semantic, indexing] = await Promise.all([this.provider(), this.worker()])
    return { semantic, indexing }
  }

  private async provider(): Promise<RecoveryHealthComponent> {
    const updatedAt = this.now().toISOString()
    try {
      const url = new URL(`${this.config.baseUrl.replace(/\/$/, '')}/models`)
      if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Unsafe endpoint')
      const response = await this.fetcher(url, { signal: AbortSignal.timeout(2000), redirect: 'error',
        headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {} })
      if (!response.ok) return { state: 'failed', updatedAt, summary: 'El proveedor rechazó la consulta. Revisa el servicio y su autenticación.' }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Missing catalog')
      const decoder = new TextDecoder()
      let text = ''
      let bytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 65_536) { await reader.cancel(); throw new Error('Oversized catalog') }
          text += decoder.decode(chunk.value, { stream: true })
        }
        text += decoder.decode()
      } finally { reader.releaseLock() }
      const body = JSON.parse(text) as { data?: { id?: unknown }[] }
      if (!Array.isArray(body.data) || !body.data.some((model) => model?.id === this.config.model)) {
        return { state: 'degraded', updatedAt, summary: 'Proveedor disponible; el modelo configurado no aparece en su catálogo.' }
      }
      return { state: 'healthy', updatedAt, summary: 'Proveedor disponible y modelo anunciado. La inferencia se verifica al buscar o indexar.' }
    } catch {
      return { state: 'failed', updatedAt, summary: 'Proveedor no accesible o consulta agotada. Comprueba el servicio local de modelos.' }
    }
  }

  private async worker(): Promise<OperationalHealth['indexing']> {
    const projectId = this.config.projectId && /^[0-9a-f-]{36}$/i.test(this.config.projectId) ? this.config.projectId : null
    try {
      const root = await statusFile(this.config.statusPath)
      if (!root) return { state: 'unconfigured', updatedAt: null, projectId, summary: 'Sin estado de indexación disponible.' }
      const updatedAt = typeof root.updatedAt === 'string' && Number.isFinite(Date.parse(root.updatedAt)) ? new Date(root.updatedAt).toISOString() : null
      if (!updatedAt) throw new Error('Invalid timestamp')
      if (root.status !== 'PASS') return { state: 'failed', updatedAt, projectId, summary: 'El worker informó un fallo o está reintentando.' }
      const age = this.now().getTime() - Date.parse(updatedAt)
      if (age > 180_000 || age < -60_000) return { state: 'degraded', updatedAt, projectId, summary: 'Estado de indexación caducado. Revisa si el worker está activo.' }
      return { state: 'healthy', updatedAt, projectId, summary: 'Ciclo reciente de indexación completado para el proyecto configurado.' }
    } catch {
      return { state: 'failed', updatedAt: null, projectId, summary: 'El estado del worker no es válido o no se puede leer.' }
    }
  }
}
