import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { EmbeddingProviderError } from 'forge-embedding-worker'
import { ForgeGatewayError } from 'forge-persistence-gateway'
import { z } from 'zod'
import type { ForgeSemanticBridge } from './bridge.js'
import type { TextSearchInput } from './types.js'
import { SemanticRerankerError } from './reranker.js'

export const FORGE_SEMANTIC_BRIDGE_TOOL_NAMES = ['forge_search_text'] as const

const inputSchema = z.object({
  projectId: z.string().uuid(),
  query: z.string().trim().min(1).max(32_000),
  sourceKinds: z.array(z.enum(['memory', 'decision', 'document_chunk'])).min(1).max(3).optional(),
  includeStale: z.boolean().optional(),
  minScore: z.number().finite().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  rerank: z.boolean().optional(),
}).strict()

function result(value: unknown): CallToolResult {
  const body = { result: value }
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body }
}

function failure(code: string, message: string): CallToolResult {
  const body = { error: { code, message } }
  return { content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: body, isError: true }
}

export function createForgeSemanticBridgeServer(bridge: Pick<ForgeSemanticBridge, 'search'>, logger = console.error): McpServer {
  const server = new McpServer(
    { name: 'forge-semantic-bridge', version: '0.1.1' },
    { instructions: 'Use forge_search_text for project-scoped semantic retrieval. Set rerank=true only when top-1 precision justifies additional local-model latency.' },
  )
  server.registerTool('forge_search_text', {
    title: 'Search FORGE from text',
    description: 'Embed a natural-language query and search current project knowledge; optionally rerank the top five with the configured external precision model.',
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      return result(await bridge.search(input as TextSearchInput))
    } catch (error) {
      if (error instanceof ForgeGatewayError || error instanceof EmbeddingProviderError || error instanceof SemanticRerankerError) {
        return failure(error.code, error.message)
      }
      logger(error instanceof Error ? `${error.name}: ${error.message}` : 'Non-Error rejection')
      return failure('INTERNAL_ERROR', 'The semantic search failed unexpectedly')
    }
  })
  return server
}
