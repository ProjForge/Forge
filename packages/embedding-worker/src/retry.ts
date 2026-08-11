import { EmbeddingProviderError } from './errors.js'
import type { EmbeddingWorkerRetryOptions } from './types.js'

const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_BASE_DELAY_MS = 250
const DEFAULT_MAX_DELAY_MS = 5_000
const DEFAULT_JITTER_RATIO = 0.2

export interface RetryRuntime {
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  random: () => number
}

export function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Operation aborted'))
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout
    const onAbort = (): void => {
      clearTimeout(timeout)
      reject(signal?.reason ?? new Error('Operation aborted'))
    }
    timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`)
  return value
}

export async function withProviderRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: EmbeddingWorkerRetryOptions = {},
  runtime: RetryRuntime = { sleep: defaultSleep, random: Math.random },
  signal?: AbortSignal,
): Promise<{ value: T; attempts: number }> {
  const maxAttempts = positiveInteger('maxAttempts', options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const baseDelayMs = positiveInteger('baseDelayMs', options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS)
  const maxDelayMs = positiveInteger('maxDelayMs', options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS)
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new TypeError('jitterRatio must be between 0 and 1')
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    signal?.throwIfAborted()
    try {
      return { value: await operation(attempt), attempts: attempt }
    } catch (error) {
      const retryable = error instanceof EmbeddingProviderError && error.retryable
      if (!retryable || attempt === maxAttempts) throw error
      const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)))
      const suggested = error.retryAfterMs ?? 0
      const jitter = exponential * jitterRatio * runtime.random()
      await runtime.sleep(Math.max(suggested, Math.round(exponential + jitter)), signal)
    }
  }
  throw new Error('Unreachable retry state')
}
