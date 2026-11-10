import { NotFoundError, withOperationalAdmission, type Execution, type Task } from 'forge-persistence-gateway'
import { LeaseLostError, PilotFailure, type Artifact, type ArtifactPublisher, type CorePort, type Handler, type Job, type JobStore, type EffectReceipt, type WorkerIdentity } from './types.js'
import { reportIdentity } from './report-publisher.js'

export function validateArtifact(value: Artifact): Artifact {
  if (typeof value?.title !== 'string' || !value.title.trim() || value.title.length > 500 ||
      typeof value.content !== 'string' || !value.content.trim() || value.content.length > 32_000) throw new Error('Invalid or oversized agent artifact')
  return { title: value.title, content: value.content }
}

function executionKey(job: Job): string { return `coordinator:v1:${job.projectId}:${job.taskId}` }

export class Coordinator {
  private readonly handlerTimeoutMs: number
  constructor(private readonly store: JobStore, private readonly core: CorePort, private readonly options: { handlerTimeoutMs?: number; publisher?: ArtifactPublisher; recovery?: { taskId: string; receipt: EffectReceipt } } = {}) {
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? 120_000
    if (!Number.isInteger(this.handlerTimeoutMs) || this.handlerTimeoutMs < 100 || this.handlerTimeoutMs > 3_600_000) throw new RangeError('handlerTimeoutMs must be 100..3600000')
  }

  async runOnce(worker: WorkerIdentity, handler: Handler): Promise<'idle' | 'completed' | 'lost' | 'failed'> {
    return withOperationalAdmission(() => this.runAdmitted(worker, handler))
  }

  private async runAdmitted(worker: WorkerIdentity, handler: Handler): Promise<'idle' | 'completed' | 'lost' | 'failed'> {
    await this.core.assertReady()
    const claim = await this.store.claim(worker, { kind: this.options.publisher?.kind ?? 'none', targetId: this.options.publisher?.targetId ?? '' }, this.options.recovery)
    if (!claim) return 'idle'
    const controller = new AbortController()
    let timer: ReturnType<typeof setInterval> | undefined
    let beat: Promise<void> | undefined
    const stopHeartbeat = async () => { clearInterval(timer); await beat }
    try {
      const prepared = await this.store.fenced(claim, async (current) => {
        if (current.effectKind !== (this.options.publisher?.kind ?? 'none') || current.effectTarget !== (this.options.publisher?.targetId ?? '')) throw new PilotFailure('EFFECT_POLICY_MISMATCH')
        // A prior receipt requires its prepared output, even before Core succeeds.
        // Regeneration could conceal state loss or produce a conflicting effect.
        if (current.effectReceipt && !current.artifact) throw new PilotFailure('EFFECT_UNCONFIRMED')
        if (this.options.recovery && (current.taskId !== this.options.recovery.taskId || !current.artifact || !current.effectReceipt ||
            Object.keys(this.options.recovery.receipt).some(key => current.effectReceipt![key as keyof EffectReceipt] !== this.options.recovery!.receipt[key as keyof EffectReceipt]))) throw new PilotFailure('EFFECT_UNCONFIRMED')
        const task = await this.task(current)
        const execution = await this.execution(current, task)
        if (execution.status === 'succeeded') {
          if (task.status !== 'done') throw new Error('Completed execution has an inconsistent task')
          if (!this.options.publisher) return { value: { task, completed: true }, completed: true }
          if (!current.effectReceipt || !current.artifact) throw new PilotFailure('EFFECT_UNCONFIRMED')
          // An external effect is still verified before reconciling completion.
          return { value: { task, completed: false } }
        }
        // Execution admission may have advanced a ready task's version/status.
        return { value: { task: await this.task(current), completed: false } }
      })
      if (prepared.completed) return 'completed'
      timer = setInterval(() => {
        if (beat) return
        beat = this.store.heartbeat(claim).then((valid) => { if (!valid) controller.abort(new LeaseLostError()) }, () => controller.abort(new LeaseLostError())).finally(() => { beat = undefined })
      }, Math.floor(this.store.leaseMs / 3))
      let artifact = claim.job.artifact
      if (!artifact) {
        artifact = validateArtifact(await this.generate(handler, prepared.task, controller))
        await stopHeartbeat()
        if (controller.signal.aborted) throw new LeaseLostError()
        // Persist output before Core publication, so retries use identical data.
        await this.store.fenced(claim, async () => ({ value: undefined, artifact: artifact! }))
      } else { await stopHeartbeat() }
      if (controller.signal.aborted) throw new LeaseLostError()
      const output = validateArtifact(artifact)
      const publisher = this.options.publisher
      if (publisher) {
        await this.store.fenced(claim, async (current) => {
          const key = `${executionKey(current)}:report`
          const receipt = await publisher.publish({ key, artifact: output, signal: controller.signal,
            ...(current.effectReceipt ? { expected: current.effectReceipt } : {}) })
          const expected = reportIdentity(key, output, publisher.targetId).receipt
          if (receipt.kind !== expected.kind || receipt.key !== key || receipt.sha256 !== expected.sha256 || receipt.filename !== expected.filename || receipt.targetId !== publisher.targetId) throw new PilotFailure('EFFECT_UNCONFIRMED')
          return { value: undefined, effectReceipt: receipt }
        })
      }
      await this.store.fenced(claim, async (current) => {
        if (current.effectKind !== 'none' && !current.effectReceipt) throw new PilotFailure('EFFECT_UNCONFIRMED')
        let task = await this.task(current)
        const execution = await this.execution(current, task)
        if (execution.status !== 'succeeded') {
          await this.core.remember({ projectId: current.projectId, taskId: current.taskId, agentId: current.agentId,
            executionId: execution.id, memoryType: 'execution_summary', title: output.title, content: output.content,
            provenance: { sourceKind: 'execution', sourceRef: execution.id }, idempotencyKey: `${executionKey(current)}:result` })
          if (task.status !== 'done') task = await this.core.updateTaskStatus({ projectId: current.projectId, taskId: current.taskId, expectedVersion: task.version, status: 'done' })
          const context = await this.core.compileContinuationContext({ projectId: current.projectId, taskId: current.taskId, agentId: current.agentId,
            executionId: execution.id, idempotencyKey: `${executionKey(current)}:context` })
          await this.core.finishExecution({ projectId: current.projectId, executionId: execution.id, agentId: current.agentId,
            expectedVersion: execution.version, status: 'succeeded', details: { context_package_id: context.packageId } })
        }
        return { value: undefined, completed: true }
      })
      return 'completed'
    } catch (error) {
      if (error instanceof LeaseLostError) return 'lost'
      await this.store.fail(claim, error instanceof PilotFailure ? error.code : 'WORKER_FAILED')
      return 'failed'
    } finally { controller.abort(); await stopHeartbeat() }
  }

