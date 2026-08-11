import { createHash } from 'node:crypto'
import { ForgeGatewayError } from 'forge-persistence-gateway'
import { EmbeddingWorkerError } from './errors.js'
import { defaultSleep, withProviderRetry } from './retry.js'
import type {
  EmbeddingProviderResult,
  EmbeddingWorkerOptions,
  EmbeddingWorkerResult,
} from './types.js'

const SOURCE_KINDS = new Set(['memory', 'decision', 'document_chunk'])

function requiredText(name: string, value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`${name} must not be empty`)
  return normalized
}

function integerInRange(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function idempotencyKey(
  profileKey: string,
  sourceKind: string,
  sourceId: string,
  sourceVersion: number,
  inputHash: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ profileKey, sourceKind, sourceId, sourceVersion, inputHash }), 'utf8')
    .digest('hex')
  return `embedding-worker:${digest}`
}

function validateProviderResult(
  result: EmbeddingProviderResult,
  expectedItems: number,
  dimensions: number,
  cosine: boolean,
): void {
  if (result.vectors.length !== expectedItems) {
    throw new EmbeddingWorkerError('PROVIDER_INVALID_RESPONSE', 'Embedding provider returned an invalid item count')
  }
  for (const vector of result.vectors) {
    if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
      throw new EmbeddingWorkerError('PROVIDER_INVALID_VECTOR', 'Embedding provider returned an invalid vector')
    }
    if (cosine && vector.every((value) => value === 0)) {
      throw new EmbeddingWorkerError('PROVIDER_ZERO_VECTOR', 'Cosine embedding provider returned a zero vector')
    }
  }
}

export async function runEmbeddingWorker(options: EmbeddingWorkerOptions): Promise<EmbeddingWorkerResult> {
  const projectId = requiredText('projectId', options.projectId)
  const profileKey = requiredText('profileKey', options.profile.profileKey)
  const dimensions = integerInRange('dimensions', options.profile.dimensions, 1, 4096)
  const pageSize = integerInRange('pageSize', options.pageSize ?? 20, 1, 50)
  const maxCandidates = integerInRange('maxCandidates', options.maxCandidates ?? 100, 1, 10_000)
  const maxTextChars = integerInRange('maxTextChars', options.maxTextChars ?? 8_000, 1, 32_000)
  const inputPrefix = options.inputPrefix?.trim() || undefined
  const queryPrefix = options.queryPrefix?.trim() || undefined
  const sourceKinds = options.sourceKinds ?? ['memory', 'decision', 'document_chunk']
  if (sourceKinds.length < 1 || sourceKinds.some((kind) => !SOURCE_KINDS.has(kind))) {
    throw new TypeError('sourceKinds must contain supported source kinds')
  }
  options.signal?.throwIfAborted()

  const profile = await options.gateway.registerEmbeddingProfile({
    profileKey,
    provider: requiredText('provider.name', options.provider.name),
    model: requiredText('provider.model', options.provider.model),
    dimensions,
    distanceMetric: options.profile.distanceMetric ?? 'cosine',
    ...((options.profile.metadata || inputPrefix || queryPrefix) ? {
      metadata: {
        ...(options.profile.metadata ?? {}),
        ...(inputPrefix ? { forge_embedding_input_prefix: inputPrefix } : {}),
        ...(queryPrefix ? { forge_embedding_query_prefix: queryPrefix } : {}),
      },
    } : {}),
  })

  let cursor = options.cursor
  let pages = 0
  let discovered = 0
  let embedded = 0
  let skippedSourceChanged = 0
  let skippedTruncated = 0
  let truncatedEmbedded = 0
  let providerAttempts = 0
  let inputTokens = 0
  let sawInputTokens = false

  while (discovered < maxCandidates) {
    options.signal?.throwIfAborted()
    const remaining = maxCandidates - discovered
    const page = await options.gateway.listEmbeddingCandidates({
      projectId,
      profileKey,
      sourceKinds,
      limit: Math.min(pageSize, remaining),
      maxTextChars,
      ...(cursor ? { cursor } : {}),
    })
    pages += 1
    discovered += page.items.length
    if (page.items.length === 0) {
      return {
        profile,
        pages,
        discovered,
        embedded,
        skippedSourceChanged,
        skippedTruncated,
        truncatedEmbedded,
        providerAttempts,
        inputTokens: sawInputTokens ? inputTokens : null,
        nextCursor: null,
        complete: true,
      }
    }

    const candidates = options.rejectTruncatedText
      ? page.items.filter((candidate) => {
          if (!candidate.textTruncated) return true
          skippedTruncated += 1
          return false
        })
      : page.items

    if (candidates.length > 0) {
      const retried = await withProviderRetry(
        () => options.provider.embed({
          inputs: candidates.map((candidate) => inputPrefix
            ? `${inputPrefix} ${candidate.text}`
            : candidate.text),
          dimensions,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
        options.retry,
        {
          sleep: options.sleep ?? defaultSleep,
          random: options.random ?? Math.random,
        },
        options.signal,
      )
      providerAttempts += retried.attempts
      validateProviderResult(
        retried.value,
        candidates.length,
        dimensions,
        profile.distanceMetric === 'cosine',
      )
      if (retried.value.usage?.inputTokens !== undefined) {
        inputTokens += retried.value.usage.inputTokens
        sawInputTokens = true
      }

      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index]
        const vector = retried.value.vectors[index]
        if (!candidate || !vector) throw new Error('Provider result alignment failed')
        try {
          await options.gateway.putEmbedding({
            projectId,
            profileKey,
            sourceKind: candidate.sourceKind,
            sourceId: candidate.sourceId,
            sourceVersion: candidate.sourceVersion,
            embedding: vector,
            idempotencyKey: idempotencyKey(
              profileKey,
              candidate.sourceKind,
              candidate.sourceId,
              candidate.sourceVersion,
              candidate.inputHash,
            ),
            metadata: {
              forge_embedding_input_hash: candidate.inputHash,
              forge_embedding_provider: options.provider.name,
              forge_embedding_model: options.provider.model,
              forge_embedding_text_truncated: candidate.textTruncated,
              forge_embedding_candidate_status: candidate.status,
              ...(inputPrefix ? { forge_embedding_input_prefix: inputPrefix } : {}),
            },
            ...(options.agentId ? { agentId: options.agentId } : {}),
            ...(options.executionId ? { executionId: options.executionId } : {}),
          })
          embedded += 1
          if (candidate.textTruncated) truncatedEmbedded += 1
        } catch (error) {
          if (error instanceof ForgeGatewayError && error.code === 'OPTIMISTIC_LOCK_FAILED') {
            skippedSourceChanged += 1
            continue
          }
          throw error
        }
      }
    }

    cursor = page.nextCursor ?? undefined
    if (!cursor) {
      return {
        profile,
        pages,
        discovered,
        embedded,
        skippedSourceChanged,
        skippedTruncated,
        truncatedEmbedded,
        providerAttempts,
        inputTokens: sawInputTokens ? inputTokens : null,
        nextCursor: null,
        complete: true,
      }
    }
  }

  return {
    profile,
    pages,
    discovered,
    embedded,
    skippedSourceChanged,
    skippedTruncated,
    truncatedEmbedded,
    providerAttempts,
    inputTokens: sawInputTokens ? inputTokens : null,
    nextCursor: cursor ?? null,
    complete: false,
  }
}
