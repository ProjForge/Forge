import type { ForgePersistenceGateway, Task } from 'forge-persistence-gateway'

export interface Artifact { title: string; content: string }
export interface Job {
  id: string; projectId: string; taskId: string; taskKey: string; agentId: string
  state: 'queued' | 'running' | 'completed' | 'failed'
  owner: string | null; epoch: number; attempts: number; maxAttempts: number
  artifact: Artifact | null
}
export interface Claim { job: Job; workerId: string; epoch: number }
export interface WorkerIdentity { projectId: string; agentId: string; workerId: string }
export interface Change<T> { value: T; artifact?: Artifact; completed?: boolean }
export interface JobStore {
  claim(worker: WorkerIdentity): Promise<Claim | null>
  heartbeat(claim: Claim): Promise<boolean>
  fenced<T>(claim: Claim, operation: (job: Job) => Promise<Change<T>>): Promise<T>
  fail(claim: Claim): Promise<void>
  readonly leaseMs: number
}
export type CorePort = Pick<ForgePersistenceGateway,
  'assertReady' | 'getTaskByKey' | 'updateTaskStatus' | 'getExecutionByKey' |
  'startExecution' | 'listExecutions' | 'remember' | 'compileContinuationContext' | 'finishExecution'>
export type Handler = (input: { task: Task; signal: AbortSignal }) => Promise<Artifact>
export class LeaseLostError extends Error {
  constructor() { super('Coordinator lease lost'); this.name = 'LeaseLostError' }
}