  private async generate(handler: Handler, task: Task, controller: AbortController): Promise<Artifact> {
    const timer = setTimeout(() => controller.abort(new Error('Agent handler deadline exceeded')), this.handlerTimeoutMs)
    let aborted!: () => void
    const cancellation = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', aborted, { once: true })
      if (controller.signal.aborted) aborted()
    })
    try { return await Promise.race([handler({ task, signal: controller.signal }), cancellation]) }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', aborted) }
  }

  private async task(current: Job): Promise<Task> {
    const task = await this.core.getTaskByKey(current.projectId, current.taskKey)
    if (task.id !== current.taskId || task.assignedAgentId !== current.agentId || !['ready', 'in_progress', 'done'].includes(task.status)) throw new Error('Task identity, assignment or state changed')
    return task
  }

  private async execution(current: Job, task: Task): Promise<Execution> {
    const key = executionKey(current)
    let execution: Execution
    try { execution = await this.core.getExecutionByKey(current.projectId, key) }
    catch (error) {
      if (this.options.recovery || !(error instanceof NotFoundError) || task.status === 'done') throw error
      const running = await this.core.listExecutions({ projectId: current.projectId, taskId: current.taskId, status: 'running', limit: 1 })
      if (running.items.length) throw new Error('Task already has an uncoordinated running execution')
      if (task.status === 'ready') await this.core.updateTaskStatus({ projectId: current.projectId, taskId: task.id, expectedVersion: task.version, status: 'in_progress' })
      execution = await this.core.startExecution({ projectId: current.projectId, taskId: current.taskId, agentId: current.agentId,
        executionKey: key, idempotencyKey: key, policyVersion: 'external-coordinator-v1', metadata: { coordinatorJobId: current.id } })
    }
    if (execution.taskId !== current.taskId || execution.agentId !== current.agentId || execution.metadata.coordinatorJobId !== current.id ||
      !['running', 'succeeded'].includes(execution.status)) throw new Error('Execution is incompatible or terminal')
    return execution
  }
}
