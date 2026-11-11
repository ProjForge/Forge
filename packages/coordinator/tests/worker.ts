import { setTimeout as delay } from 'node:timers/promises'
import { ForgePersistenceGateway } from 'forge-persistence-gateway'
import { Coordinator, ImmutableReportPublisher, LocalReportAgent, PostgresJobStore } from '../src/index.js'
import type { ArtifactPublisher, CorePort, Job, JobStore } from '../src/index.js'

if (process.env.FORGE_COORDINATOR_TEST_ADMIN_URL || process.env.FORGE_ADMIN_DATABASE_URL || process.env.FORGE_RUNTIME_PASSWORD) {
  throw new Error('Worker fixture must not inherit provisioning credentials')
}
if (process.execArgv.length) throw new Error('Worker fixture must not inherit test-runner runtime flags')

const [projectId, agentId, workerId, mode = 'normal'] = process.argv.slice(2) as [string, string, string, string?]
const core = ForgePersistenceGateway.connect({ connectionString: process.env.FORGE_DATABASE_URL!, maxConnections: 2 })
const store = new PostgresJobStore(process.env.FORGE_COORDINATOR_DATABASE_URL!, 3_000)
const agentMode = mode.startsWith('agent-')
const model = agentMode ? new LocalReportAgent({ baseUrl: process.env.FORGE_COORDINATOR_AGENT_BASE_URL!, model: process.env.FORGE_COORDINATOR_AGENT_MODEL! }) : undefined
const report = agentMode ? new ImmutableReportPublisher(process.env.FORGE_COORDINATOR_REPORT_ROOT!) : undefined
const pause = async (phase: string): Promise<never> => {
  process.send?.({ phase })
  return new Promise(() => {})
}
const port: CorePort = new Proxy(core, {
  get(target, property) {
    const value: unknown = Reflect.get(target, property)
    if (typeof value !== 'function') return value
    return async (...args: unknown[]) => {
      if (mode === 'agent-crash-after-receipt' && property === 'remember') await pause('effect-confirmed')
      const result: unknown = await Reflect.apply(value, target, args)
      if (mode === 'crash-after-memory' && property === 'remember') await pause('memory-written')
      if (mode === 'crash-after-finish' && property === 'finishExecution') await pause('execution-finished')
      if (mode === 'agent-crash-after-core' && property === 'finishExecution') await pause('effect-core-finished')
      return result
    }
  },
})
try {
  let currentJob: Job | undefined
  const trackedStore: JobStore = { leaseMs: store.leaseMs, heartbeat: store.heartbeat.bind(store), fail: store.fail.bind(store),
    fenced: async (claim, operation) => {
      const started = performance.now()
      try {
        let checkpoint = {}
        const value = await store.fenced(claim, async (current) => {
          const change = await operation(current)
          checkpoint = { artifact: Boolean(change.artifact), receipt: Boolean(change.effectReceipt), terminal: Boolean(change.completed) }
          return change
        })
        process.send?.({ phase: 'checkpoint', ...checkpoint, elapsedMs: Math.round(performance.now() - started) })
        return value
      } catch (error) { process.send?.({ phase: 'fence-error', code: error instanceof Error ? error.name : 'UNKNOWN', elapsedMs: Math.round(performance.now() - started) }); throw error }
    },
    claim: async (identity, effect) => { const claim = await store.claim(identity, effect); currentJob = claim?.job; if (claim) process.send?.({ phase: 'claimed', jobId: claim.job.id, epoch: claim.epoch }); return claim } }
  const publisher: ArtifactPublisher | undefined = report ? { kind: report.kind, targetId: report.targetId, hasReport: key => report.hasReport(key), publish: async (input) => {
    const receipt = await report.publish(input)
    if (mode === 'agent-crash-after-effect') await pause('effect-created')
    return receipt
  } } : undefined
  const coordinator = new Coordinator(trackedStore, port, publisher ? { publisher } : {})
  let completed = 0
  for (let count = 0; count < 30; count++) {
    const outcome = await coordinator.runOnce({ projectId, agentId, workerId }, async ({ task, signal }) => {
      if (task.status !== 'in_progress' || task.version < 2) throw new Error('Handler must receive the admitted task version')
      if (mode === 'crash-after-start') await pause('execution-started')
      if (mode === 'recover-saved') throw new Error('Prepared output must be reused without invoking the handler')
      if (mode === 'agent-recover-saved') throw new Error('Recovery must not call the model again')
      if (model) {
        const output = await model.run({ task, signal })
        if (mode === 'agent-crash-after-model') await pause('model-returned')
        return output
      }
      await delay(80, undefined, { signal })
      return { title: `Result ${task.taskKey}`, content: `Synthetic result for ${task.id} from ${workerId}` }
    })
    if (outcome === 'idle') break
    if (outcome !== 'completed') {
      const inspected = currentJob ? await store.inspect(currentJob.projectId, currentJob.taskId) : null
      process.send?.({ phase: 'failed', code: inspected?.error_code ?? outcome })
      if (agentMode && inspected?.state === 'queued' && ['AGENT_HTTP_ERROR', 'AGENT_UNAVAILABLE', 'AGENT_TIMEOUT'].includes(String(inspected.error_code))) {
        // Match the watch CLI: a transient model failure can retry before output
        // is prepared. The durable max-attempt limit still bounds all retries.
        await delay(1_000)
        continue
      }
      throw new Error('Worker failed')
    }
    completed++
  }
  process.send?.({ phase: 'done', completed })
} catch { process.exitCode = 1 }
finally { await Promise.all([store.close(), core.close()]); process.disconnect?.() }
