import type {
  EmbeddingSourceKind,
  GetSemanticCandidateTextsInput,
  SemanticCandidateText,
  SemanticSearchInput,
  SemanticSearchResult,
} from 'forge-persistence-gateway'
import type { EmbeddingProvider } from 'forge-embedding-worker'

export interface SemanticSearchPort {
  semanticSearch(input: SemanticSearchInput): Promise<SemanticSearchResult[]>
  getSemanticCandidateTexts?(input: GetSemanticCandidateTextsInput): Promise<SemanticCandidateText[]>
}

export interface SemanticReranker {
  readonly name: string
  readonly model: string
  readonly candidateCount: number
  readonly maxTextChars: number
  select(input: {
    query: string
    candidates: readonly SemanticCandidateText[]
  }): Promise<{ selectedIndex: number; latencyMs: number }>
}

export interface SemanticBridgeProfile {
  profileKey: string
  dimensions: number
  queryPrefix?: string
}

export interface TextSearchInput {
  projectId: string
  query: string
  sourceKinds?: readonly EmbeddingSourceKind[]
  includeStale?: boolean
  minScore?: number
  limit?: number
  rerank?: boolean
}

export interface SemanticBridgeOptions {
  gateway: SemanticSearchPort
  provider: EmbeddingProvider
  profile: SemanticBridgeProfile
  reranker?: SemanticReranker
}
