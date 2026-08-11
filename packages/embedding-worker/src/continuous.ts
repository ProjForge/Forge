import { defaultSleep } from './retry.js'
import type { EmbeddingWorkerResult } from './types.js'

export interface ContinuousEmbeddingWorkerOptions {
  runOnce: () => Promise<EmbeddingWorkerResult>
  pollIntervalMs?: number
  errorDelayMs?: number
  signal?: AbortSignal
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  onCycle?: (result: EmbeddingWorkerResult) => void
  onError?: (error: unknown) => void
}

function interval(name: string, value: number | undefined, fallback: number): number {
  const normalized = value ?? fallback
  if (!Number.isInteger(normalized) || normalized < 1_000 || normalized > 3_600_000) {
    throw new TypeError(`${name} must be an integer between 1000 and 3600000`)
  }
  return normalized
}

export async function runContinuousEmbeddingWorker(options: ContinuousEmbeddingWorkerOptions): Promise<void> {
  const pollIntervalMs = interval('pollIntervalMs', options.pollIntervalMs, 30_000)
  const errorDelayMs = interval('errorDelayMs', options.errorDelayMs, 15_000)
  const sleep = options.sleep ?? defaultSleep
  while (!options.signal?.aborted) {
    let delay = pollIntervalMs
    try {
      const result = await options.runOnce()
      options.onCycle?.(result)
      if (!result.complete) delay = 1_000
    } catch (error) {
      if (options.signal?.aborted) break
      options.onError?.(error)
      delay = errorDelayMs
    }
    if (options.signal?.aborted) break
    try {
      await sleep(delay, options.signal)
    } catch (error) {
      if (options.signal?.aborted) break
      throw error
    }
  }
}
