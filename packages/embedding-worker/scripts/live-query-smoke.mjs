import { ForgePersistenceGateway } from 'forge-persistence-gateway'
import { OpenAiCompatibleEmbeddingProvider } from '../dist/providers/openai-compatible.js'

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new TypeError(`${name} is required`)
  return value
}

function positiveInteger(name, fallback) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name])
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`)
  return value
}

const dimensions = positiveInteger('FORGE_EMBEDDING_DIMENSIONS', 0)
const query = required('FORGE_EMBEDDING_QUERY')
const queryPrefix = process.env.FORGE_EMBEDDING_QUERY_PREFIX?.trim()
const apiKey = process.env.FORGE_EMBEDDING_API_KEY?.trim()
const gateway = ForgePersistenceGateway.connect({
  connectionString: required('FORGE_DATABASE_URL'),
  maxConnections: 2,
})

try {
  await gateway.assertReady()
  const provider = new OpenAiCompatibleEmbeddingProvider({
    baseUrl: process.env.FORGE_EMBEDDING_BASE_URL?.trim(),
    model: required('FORGE_EMBEDDING_MODEL'),
    ...(apiKey ? { apiKey } : {}),
  })
  const embedded = await provider.embed({
    inputs: [queryPrefix ? `${queryPrefix} ${query}` : query],
    dimensions,
  })
  const queryEmbedding = embedded.vectors[0]
  if (!queryEmbedding) throw new Error('Provider omitted the query vector')

  const results = await gateway.semanticSearch({
    projectId: required('FORGE_PROJECT_ID'),
    profileKey: required('FORGE_EMBEDDING_PROFILE_KEY'),
    queryEmbedding,
    sourceKinds: (process.env.FORGE_EMBEDDING_SOURCE_KINDS ?? 'memory,decision,document_chunk')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    limit: positiveInteger('FORGE_EMBEDDING_SEARCH_LIMIT', 5),
  })

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    query,
    results: results.map((item) => ({
      sourceKind: item.sourceKind,
      sourceId: item.sourceId,
      title: item.title,
      score: item.score,
      stale: item.stale,
    })),
  })}\n`)
} finally {
  await gateway.close()
}
