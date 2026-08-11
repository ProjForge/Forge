import type { SemanticSearchResult } from 'forge-persistence-gateway'
import type { SemanticBridgeOptions, TextSearchInput } from './types.js'
import { SemanticRerankerError } from './reranker.js'

function requiredText(name: string, value: string, max: number): string {
  const normalized = value.trim()
  if (!normalized) throw new TypeError(`${name} must not be empty`)
  if (normalized.length > max) throw new TypeError(`${name} exceeds ${max} characters`)
  return normalized
}

export class ForgeSemanticBridge {
  private readonly options: SemanticBridgeOptions

  constructor(options: SemanticBridgeOptions) {
    requiredText('profileKey', options.profile.profileKey, 200)
    if (!Number.isInteger(options.profile.dimensions) || options.profile.dimensions < 1 || options.profile.dimensions > 4096) {
      throw new TypeError('dimensions must be an integer between 1 and 4096')
    }
    this.options = options
  }

  async search(input: TextSearchInput): Promise<SemanticSearchResult[]> {
    const projectId = requiredText('projectId', input.projectId, 100)
    const query = requiredText('query', input.query, 32_000)
    const rerank = input.rerank === true
    if (rerank && !this.options.reranker) {
      throw new SemanticRerankerError('RERANKER_NOT_CONFIGURED', 'Semantic reranking is not configured')
    }
    if (rerank && !this.options.gateway.getSemanticCandidateTexts) {
      throw new SemanticRerankerError('RERANKER_NOT_SUPPORTED', 'Candidate-text hydration is not available')
    }
    const prefix = this.options.profile.queryPrefix?.trim()
    const embedded = await this.options.provider.embed({
      inputs: [prefix ? `${prefix} ${query}` : query],
      dimensions: this.options.profile.dimensions,
    })
    const queryEmbedding = embedded.vectors[0]
    if (!queryEmbedding) throw new Error('Embedding provider omitted the query vector')

    const requestedLimit = input.limit ?? 10
    const searchResults = await this.options.gateway.semanticSearch({
      projectId,
      profileKey: this.options.profile.profileKey,
      queryEmbedding: [...queryEmbedding],
      ...(input.sourceKinds ? { sourceKinds: [...input.sourceKinds] } : {}),
      ...(input.includeStale === undefined ? {} : { includeStale: input.includeStale }),
      ...(input.minScore === undefined ? {} : { minScore: input.minScore }),
      ...(rerank
        ? { limit: Math.max(requestedLimit, this.options.reranker!.candidateCount) }
        : input.limit === undefined ? {} : { limit: input.limit }),
    })
    if (!rerank || searchResults.length < 2) return searchResults

    const reranker = this.options.reranker!
    const candidateResults = searchResults.slice(0, reranker.candidateCount)
    const candidateTexts = await this.options.gateway.getSemanticCandidateTexts!({
      projectId,
      candidates: candidateResults.map((candidate) => ({
        sourceKind: candidate.sourceKind,
        sourceId: candidate.sourceId,
        sourceVersion: candidate.currentSourceVersion,
      })),
      maxTextChars: reranker.maxTextChars,
    })
    const { selectedIndex } = await reranker.select({ query, candidates: candidateTexts })
    const selected = candidateResults[selectedIndex]
    if (!selected) {
      throw new SemanticRerankerError('RERANKER_INVALID_RESPONSE', 'Reranker selected an unavailable candidate')
    }
    return [selected, ...searchResults.filter((candidate) => candidate !== selected)]
      .slice(0, requestedLimit)
  }
}
