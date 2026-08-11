import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ForgePersistenceGateway } from 'forge-persistence-gateway'
import { OpenAiCompatibleEmbeddingProvider, runEmbeddingWorker } from '../dist/index.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const corpus = JSON.parse(await readFile(resolve(root, 'evaluation/corpus-v2.json'), 'utf8'))
const required = (name) => { const value = process.env[name]?.trim(); if (!value) throw new TypeError(`${name} is required`); return value }
const profileKey = process.env.FORGE_EMBEDDING_PROFILE_KEY?.trim() || 'qwen3-embedding-0.6b-q8-1024-forge-retrieval-v1'
const dimensions = Number(process.env.FORGE_EMBEDDING_DIMENSIONS || 1024)
const queryPrefix = process.env.FORGE_EMBEDDING_QUERY_PREFIX?.trim() || 'Instruct: Given a user question about a software project, retrieve the most relevant project decision or memory that answers the question\nQuery:'
const gateway = ForgePersistenceGateway.connect({ connectionString: required('FORGE_DATABASE_URL'), maxConnections: 4 })
const provider = new OpenAiCompatibleEmbeddingProvider({
  baseUrl: process.env.FORGE_EMBEDDING_BASE_URL?.trim() || 'http://127.0.0.1:1234/v1',
  model: process.env.FORGE_EMBEDDING_MODEL?.trim() || 'text-embedding-qwen3-embedding-0.6b',
  name: 'lmstudio-local',
})

try {
  await gateway.assertReady()
  const project = await gateway.registerProject({ projectKey: 'embedding-multilingual-eval-v2', name: 'Embedding Multilingual Evaluation v2' })
  const expected = new Map()
  for (const fact of corpus.facts) {
    const memory = await gateway.remember({ projectId: project.id, memoryType: 'semantic', epistemicState: 'verified', trustLevel: 'internal', title: fact.title, content: fact.content, summary: `eval-v2:${fact.key}`, metadata: { evaluation: 'multilingual-v2', factKey: fact.key }, idempotencyKey: `eval-v2:fact:${fact.key}` })
    expected.set(fact.key, memory.id)
  }
  const indexed = await runEmbeddingWorker({ gateway, provider, projectId: project.id, profile: { profileKey, dimensions }, queryPrefix, pageSize: 30, maxCandidates: 100 })
  const queries = corpus.facts.flatMap((fact) => [{ key: fact.key, language: 'es', text: fact.es }, { key: fact.key, language: 'en', text: fact.en }])
  let top1 = 0, top3 = 0, reciprocalRanks = 0, stale = 0, projectLeaks = 0
  const failures = []
  for (const query of queries) {
    const embedded = await provider.embed({ inputs: [`${queryPrefix} ${query.text}`], dimensions })
    const results = await gateway.semanticSearch({ projectId: project.id, profileKey, queryEmbedding: [...embedded.vectors[0]], sourceKinds: ['memory'], limit: 3 })
    projectLeaks += results.filter((item) => item.projectId !== project.id).length
    stale += results.filter((item) => item.stale).length
    const rank = results.findIndex((item) => item.sourceId === expected.get(query.key)) + 1
    if (rank === 1) top1 += 1
    if (rank > 0 && rank <= 3) top3 += 1
    if (rank > 0) reciprocalRanks += 1 / rank
    if (rank !== 1) failures.push({ key: query.key, language: query.language, rank: rank || null, returned: results.map((item) => item.title) })
  }
  const total = queries.length
  const metrics = { total, top1: top1 / total, top3: top3 / total, mrr: reciprocalRanks / total, projectLeaks, stale }
  const accepted = metrics.top1 >= corpus.thresholds.top1 && metrics.top3 >= corpus.thresholds.top3 && metrics.mrr >= corpus.thresholds.mrr && projectLeaks <= corpus.thresholds.maxProjectLeaks && stale <= corpus.thresholds.maxStale
  const report = { status: accepted ? 'PASS' : 'FAIL', corpusVersion: corpus.version, profileKey, queryPrefix, facts: corpus.facts.length, indexed, thresholds: corpus.thresholds, metrics, failures }
  const resultFile = process.env.FORGE_EVALUATION_RESULT_FILE?.trim() || 'results-v2.json'
  if (!/^[a-zA-Z0-9._-]+\.json$/.test(resultFile)) throw new TypeError('FORGE_EVALUATION_RESULT_FILE is invalid')
  await writeFile(resolve(root, 'evaluation', resultFile), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (!accepted) process.exitCode = 1
} finally { await gateway.close() }
