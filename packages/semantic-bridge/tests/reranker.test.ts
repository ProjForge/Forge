import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenAiCompatibleSemanticReranker, SemanticRerankerError } from '../src/reranker.js'

const candidates = [1, 2, 3].map((index) => ({
  projectId: 'project-1',
  sourceKind: 'memory' as const,
  sourceId: `source-${index}`,
  sourceVersion: 1,
  title: `Candidate ${index}`,
  text: `Full text ${index}`,
  textTruncated: false,
}))

test('uses deterministic no-reasoning chat completion and parses the selected candidate', async () => {
  let request: RequestInit | undefined
  const reranker = new OpenAiCompatibleSemanticReranker({
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-reranker',
    candidateCount: 3,
    fetchImpl: async (_url, init) => {
      request = init
      return new Response(JSON.stringify({ choices: [{ message: { content: '2' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  const selected = await reranker.select({ query: 'consulta', candidates })
  assert.equal(selected.selectedIndex, 1)
  const body = JSON.parse(String(request?.body)) as Record<string, unknown>
  assert.equal(body.reasoning_effort, 'none')
  assert.equal(body.temperature, 0)
  assert.equal(body.max_tokens, 64)
  const messages = body.messages as Array<{ content: string }>
  assert.match(messages[1]!.content, /^\/no_think\b/)
})

test('rejects invalid model output and insecure remote HTTP endpoints', async () => {
  const reranker = new OpenAiCompatibleSemanticReranker({
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-reranker',
    candidateCount: 3,
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '9' } }] }), { status: 200 }),
  })
  await assert.rejects(
    reranker.select({ query: 'query', candidates }),
    (error: unknown) => error instanceof SemanticRerankerError && error.code === 'RERANKER_INVALID_RESPONSE',
  )
  assert.throws(
    () => new OpenAiCompatibleSemanticReranker({ baseUrl: 'http://example.com/v1', model: 'remote' }),
    /must use HTTPS/,
  )
})
