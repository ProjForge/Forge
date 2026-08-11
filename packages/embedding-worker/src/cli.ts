#!/usr/bin/env node
import { ForgePersistenceGateway } from 'forge-persistence-gateway'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadEmbeddingWorkerEnvironment } from './config.js'
import { runContinuousEmbeddingWorker } from './continuous.js'
import { EmbeddingWorkerError } from './errors.js'
import { OpenAiCompatibleEmbeddingProvider } from './providers/openai-compatible.js'
import { runEmbeddingWorker } from './worker.js'

const abortController = new AbortController()
process.once('SIGINT', () => abortController.abort(new Error('Interrupted')))
process.once('SIGTERM', () => abortController.abort(new Error('Terminated')))

function writeStatus(path: string | undefined, value: unknown): void {
  if (!path) return
  const temporary = `${path}.${process.pid}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

async function main(): Promise<void> {
  const config = loadEmbeddingWorkerEnvironment()
  const gateway = ForgePersistenceGateway.connect({
    connectionString: config.databaseUrl,
    maxConnections: 2,
  })
  try {
    await gateway.assertReady()
    const provider = new OpenAiCompatibleEmbeddingProvider(config.provider)
    const runOnce = () => runEmbeddingWorker({
      gateway,
      provider,
      projectId: config.projectId,
      profile: {
        profileKey: config.profileKey,
        dimensions: config.dimensions,
        distanceMetric: config.distanceMetric,
      },
      sourceKinds: config.sourceKinds,
      ...(config.cursor ? { cursor: config.cursor } : {}),
      pageSize: config.pageSize,
      maxCandidates: config.maxCandidates,
      maxTextChars: config.maxTextChars,
      ...(config.inputPrefix ? { inputPrefix: config.inputPrefix } : {}),
      ...(config.queryPrefix ? { queryPrefix: config.queryPrefix } : {}),
      rejectTruncatedText: config.rejectTruncatedText,
      ...(config.agentId ? { agentId: config.agentId } : {}),
      ...(config.executionId ? { executionId: config.executionId } : {}),
      retry: config.retry,
      signal: abortController.signal,
    })
    if (config.continuous) {
      await runContinuousEmbeddingWorker({
        runOnce,
        pollIntervalMs: config.pollIntervalMs,
        errorDelayMs: config.errorDelayMs,
        signal: abortController.signal,
        onCycle: (result) => {
          const output = { status: 'PASS', mode: 'continuous', updatedAt: new Date().toISOString(), result }
          writeStatus(config.statusFile, output)
          process.stdout.write(`${JSON.stringify(output)}\n`)
        },
        onError: (error) => {
          const code = error instanceof EmbeddingWorkerError ? error.code : 'CYCLE_FAILED'
          const message = error instanceof Error ? error.message : 'Embedding cycle failed'
          const output = { status: 'RETRY', mode: 'continuous', updatedAt: new Date().toISOString(), code, message }
          writeStatus(config.statusFile, output)
          process.stderr.write(`${JSON.stringify(output)}\n`)
        },
      })
    } else {
      const result = await runOnce()
      const output = { status: 'PASS', mode: 'once', updatedAt: new Date().toISOString(), result }
      writeStatus(config.statusFile, output)
      process.stdout.write(`${JSON.stringify(output)}\n`)
    }
  } finally {
    await gateway.close()
  }
}

try {
  await main()
} catch (error) {
  const code = error instanceof EmbeddingWorkerError
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'WORKER_FAILED'
  const message = error instanceof Error ? error.message : 'Embedding worker failed'
  process.stderr.write(`${JSON.stringify({ status: 'FAIL', code, message })}\n`)
  process.exitCode = 1
}
