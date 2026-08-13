#!/usr/bin/env node
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ForgePersistenceGateway, ForgeSemanticBridge, OpenAiCompatibleEmbeddingProvider, OpenAiCompatibleSemanticReranker } from 'forge-semantic-bridge/workbench'
import { loadWorkbenchConfig, type WorkbenchConfig } from './config.js'
import { createWorkbenchServer } from './server.js'
import { ForgeWorkbenchService } from './service.js'
import { FileRecoveryHealth } from './recovery-health.js'

const isPackaged = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg)

export async function runWorkbench(config: WorkbenchConfig): Promise<void> {
  const gateway = ForgePersistenceGateway.connect({
    connectionString: config.semantic.databaseUrl,
    maxConnections: 5,
    statementTimeoutMs: 15_000,
  })
  const provider = new OpenAiCompatibleEmbeddingProvider({
    baseUrl: config.semantic.baseUrl,
    model: config.semantic.model,
    timeoutMs: config.semantic.timeoutMs,
    sendDimensions: config.semantic.sendDimensions,
    ...(config.semantic.apiKey ? { apiKey: config.semantic.apiKey } : {}),
  })
  const reranker = config.semantic.reranker
    ? new OpenAiCompatibleSemanticReranker(config.semantic.reranker)
    : undefined
  const bridge = new ForgeSemanticBridge({
    gateway,
    provider,
    profile: config.semantic.profile,
    ...(reranker ? { reranker } : {}),
  })
  const service = new ForgeWorkbenchService(gateway, bridge, new FileRecoveryHealth(config.recovery))
  const publicDir = process.env.FORGE_WORKBENCH_PUBLIC_DIR
    ?? (isPackaged ? join(dirname(process.execPath), 'public') : fileURLToPath(new URL('../public/', import.meta.url)))
  const server = createWorkbenchServer(service, { publicDir })
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await gateway.close()
  }
  try {
    await gateway.assertReady()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, config.host, () => resolve())
    })
    const address = server.address()
    const actualPort = address && typeof address === 'object' ? address.port : config.port
    console.log(`FORGE Workbench ready at http://${config.host === '::1' ? '[::1]' : config.host}:${actualPort}`)
    process.once('SIGINT', () => { void close().finally(() => process.exit(0)) })
    process.once('SIGTERM', () => { void close().finally(() => process.exit(0)) })
  } catch (error) {
    await gateway.close().catch(() => undefined)
    throw error
  }
}

if (!isPackaged && process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
  void runWorkbench(loadWorkbenchConfig()).catch((error: unknown) => {
    console.error('FORGE Workbench startup failed: ' + (error instanceof Error ? error.message : 'unknown error'))
    process.exitCode = 1
  })
}
