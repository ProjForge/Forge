import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createForgeSemanticBridgeServer, FORGE_SEMANTIC_BRIDGE_TOOL_NAMES } from '../src/server.js'

test('publishes forge_search_text and returns structured results', async () => {
  let received: unknown
  const server = createForgeSemanticBridgeServer({ search: async (input) => { received = input; return [] } })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'test', version: '0.1.0' })
  await client.connect(clientTransport)
  try {
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name), [...FORGE_SEMANTIC_BRIDGE_TOOL_NAMES])
    const response = await client.callTool({ name: 'forge_search_text', arguments: { projectId: 'bd726f08-4ccd-41c4-a861-8b7c5e7aec33', query: 'modelo recomendado', limit: 2 } })
    assert.deepEqual(received, { projectId: 'bd726f08-4ccd-41c4-a861-8b7c5e7aec33', query: 'modelo recomendado', limit: 2 })
    assert.deepEqual(response.structuredContent, { result: [] })
  } finally { await client.close(); await server.close() }
})
