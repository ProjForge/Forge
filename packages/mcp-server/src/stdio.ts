#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ForgeGatewayError, ForgePersistenceGateway } from 'forge-persistence-gateway'
import { createForgeMcpServer } from './server.js'

function startupMessage(error: unknown): string {
  if (error instanceof ForgeGatewayError) return error.code + ': ' + error.message
  if (error instanceof Error) return error.name + ': ' + error.message
  return 'Unknown startup error'
}

export async function runForgeStdioServer(connectionString: string): Promise<void> {
  const gateway = ForgePersistenceGateway.connect({
    connectionString,
    maxConnections: 10,
    statementTimeoutMs: 15_000,
  })
  let server: ReturnType<typeof createForgeMcpServer> | undefined
  let closing = false

  const shutdown = async (): Promise<void> => {
    if (closing) return
    closing = true
    await server?.close().catch(() => undefined)
    await gateway.close().catch(() => undefined)
  }

  try {
    await gateway.assertReady()
    server = createForgeMcpServer({ gateway })
    const transport = new StdioServerTransport()

    process.once('SIGINT', () => {
      void shutdown().finally(() => process.exit(0))
    })
    process.once('SIGTERM', () => {
      void shutdown().finally(() => process.exit(0))
    })
    process.stdin.once('end', () => {
      void shutdown()
    })

    await server.connect(transport)
    console.error('FORGE MCP Server 0.1 ready on stdio')
  } catch (error) {
    await shutdown()
    throw error
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1]
  if (!entrypoint) return false
  return pathToFileURL(resolve(entrypoint)).href.toLowerCase() === import.meta.url.toLowerCase()
}

if (isMainModule()) {
  const connectionString = process.env.FORGE_DATABASE_URL
  if (!connectionString) {
    console.error('FORGE MCP startup failed: FORGE_DATABASE_URL is required')
    process.exitCode = 1
  } else {
    void runForgeStdioServer(connectionString).catch((error: unknown) => {
      console.error('FORGE MCP startup failed: ' + startupMessage(error))
      process.exitCode = 1
    })
  }
}
