import assert from 'node:assert/strict'
import test from 'node:test'
import { ForgeSemanticBridge } from '../src/bridge.js'
import type { SemanticSearchResult } from 'forge-persistence-gateway'

function result(sourceId: string, rank: number): SemanticSearchResult {
  return {
    embeddingId: `embedding-${rank}`,
    projectId: 'project-1',
    profileId: 'profile-id',
    profileKey: 'profile-v1',
    sourceKind: 'memory',
    sourceId,
    embeddedSourceVersion: 1,
    currentSourceVersion: 1,
    stale: false,
    title: `Candidate ${rank}`,
    summary: `Summary ${rank}`,
    distance: rank / 10,
    score: 1 - rank / 10,
    metadata: {},
  }
}

test('applies the immutable query transform and forwards a project-scoped vector search', async () => {
  let providerRequest: unknown
  let gatewayRequest: unknown
  const bridge = new ForgeSemanticBridge({
    profile: { profileKey: 'profile-v1', dimensions: 3, queryPrefix: 'Instruct: retrieve\nQuery:' },
    provider: { name: 'test', model: 'test', embed: async (input) => { providerRequest = input; return { vectors: [[0.1, 0.2, 0.3]] } } },
    gateway: { semanticSearch: async (input) => { gatewayRequest = input; return [] } },
  })
  await bridge.search({ projectId: 'project-1', query: ' decisiones de base de datos ', sourceKinds: ['decision'], limit: 3 })
  assert.deepEqual(providerRequest, { inputs: ['Instruct: retrieve\nQuery: decisiones de base de datos'], dimensions: 3 })
  assert.deepEqual(gatewayRequest, {
    projectId: 'project-1', profileKey: 'profile-v1', queryEmbedding: [0.1, 0.2, 0.3], sourceKinds: ['decision'], limit: 3,
  })
})

test('rejects empty and oversized queries before calling the provider', async () => {
  let calls = 0
  const bridge = new ForgeSemanticBridge({
    profile: { profileKey: 'profile-v1', dimensions: 3 },
    provider: { name: 'test', model: 'test', embed: async () => { calls++; return { vectors: [[1, 2, 3]] } } },
    gateway: { semanticSearch: async () => [] },
  })
  await assert.rejects(bridge.search({ projectId: 'p', query: '   ' }), /query must not be empty/)
  await assert.rejects(bridge.search({ projectId: 'p', query: 'x'.repeat(32_001) }), /exceeds/)
  assert.equal(calls, 0)
})

test('hydrates version-bound top candidates and promotes the reranker selection', async () => {
  const searchResults = [result('source-1', 1), result('source-2', 2), result('source-3', 3)]
  let searchRequest: unknown
  let hydrationRequest: unknown
  let rerankerRequest: unknown
  const bridge = new ForgeSemanticBridge({
    profile: { profileKey: 'profile-v1', dimensions: 3 },
    provider: { name: 'test', model: 'test', embed: async () => ({ vectors: [[1, 0, 0]] }) },
    gateway: {
      semanticSearch: async (input) => { searchRequest = input; return searchResults },
      getSemanticCandidateTexts: async (input) => {
        hydrationRequest = input
        return input.candidates.map((candidate, index) => ({
          projectId: input.projectId,
          ...candidate,
          title: `Candidate ${index + 1}`,
          text: `Full candidate ${index + 1}`,
          textTruncated: false,
        }))
      },
    },
    reranker: {
      name: 'test-reranker',
      model: 'test-model',
      candidateCount: 3,
      maxTextChars: 4_000,
      select: async (input) => { rerankerRequest = input; return { selectedIndex: 1, latencyMs: 5 } },
    },
  })

  const ranked = await bridge.search({ projectId: 'project-1', query: 'best candidate', limit: 2, rerank: true })
  assert.deepEqual(ranked.map((item) => item.sourceId), ['source-2', 'source-1'])
  assert.deepEqual(searchRequest, {
    projectId: 'project-1', profileKey: 'profile-v1', queryEmbedding: [1, 0, 0], limit: 3,
  })
  assert.deepEqual(hydrationRequest, {
    projectId: 'project-1',
    candidates: searchResults.map(({ sourceKind, sourceId, currentSourceVersion }) => ({
      sourceKind, sourceId, sourceVersion: currentSourceVersion,
    })),
    maxTextChars: 4_000,
  })
  assert.equal((rerankerRequest as { query: string }).query, 'best candidate')
})

test('rejects precision mode before provider work when no reranker is configured', async () => {
  let providerCalls = 0
  const bridge = new ForgeSemanticBridge({
    profile: { profileKey: 'profile-v1', dimensions: 3 },
    provider: { name: 'test', model: 'test', embed: async () => { providerCalls++; return { vectors: [[1, 0, 0]] } } },
    gateway: { semanticSearch: async () => [] },
  })
  await assert.rejects(
    bridge.search({ projectId: 'project-1', query: 'query', rerank: true }),
    (error: unknown) => error instanceof Error && error.message === 'Semantic reranking is not configured',
  )
  assert.equal(providerCalls, 0)
})
