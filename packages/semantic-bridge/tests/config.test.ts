import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSemanticBridgeConfig } from '../src/config.js'

const baseEnv = {
  FORGE_DATABASE_URL: 'postgresql://runtime@example/forge',
  FORGE_EMBEDDING_BASE_URL: 'http://127.0.0.1:1234/v1',
  FORGE_EMBEDDING_MODEL: 'embedding-model',
  FORGE_EMBEDDING_PROFILE_KEY: 'profile-v1',
  FORGE_EMBEDDING_DIMENSIONS: '1024',
}

test('keeps reranking disabled when no reranker model is configured', () => {
  const config = loadSemanticBridgeConfig(baseEnv)
  assert.equal(config.reranker, undefined)
})

test('loads bounded optional reranker configuration with embedding URL fallback', () => {
  const config = loadSemanticBridgeConfig({
    ...baseEnv,
    FORGE_RERANKER_MODEL: 'precision-model',
    FORGE_RERANKER_CANDIDATES: '4',
    FORGE_RERANKER_MAX_TEXT_CHARS: '6000',
  })
  assert.deepEqual(config.reranker, {
    baseUrl: baseEnv.FORGE_EMBEDDING_BASE_URL,
    model: 'precision-model',
    timeoutMs: 30_000,
    candidateCount: 4,
    maxTextChars: 6_000,
  })
})
