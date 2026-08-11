import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ForgePersistenceGateway } from 'forge-persistence-gateway'
import { OpenAiCompatibleEmbeddingProvider } from '../dist/index.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const corpus = JSON.parse(await readFile(resolve(root, 'evaluation/corpus-v2.json'), 'utf8'))
const required = (name) => { const value = process.env[name]?.trim(); if (!value) throw new TypeError(`${name} is required`); return value }
const profileKey = 'qwen3-embedding-0.6b-q8-1024-forge-retrieval-v1'
const dimensions = 1024
const queryPrefix = 'Instruct: Given a user question about a software project, retrieve the most relevant project decision or memory that answers the question\nQuery:'
const rerankerModel = process.env.FORGE_RERANKER_MODEL?.trim() || 'forge-reranker-qwen35-9b'
const baseUrl = process.env.FORGE_EMBEDDING_BASE_URL?.trim() || 'http://127.0.0.1:1234/v1'
const gateway = ForgePersistenceGateway.connect({ connectionString: required('FORGE_DATABASE_URL'), maxConnections: 4 })
const provider = new OpenAiCompatibleEmbeddingProvider({ baseUrl, model: 'text-embedding-qwen3-embedding-0.6b', name: 'lmstudio-local' })

async function rerank(query, candidates) {
  const prompt = [
    'Select the single candidate that most directly answers the query.',
    'Return only its integer number. Do not explain.',
    `Query: ${query}`,
    ...candidates.map((candidate, index) => `${index + 1}. ${candidate.title}\n${candidate.content}`),
  ].join('\n\n')
  const started = performance.now()
  const response = await fetch(new URL('chat/completions', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: rerankerModel, temperature: 0, max_tokens: 16, reasoning_effort: 'none', messages: [
      { role: 'system', content: 'You are a deterministic multilingual relevance reranker.' },
      { role: 'user', content: prompt },
    ] }),
  })
  if (!response.ok) throw new Error(`Reranker HTTP ${response.status}`)
  const parsed = await response.json()
  const content = parsed?.choices?.[0]?.message?.content
  const match = typeof content === 'string' ? content.match(/\b([1-5])\b/) : null
  if (!match) throw new Error('Reranker did not return a candidate number')
  return { index: Number(match[1]) - 1, latencyMs: performance.now() - started }
}

try {
  await gateway.assertReady()
  const project = await gateway.registerProject({ projectKey: 'embedding-multilingual-eval-v2', name: 'Embedding Multilingual Evaluation v2' })
  const factById = new Map(), expected = new Map()
  for (const fact of corpus.facts) {
    const memory = await gateway.remember({ projectId: project.id, memoryType: 'semantic', epistemicState: 'verified', trustLevel: 'internal', title: fact.title, content: fact.content, summary: `eval-v2:${fact.key}`, metadata: { evaluation: 'multilingual-v2', factKey: fact.key }, idempotencyKey: `eval-v2:fact:${fact.key}` })
    expected.set(fact.key, memory.id); factById.set(memory.id, fact)
  }
  const queries = corpus.facts.flatMap((fact) => [{ key: fact.key, language: 'es', text: fact.es }, { key: fact.key, language: 'en', text: fact.en }])
  let semanticTop1 = 0, recall5 = 0, rerankedTop1 = 0, projectLeaks = 0, stale = 0, parseErrors = 0
  const latencies = [], failures = []
  for (const query of queries) {
    const vector = await provider.embed({ inputs: [`${queryPrefix} ${query.text}`], dimensions })
    const results = await gateway.semanticSearch({ projectId: project.id, profileKey, queryEmbedding: [...vector.vectors[0]], sourceKinds: ['memory'], limit: 5 })
    projectLeaks += results.filter((item) => item.projectId !== project.id).length
    stale += results.filter((item) => item.stale).length
    const expectedId = expected.get(query.key)
    if (results[0]?.sourceId === expectedId) semanticTop1 += 1
    if (results.some((item) => item.sourceId === expectedId)) recall5 += 1
    const candidates = results.map((item) => ({ sourceId: item.sourceId, title: item.title, content: factById.get(item.sourceId)?.content || item.summary || '' }))
    let selected = 0
    try { const ranked = await rerank(query.text, candidates); selected = ranked.index; latencies.push(ranked.latencyMs) } catch { parseErrors += 1 }
    if (candidates[selected]?.sourceId === expectedId) rerankedTop1 += 1
    else failures.push({ key: query.key, language: query.language, selected: candidates[selected]?.title || null, candidates: candidates.map((item) => item.title) })
  }
  latencies.sort((a, b) => a - b)
  const percentile = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? null
  const total = queries.length
  const metrics = { total, semanticTop1: semanticTop1 / total, candidateRecall5: recall5 / total, rerankedTop1: rerankedTop1 / total, projectLeaks, stale, parseErrors, latencyMs: { mean: latencies.reduce((a, b) => a + b, 0) / Math.max(1, latencies.length), p50: percentile(0.5), p95: percentile(0.95) } }
  const accepted = metrics.rerankedTop1 >= corpus.thresholds.top1 && projectLeaks === 0 && stale === 0 && parseErrors === 0
  const report = { status: accepted ? 'PASS' : 'FAIL', corpusVersion: corpus.version, embeddingProfile: profileKey, rerankerModel, candidates: 5, metrics, failures }
  await writeFile(resolve(root, 'evaluation/results-v2-reranker-qwen35-9b.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (!accepted) process.exitCode = 1
} finally { await gateway.close() }
