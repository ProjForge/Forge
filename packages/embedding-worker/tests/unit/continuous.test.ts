import assert from 'node:assert/strict'
import test from 'node:test'
import { runContinuousEmbeddingWorker } from '../../src/continuous.js'
import type { EmbeddingWorkerResult } from '../../src/types.js'

function result(complete: boolean, embedded = 0): EmbeddingWorkerResult {
  return {
    profile: { id: 'p', profileKey: 'profile', provider: 'test', model: 'test', dimensions: 3, distanceMetric: 'cosine', status: 'active', metadata: {}, version: 1, createdAt: '', updatedAt: '' },
    pages: 1, discovered: embedded, embedded, skippedSourceChanged: 0,
    skippedTruncated: 0, truncatedEmbedded: 0, providerAttempts: embedded ? 1 : 0,
    inputTokens: null, nextCursor: null, complete,
  }
}

test('polls after idle cycles and drains bounded incomplete work promptly', async () => {
  const controller = new AbortController()
  const delays: number[] = []
  let cycles = 0
  await runContinuousEmbeddingWorker({
    runOnce: async () => {
      cycles += 1
      if (cycles === 1) return result(false, 1)
      if (cycles === 2) return result(true, 1)
      return result(true)
    },
    pollIntervalMs: 30_000,
    signal: controller.signal,
    sleep: async (milliseconds) => { delays.push(milliseconds); if (delays.length === 3) controller.abort() },
  })
  assert.deepEqual(delays, [1_000, 30_000, 30_000])
})

test('recovers from a failed provider cycle after the configured delay', async () => {
  const controller = new AbortController()
  const errors: unknown[] = []
  const delays: number[] = []
  let cycles = 0
  await runContinuousEmbeddingWorker({
    runOnce: async () => { cycles += 1; if (cycles === 1) throw new Error('offline'); return result(true) },
    errorDelayMs: 12_000,
    signal: controller.signal,
    onError: (error) => errors.push(error),
    sleep: async (milliseconds) => { delays.push(milliseconds); if (delays.length === 2) controller.abort() },
  })
  assert.equal(errors.length, 1)
  assert.deepEqual(delays, [12_000, 30_000])
})
