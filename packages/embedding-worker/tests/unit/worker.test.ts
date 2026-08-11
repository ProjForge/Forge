import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  EmbeddingCandidate,
  EmbeddingCandidatePage,
  EmbeddingProfile,
  EmbeddingRecord,
  ListEmbeddingCandidatesInput,
  PutEmbeddingInput,
  RegisterEmbeddingProfileInput,
} from 'forge-persistence-gateway'
import { OptimisticLockError } from 'forge-persistence-gateway'
import { EmbeddingProviderError } from '../../src/errors.js'
import type { EmbeddingProvider, ForgeEmbeddingPort } from '../../src/types.js'
import { runEmbeddingWorker } from '../../src/worker.js'

const projectId = '00000000-0000-4000-8000-000000000001'

function candidate(
  sourceKind: EmbeddingCandidate['sourceKind'],
  sourceId: string,
  options: { truncated?: boolean; version?: number } = {},
): EmbeddingCandidate {
  return {
    projectId,
    sourceKind,
    sourceId,
    sourceVersion: options.version ?? 1,
    status: 'missing',
    title: `${sourceKind} ${sourceId}`,
    text: `text:${sourceKind}:${sourceId}`,
    textTruncated: options.truncated ?? false,
    inputHash: sourceId.padEnd(64, '0').slice(0, 64),
  }
}

class FakeGateway implements ForgeEmbeddingPort {
  readonly puts: PutEmbeddingInput[] = []
  readonly registered: RegisterEmbeddingProfileInput[] = []
  readonly embedded = new Set<string>()
  raceSourceId?: string

  constructor(readonly candidates: readonly EmbeddingCandidate[]) {}

  async registerEmbeddingProfile(input: RegisterEmbeddingProfileInput): Promise<EmbeddingProfile> {
    this.registered.push(input)
    return {
      id: '10000000-0000-4000-8000-000000000001',
      profileKey: input.profileKey,
      provider: input.provider,
      model: input.model,
      dimensions: input.dimensions,
      distanceMetric: input.distanceMetric ?? 'cosine',
      status: 'active',
      metadata: input.metadata ?? {},
      version: 1,
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    }
  }

  async listEmbeddingCandidates(input: ListEmbeddingCandidatesInput): Promise<EmbeddingCandidatePage> {
    const rows = [...this.candidates]
      .sort((left, right) => `${left.sourceKind}:${left.sourceId}`.localeCompare(`${right.sourceKind}:${right.sourceId}`))
      .filter((item) => !this.embedded.has(`${item.sourceKind}:${item.sourceId}:${item.sourceVersion}`))
      .filter((item) => !input.cursor
        || `${item.sourceKind}:${item.sourceId}` > `${input.cursor.sourceKind}:${input.cursor.sourceId}`)
    const limit = input.limit ?? 20
    const items = rows.slice(0, limit)
    const last = items.at(-1)
    return {
      profile: await this.registerEmbeddingProfile({
        profileKey: input.profileKey,
        provider: 'fake',
        model: 'fake-model',
        dimensions: 3,
      }),
      items,
      nextCursor: rows.length > limit && last
        ? { sourceKind: last.sourceKind, sourceId: last.sourceId }
        : null,
    }
  }

  async putEmbedding(input: PutEmbeddingInput): Promise<EmbeddingRecord> {
    if (input.sourceId === this.raceSourceId) {
      throw new OptimisticLockError('Embedding source', input.sourceId, input.sourceVersion)
    }
    this.puts.push(input)
    this.embedded.add(`${input.sourceKind}:${input.sourceId}:${input.sourceVersion}`)
    return {
      id: `20000000-0000-4000-8000-${String(this.puts.length).padStart(12, '0')}`,
      projectId: input.projectId,
      profileId: '10000000-0000-4000-8000-000000000001',
      profileKey: input.profileKey,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourceVersion: input.sourceVersion,
      dimensions: input.embedding.length,
      metadata: input.metadata ?? {},
      createdAt: '2026-08-10T00:00:00.000Z',
    }
  }
}

test('processes bounded pages and safely resumes as an idempotent no-op', async () => {
  const gateway = new FakeGateway([
    candidate('memory', '0001'),
    candidate('decision', '0002', { truncated: true }),
    candidate('memory', '0003'),
  ])
  let providerCalls = 0
  const provider: EmbeddingProvider = {
    name: 'fake-provider',
    model: 'fake-model',
    async embed(request) {
      providerCalls += 1
      return {
        vectors: request.inputs.map((_, index) => [1, index + 1, 0]),
        usage: { inputTokens: request.inputs.length * 2 },
      }
    },
  }

  const first = await runEmbeddingWorker({
    gateway,
    provider,
    projectId,
    profile: { profileKey: 'test-profile', dimensions: 3 },
    pageSize: 2,
    maxCandidates: 10,
  })
  assert.equal(first.complete, true)
  assert.equal(first.pages, 2)
  assert.equal(first.discovered, 3)
  assert.equal(first.embedded, 3)
  assert.equal(first.truncatedEmbedded, 1)
  assert.equal(first.providerAttempts, 2)
  assert.equal(first.inputTokens, 6)
  assert.equal(gateway.puts.length, 3)
  assert.equal(new Set(gateway.puts.map((put) => put.idempotencyKey)).size, 3)
  assert.ok(gateway.puts.every((put) => /^embedding-worker:[a-f0-9]{64}$/.test(put.idempotencyKey)))

  const second = await runEmbeddingWorker({
    gateway,
    provider,
    projectId,
    profile: { profileKey: 'test-profile', dimensions: 3 },
  })
  assert.equal(second.discovered, 0)
  assert.equal(second.embedded, 0)
  assert.equal(providerCalls, 2)
})

