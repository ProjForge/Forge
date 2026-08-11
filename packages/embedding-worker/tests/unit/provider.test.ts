import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { loadEmbeddingWorkerEnvironment } from '../../src/config.js'
import { EmbeddingProviderError } from '../../src/errors.js'
import { OpenAiCompatibleEmbeddingProvider } from '../../src/providers/openai-compatible.js'

test('implements the OpenAI-compatible batch contract and restores index order', async () => {
  let authorization: string | undefined
  let requestBody: Record<string, unknown> | undefined
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization
    let raw = ''
    for await (const chunk of request) raw += String(chunk)
    requestBody = JSON.parse(raw) as Record<string, unknown>
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      object: 'list',
      model: 'test-model',
      data: [
        { object: 'embedding', index: 1, embedding: [0, 1, 0] },
        { object: 'embedding', index: 0, embedding: [1, 0, 0] },
      ],
      usage: { prompt_tokens: 4, total_tokens: 4 },
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address() as AddressInfo
    const provider = new OpenAiCompatibleEmbeddingProvider({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'test-key',
      model: 'test-model',
    })
    const result = await provider.embed({ inputs: ['first', 'second'], dimensions: 3 })
    assert.equal(authorization, 'Bearer test-key')
    assert.deepEqual(requestBody, {
      input: ['first', 'second'],
      model: 'test-model',
      encoding_format: 'float',
      dimensions: 3,
    })
    assert.deepEqual(result.vectors, [[1, 0, 0], [0, 1, 0]])
    assert.equal(result.usage?.inputTokens, 4)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test('classifies rate limits as retryable without exposing response bodies', async () => {
  const provider = new OpenAiCompatibleEmbeddingProvider({
    baseUrl: 'http://127.0.0.1:9999/v1',
    model: 'test-model',
    fetch: async () => new Response('sensitive upstream detail', {
      status: 429,
      headers: { 'retry-after': '2' },
    }),
  })
  await assert.rejects(
    provider.embed({ inputs: ['input'], dimensions: 3 }),
    (error) => {
      assert.ok(error instanceof EmbeddingProviderError)
      assert.equal(error.retryable, true)
      assert.equal(error.status, 429)
      assert.equal(error.retryAfterMs, 2_000)
      assert.doesNotMatch(error.message, /sensitive/)
      return true
    },
  )
})

test('rejects provider vectors whose dimensions do not match the profile', async () => {
  const provider = new OpenAiCompatibleEmbeddingProvider({
    baseUrl: 'http://127.0.0.1:9999/v1',
    model: 'test-model',
    fetch: async () => new Response(JSON.stringify({
      object: 'list',
      model: 'test-model',
      data: [{ object: 'embedding', index: 0, embedding: [1, 0] }],
    }), { status: 200 }),
  })
  await assert.rejects(
    provider.embed({ inputs: ['input'], dimensions: 3 }),
    (error) => error instanceof EmbeddingProviderError && error.code === 'PROVIDER_INVALID_VECTOR',
  )
})

test('rejects insecure remote endpoints and missing official API credentials', () => {
  assert.throws(
    () => new OpenAiCompatibleEmbeddingProvider({
      baseUrl: 'http://example.com/v1',
      model: 'test-model',
    }),
    /HTTPS/,
  )
  assert.throws(
    () => loadEmbeddingWorkerEnvironment({
      FORGE_DATABASE_URL: 'postgresql://test',
      FORGE_PROJECT_ID: projectId,
      FORGE_EMBEDDING_PROFILE_KEY: 'profile',
      FORGE_EMBEDDING_MODEL: 'text-embedding-3-small',
      FORGE_EMBEDDING_DIMENSIONS: '3',
    }),
    /FORGE_EMBEDDING_API_KEY/,
  )
})

test('loads an optional provider-specific input prefix for local endpoints', () => {
  const config = loadEmbeddingWorkerEnvironment({
    FORGE_DATABASE_URL: 'postgresql://test',
    FORGE_PROJECT_ID: projectId,
    FORGE_EMBEDDING_PROFILE_KEY: 'nomic-documents-v1',
    FORGE_EMBEDDING_MODEL: 'text-embedding-nomic-embed-text-v1.5',
    FORGE_EMBEDDING_DIMENSIONS: '768',
    FORGE_EMBEDDING_BASE_URL: 'http://127.0.0.1:1234/v1',
    FORGE_EMBEDDING_INPUT_PREFIX: '  search_document:  ',
    FORGE_EMBEDDING_QUERY_PREFIX: '  search_query:  ',
  })

  assert.equal(config.inputPrefix, 'search_document:')
  assert.equal(config.queryPrefix, 'search_query:')
  assert.equal(config.provider.apiKey, undefined)
})

const projectId = '00000000-0000-4000-8000-000000000001'
