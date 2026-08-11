import { OpenAiCompatibleEmbeddingProvider } from 'forge-embedding-worker'
import { ForgePersistenceGateway } from 'forge-persistence-gateway'
import { ForgeSemanticBridge, OpenAiCompatibleSemanticReranker } from '../dist/index.js'

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new TypeError(`${name} is required`)
  return value
}

const gateway = ForgePersistenceGateway.connect({ connectionString: required('FORGE_DATABASE_URL'), maxConnections: 2 })
try {
  await gateway.assertReady()
  const provider = new OpenAiCompatibleEmbeddingProvider({
    baseUrl: required('FORGE_EMBEDDING_BASE_URL'),
    model: required('FORGE_EMBEDDING_MODEL'),
    sendDimensions: process.env.FORGE_EMBEDDING_SEND_DIMENSIONS !== 'false',
  })
  const rerankerModel = process.env.FORGE_RERANKER_MODEL?.trim()
  const reranker = rerankerModel ? new OpenAiCompatibleSemanticReranker({
    baseUrl: process.env.FORGE_RERANKER_BASE_URL?.trim() || required('FORGE_EMBEDDING_BASE_URL'),
    model: rerankerModel,
    ...(process.env.FORGE_RERANKER_TIMEOUT_MS
      ? { timeoutMs: Number(process.env.FORGE_RERANKER_TIMEOUT_MS) }
      : {}),
    ...(process.env.FORGE_RERANKER_CANDIDATES
      ? { candidateCount: Number(process.env.FORGE_RERANKER_CANDIDATES) }
      : {}),
    ...(process.env.FORGE_RERANKER_MAX_TEXT_CHARS
      ? { maxTextChars: Number(process.env.FORGE_RERANKER_MAX_TEXT_CHARS) }
      : {}),
  }) : undefined
  const bridge = new ForgeSemanticBridge({
    gateway,
    provider,
    profile: {
      profileKey: required('FORGE_EMBEDDING_PROFILE_KEY'),
      dimensions: Number(required('FORGE_EMBEDDING_DIMENSIONS')),
      ...(process.env.FORGE_EMBEDDING_QUERY_PREFIX ? { queryPrefix: process.env.FORGE_EMBEDDING_QUERY_PREFIX } : {}),
    },
    ...(reranker ? { reranker } : {}),
  })
  const results = await bridge.search({
    projectId: required('FORGE_PROJECT_ID'),
    query: required('FORGE_EMBEDDING_QUERY'),
    sourceKinds: ['memory', 'decision'],
    limit: 5,
    ...(reranker ? { rerank: true } : {}),
  })
  process.stdout.write(`${JSON.stringify({ status: 'PASS', reranked: Boolean(reranker), results: results.map(({ sourceKind, sourceId, title, score, stale }) => ({ sourceKind, sourceId, title, score, stale })) }, null, 2)}\n`)
} finally {
  await gateway.close()
}
