import type { ForgePersistenceGateway, Task } from 'forge-persistence-gateway'

export interface Artifact { title: string; content: string }
export type EffectKind = 'none' | 'immutable-report-v1'
export interface EffectPolicy { kind: EffectKind; targetId: string }
export interface EffectReceipt { kind: 'immutable-report-v1'; key: string; sha256: string; filename: string; targetId: string }
export interface ArtifactPublisher {
  readonly kind: 'immutable-report-v1'
  readonly targetId: string
  publish(input: { key: string; artifact: Artifact; signal: AbortSignal; expected?: EffectReceipt }): Promise<EffectReceipt>
}
export interface Job {
  id: string; projectId: string; taskId: string; taskKey: string; agentId: string
  state: 'queued' | 'running' | 'completed' | 'failed'
  owner: string | null; epoch: number; attempts: number; maxAttempts: number
  artifact: Artifact | null
  effectKind: EffectKind
  effectTarget: string
  effectReceipt: EffectReceipt | null
}
export interface Claim { job: Job; workerId: string; epoch: number }
export interface WorkerIdentity { projectId: string; agentId: string; workerId: string }
export interface Change<T> { value: T; artifact?: Artifact; completed?: boolean; effectReceipt?: EffectReceipt }
export interface JobStore {
  claim(worker: WorkerIdentity, effect?: EffectPolicy, recovery?: { taskId: string; receipt: EffectReceipt }): Promise<Claim | null>
  heartbeat(claim: Claim): Promise<boolean>
  fenced<T>(claim: Claim, operation: (job: Job) => Promise<Change<T>>): Promise<T>
  fail(claim: Claim, code?: FailureCode): Promise<void>
  readonly leaseMs: number
}
export type FailureCode = 'WORKER_FAILED' | 'AGENT_HTTP_ERROR' | 'AGENT_TIMEOUT' | 'AGENT_UNAVAILABLE' | 'AGENT_INVALID_OUTPUT' | 'EFFECT_CONFLICT' | 'EFFECT_UNCONFIRMED' | 'EFFECT_TARGET_CHANGED' | 'EFFECT_POLICY_MISMATCH'
export class PilotFailure extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = 'PilotFailure' }
}
export type CorePort = Pick<ForgePersistenceGateway,
  'assertReady' | 'getTaskByKey' | 'updateTaskStatus' | 'getExecutionByKey' |
  'startExecution' | 'listExecutions' | 'remember' | 'compileContinuationContext' | 'finishExecution'>
export type Handler = (input: { task: Task; signal: AbortSignal }) => Promise<Artifact>
export class LeaseLostError extends Error {
  constructor() { super('Coordinator lease lost'); this.name = 'LeaseLostError' }
}
