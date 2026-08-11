#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { OpenAiCompatibleEmbeddingProvider } from 'forge-embedding-worker'
import { ForgePersistenceGateway } from 'forge-persistence-gateway'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ForgeSemanticBridge } from './bridge.js'
import { OpenAiCompatibleSemanticReranker } from './reranker.js'
import { loadSemanticBridgeConfig, type SemanticBridgeConfig } from './config.js'
import { createForgeSemanticBridgeServer } from './server.js'

export async function runForgeSemanticBridgeStdio(config: SemanticBridgeConfig): Promise<void> {
  const gateway = ForgePersistenceGateway.connect({ connectionString: config.databaseUrl, maxConnections: 5, statementTimeoutMs: 15_000 })
  let server: ReturnType<typeof createForgeSemanticBridgeServer> | undefined
  const close = async (): Promise<void> => { await server?.close().catch(() => undefined); await gateway.close().catch(() => undefined) }
  try {
    await gateway.assertReady()
    const provider = new OpenAiCompatibleEmbeddingProvider({
      baseUrl: config.baseUrl, model: config.model, timeoutMs: config.timeoutMs,
      sendDimensions: config.sendDimensions, ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    })
    const reranker = config.reranker
      ? new OpenAiCompatibleSemanticReranker(config.reranker)
      : undefined
    server = createForgeSemanticBridgeServer(new ForgeSemanticBridge({
      gateway,
      provider,
      profile: config.profile,
      ...(reranker ? { reranker } : {}),
    }))
    process.once('SIGINT', () => { void close().finally(() => process.exit(0)) })
    process.once('SIGTERM', () => { void close().finally(() => process.exit(0)) })
    process.stdin.once('end', () => { void close() })
    await server.connect(new StdioServerTransport())
    console.error('FORGE Semantic Bridge 0.1.4 ready on stdio')
  } catch (error) { await close(); throw error }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1]
  return Boolean(entrypoint) && pathToFileURL(resolve(entrypoint!)).href.toLowerCase() === import.meta.url.toLowerCase()
}

if (isMainModule()) {
  void runForgeSemanticBridgeStdio(loadSemanticBridgeConfig()).catch((error: unknown) => {
    console.error('FORGE Semantic Bridge startup failed: ' + (error instanceof Error ? error.message : 'unknown error'))
    process.exitCode = 1
  })
}