test('retries transient provider errors and respects retry-after', async () => {
  const gateway = new FakeGateway([candidate('memory', 'retry')])
  let calls = 0
  const sleeps: number[] = []
  const provider: EmbeddingProvider = {
    name: 'retry-provider',
    model: 'retry-model',
    async embed() {
      calls += 1
      if (calls === 1) {
        throw new EmbeddingProviderError('RATE_LIMITED', 'rate limited', true, 429, 75)
      }
      return { vectors: [[1, 0, 0]] }
    },
  }
  const result = await runEmbeddingWorker({
    gateway,
    provider,
    projectId,
    profile: { profileKey: 'retry-profile', dimensions: 3 },
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 100, jitterRatio: 0 },
    sleep: async (milliseconds) => { sleeps.push(milliseconds) },
  })
  assert.equal(result.embedded, 1)
  assert.equal(result.providerAttempts, 2)
  assert.deepEqual(sleeps, [75])
})

test('returns a deterministic checkpoint when the run budget is exhausted', async () => {
  const gateway = new FakeGateway([
    candidate('memory', 'budget-1'),
    candidate('memory', 'budget-2'),
    candidate('memory', 'budget-3'),
  ])
  const provider: EmbeddingProvider = {
    name: 'budget-provider',
    model: 'budget-model',
    async embed(request) {
      return { vectors: request.inputs.map(() => [1, 0, 0]) }
    },
  }
  const first = await runEmbeddingWorker({
    gateway,
    provider,
    projectId,
    profile: { profileKey: 'budget-profile', dimensions: 3 },
    pageSize: 1,
    maxCandidates: 1,
  })
  assert.equal(first.complete, false)
  assert.deepEqual(first.nextCursor, { sourceKind: 'memory', sourceId: 'budget-1' })

  const resumed = await runEmbeddingWorker({
    gateway,
    provider,
    projectId,
    profile: { profileKey: 'budget-profile', dimensions: 3 },
    ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    pageSize: 2,
    maxCandidates: 10,
  })
  assert.equal(resumed.complete, true)
  assert.equal(resumed.embedded, 2)
  assert.equal(gateway.puts.length, 3)
})

test('skips an explicit truncation policy and source-version race without corrupting the run', async () => {
  const gateway = new FakeGateway([
    candidate('memory', 'race'),
    candidate('memory', 'truncated', { truncated: true }),
  ])
  gateway.raceSourceId = 'race'
  const provider: EmbeddingProvider = {
    name: 'safe-provider',
    model: 'safe-model',
    async embed(request) {
      assert.equal(request.inputs.length, 1)
      return { vectors: [[1, 0, 0]] }
    },
  }
  const result = await runEmbeddingWorker({
    gateway,
    provider,
    projectId,
    profile: { profileKey: 'safe-profile', dimensions: 3 },
    rejectTruncatedText: true,
  })
  assert.equal(result.embedded, 0)
  assert.equal(result.skippedTruncated, 1)
  assert.equal(result.skippedSourceChanged, 1)
  assert.equal(result.complete, true)
})

test('applies a configurable document prefix and binds it to profile metadata', async () => {
  const gateway = new FakeGateway([candidate('memory', 'prefixed')])
  let providerInputs: readonly string[] = []
  const provider: EmbeddingProvider = {
    name: 'prefix-provider',
    model: 'prefix-model',
    async embed(request) {
      providerInputs = request.inputs
      return { vectors: [[1, 0, 0]] }
    },
  }

  const result = await runEmbeddingWorker({
    gateway,
    provider,
    projectId,
    profile: { profileKey: 'prefix-profile', dimensions: 3 },
    inputPrefix: '  search_document:  ',
    queryPrefix: '  search_query:  ',
  })

  assert.equal(result.embedded, 1)
  assert.deepEqual(providerInputs, ['search_document: text:memory:prefixed'])
  assert.deepEqual(gateway.registered[0]?.metadata, {
    forge_embedding_input_prefix: 'search_document:',
    forge_embedding_query_prefix: 'search_query:',
  })
  assert.equal(
    gateway.puts[0]?.metadata?.forge_embedding_input_prefix,
    'search_document:',
  )
})
