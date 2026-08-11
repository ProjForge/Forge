import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const packageRoot = resolve(import.meta.dirname, '..')
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(packageRoot, 'dist/codex.js')],
  cwd: packageRoot,
  env: {
    ...getDefaultEnvironment(),
    FORGE_EMBEDDING_BASE_URL: 'http://127.0.0.1:1234/v1',
    FORGE_EMBEDDING_MODEL: 'text-embedding-qwen3-embedding-0.6b',
    FORGE_EMBEDDING_PROFILE_KEY: 'qwen3-embedding-0.6b-q8-1024-forge-retrieval-v1',
    FORGE_EMBEDDING_DIMENSIONS: '1024',
    FORGE_EMBEDDING_QUERY_PREFIX: 'Instruct: Given a user question about a software project, retrieve the most relevant project decision or memory that answers the question\nQuery:',
    FORGE_RERANKER_MODEL: 'forge-reranker-qwen35-9b',
  },
  stderr: 'pipe',
})
const client = new Client({ name: 'forge-semantic-bridge-check', version: '0.1.1' })
try {
  await client.connect(transport)
  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map(({ name }) => name), ['forge_search_text'])
  const response = await client.callTool({ name: 'forge_search_text', arguments: {
    projectId: 'bd726f08-4ccd-41c4-a861-8b7c5e7aec33', query: '¿Qué modelo multilingüe recomendamos?', limit: 2, rerank: true,
  } })
  assert.notEqual(response.isError, true, JSON.stringify(response.content))
  assert.ok(Array.isArray(response.structuredContent?.result))
  process.stdout.write(JSON.stringify({ status: 'PASS', tools: 1, results: response.structuredContent.result.length }) + '\n')
} finally { await client.close().catch(() => undefined) }
