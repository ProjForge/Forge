import { EmbeddingProviderError } from '../errors.js'
import type { EmbeddingProvider, EmbeddingProviderRequest, EmbeddingProviderResult } from '../types.js'

const MAX_RESPONSE_CHARS = 10_000_000
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

export interface OpenAiCompatibleEmbeddingProviderOptions {
  baseUrl?: string
  apiKey?: string
  model: string
  timeoutMs?: number
  sendDimensions?: boolean
  organization?: string
  project?: string
  fetch?: typeof globalThis.fetch
  name?: string
}

function requiredText(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`${name} must not be empty`)
  return normalized
}

function embeddingsUrl(value: string): URL {
  const base = new URL(value.endsWith('/') ? value : `${value}/`)
  if (base.username || base.password) throw new TypeError('baseUrl must not contain credentials')
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && LOOPBACK_HOSTS.has(base.hostname))) {
    throw new TypeError('baseUrl must use HTTPS, except for loopback test/development servers')
  }
  return new URL('embeddings', base)
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly name: string
  readonly model: string
  private readonly endpoint: URL
  private readonly apiKey: string | undefined
  private readonly timeoutMs: number
  private readonly sendDimensions: boolean
  private readonly organization: string | undefined
  private readonly project: string | undefined
  private readonly fetchImpl: typeof globalThis.fetch

  constructor(options: OpenAiCompatibleEmbeddingProviderOptions) {
    this.name = requiredText('name', options.name ?? 'openai-compatible')
    this.model = requiredText('model', options.model)
    this.endpoint = embeddingsUrl(options.baseUrl ?? 'https://api.openai.com/v1')
    this.apiKey = options.apiKey?.trim() || undefined
    this.timeoutMs = options.timeoutMs ?? 30_000
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new TypeError('timeoutMs must be an integer between 1 and 300000')
    }
    this.sendDimensions = options.sendDimensions ?? true
    this.organization = options.organization?.trim() || undefined
    this.project = options.project?.trim() || undefined
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  async embed(request: EmbeddingProviderRequest): Promise<EmbeddingProviderResult> {
    if (request.inputs.length < 1 || request.inputs.length > 50) {
      throw new TypeError('inputs must contain between 1 and 50 texts')
    }
    if (!Number.isInteger(request.dimensions) || request.dimensions < 1 || request.dimensions > 4096) {
      throw new TypeError('dimensions must be an integer between 1 and 4096')
    }
    if (request.inputs.some((input) => input.length === 0)) {
      throw new TypeError('embedding inputs must not be empty')
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('Embedding provider timeout')), this.timeoutMs)
    const onAbort = (): void => controller.abort(request.signal?.reason)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
      if (this.organization) headers['openai-organization'] = this.organization
      if (this.project) headers['openai-project'] = this.project
      const body: Record<string, unknown> = {
        input: [...request.inputs],
        model: this.model,
        encoding_format: 'float',
      }
      if (this.sendDimensions) body.dimensions = request.dimensions

      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
        throw new EmbeddingProviderError(
          'PROVIDER_HTTP_ERROR',
          `Embedding provider returned HTTP ${response.status}`,
          retryable,
          response.status,
          retryAfterMilliseconds(response.headers.get('retry-after')),
        )
      }
      const raw = await response.text()
      if (raw.length > MAX_RESPONSE_CHARS) {
        throw new EmbeddingProviderError('PROVIDER_RESPONSE_TOO_LARGE', 'Embedding provider response is too large', false)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new EmbeddingProviderError('PROVIDER_INVALID_JSON', 'Embedding provider returned invalid JSON', false, undefined, undefined, { cause: error })
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.data) || parsed.data.length !== request.inputs.length) {
        throw new EmbeddingProviderError('PROVIDER_INVALID_RESPONSE', 'Embedding provider returned an invalid item count', false)
      }
      const vectors: number[][] = Array.from({ length: request.inputs.length })
      for (const item of parsed.data) {
        if (!isRecord(item) || !Number.isInteger(item.index) || !Array.isArray(item.embedding)) {
          throw new EmbeddingProviderError('PROVIDER_INVALID_RESPONSE', 'Embedding provider returned an invalid item', false)
        }
        const index = Number(item.index)
        if (index < 0 || index >= vectors.length || vectors[index] !== undefined) {
          throw new EmbeddingProviderError('PROVIDER_INVALID_RESPONSE', 'Embedding provider returned an invalid index', false)
        }
        const vector = item.embedding
        if (vector.length !== request.dimensions || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
          throw new EmbeddingProviderError('PROVIDER_INVALID_VECTOR', 'Embedding provider returned an invalid vector', false)
        }
        vectors[index] = vector as number[]
      }
      if (vectors.some((vector) => vector === undefined)) {
        throw new EmbeddingProviderError('PROVIDER_INVALID_RESPONSE', 'Embedding provider omitted an indexed vector', false)
      }
      const usage = isRecord(parsed.usage)
        ? {
            ...(typeof parsed.usage.prompt_tokens === 'number' ? { inputTokens: parsed.usage.prompt_tokens } : {}),
            ...(typeof parsed.usage.total_tokens === 'number' ? { totalTokens: parsed.usage.total_tokens } : {}),
          }
        : undefined
      return {
        vectors,
        ...(typeof parsed.model === 'string' ? { model: parsed.model } : {}),
        ...(usage ? { usage } : {}),
      }
    } catch (error) {
      if (error instanceof EmbeddingProviderError) throw error
      if (request.signal?.aborted) throw request.signal.reason ?? error
      if (controller.signal.aborted) {
        throw new EmbeddingProviderError('PROVIDER_TIMEOUT', 'Embedding provider request timed out', true, undefined, undefined, { cause: error })
      }
      throw new EmbeddingProviderError('PROVIDER_NETWORK_ERROR', 'Embedding provider request failed', true, undefined, undefined, { cause: error })
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onAbort)
    }
  }
}
