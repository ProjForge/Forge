import type {
  EmbeddingCandidateCursor,
  EmbeddingCandidatePage,
  EmbeddingDistanceMetric,
  EmbeddingProfile,
  EmbeddingRecord,
  EmbeddingSourceKind,
  JsonObject,
  ListEmbeddingCandidatesInput,
  PutEmbeddingInput,
  RegisterEmbeddingProfileInput,
} from 'forge-persistence-gateway'

export interface ForgeEmbeddingPort {
  registerEmbeddingProfile(input: RegisterEmbeddingProfileInput): Promise<EmbeddingProfile>
  listEmbeddingCandidates(input: ListEmbeddingCandidatesInput): Promise<EmbeddingCandidatePage>
  putEmbedding(input: PutEmbeddingInput): Promise<EmbeddingRecord>
}

export interface EmbeddingProviderRequest {
  inputs: readonly string[]
  dimensions: number
  signal?: AbortSignal
}

export interface EmbeddingProviderUsage {
  inputTokens?: number
  totalTokens?: number
}

export interface EmbeddingProviderResult {
  vectors: readonly (readonly number[])[]
  model?: string
  usage?: EmbeddingProviderUsage
}

export interface EmbeddingProvider {
  readonly name: string
  readonly model: string
  embed(request: EmbeddingProviderRequest): Promise<EmbeddingProviderResult>
}

export interface EmbeddingWorkerProfile {
  profileKey: string
  dimensions: number
  distanceMetric?: EmbeddingDistanceMetric
  metadata?: JsonObject
}

export interface EmbeddingWorkerRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
}

export interface EmbeddingWorkerOptions {
  gateway: ForgeEmbeddingPort
  provider: EmbeddingProvider
  projectId: string
  profile: EmbeddingWorkerProfile
  sourceKinds?: readonly EmbeddingSourceKind[]
  cursor?: EmbeddingCandidateCursor
  pageSize?: number
  maxCandidates?: number
  maxTextChars?: number
  inputPrefix?: string
  queryPrefix?: string
  rejectTruncatedText?: boolean
  agentId?: string
  executionId?: string
  retry?: EmbeddingWorkerRetryOptions
  signal?: AbortSignal
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
}

export interface EmbeddingWorkerResult {
  profile: EmbeddingProfile
  pages: number
  discovered: number
  embedded: number
  skippedSourceChanged: number
  skippedTruncated: number
  truncatedEmbedded: number
  providerAttempts: number
  inputTokens: number | null
  nextCursor: EmbeddingCandidateCursor | null
  complete: boolean
}
