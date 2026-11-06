import { setTimeout as delay } from 'node:timers/promises'
import { ForgePersistenceGateway } from 'forge-persistence-gateway'
import { Coordinator, PostgresJobStore } from '../src/index.js'
import type { CorePort } from '../src/index.js'

if (process.env.FORGE_COORDINATOR_TEST_ADMIN_URL || process.env.FORGE_ADMIN_DATABASE_URL || process.env.FORGE_RUNTIME_PASSWORD) {
  throw new Error('Worker fixture must not inherit provisioning credentials')
}

const [projectId, agentId, workerId, mode = 'normal'] = process.argv.slice(2) as [string, string, string, string?]
const core = ForgePersistenceGateway.connect({ connectionString: process.env.FORGE_DATABASE_URL!, maxConnections: 2 })
const store = new PostgresJobStore(process.env.FORGE_COORDINATOR_DATABASE_URL!, 3_000)
const pause = async (phase: string): Promise<never> => {
  process.send?.({ phase })
  return new Promise(() => {})
}
const port: CorePort = new Proxy(core, {
  get(target, property) {
    const value: unknown = Reflect.get(target, property)
    if (typeof value !== 'function') return value
    return async (...args: unknown[]) => {
      const result: unknown = await Reflect.apply(value, target, args)
      if (mode === 'crash-after-memory' && property === 'remember') await pause('memory-written')
      if (mode === 'crash-after-finish' && property === 'finishExecution') await pause('execution-finished')
      return result
    }
  },
})
try {
  const coordinator = new Coordinator(store, port)
  let completed = 0
  for (let count = 0; count < 30; count++) {
    const outcome = await coordinator.runOnce({ projectId, agentId, workerId }, async ({ task, signal }) => {
      if (task.status !== 'in_progress' || task.version < 2) throw new Error('Handler must receive the admitted task version')
      if (mode === 'crash-after-start') await pause('execution-started')
      if (mode === 'recover-saved') throw new Error('Prepared output must be reused without invoking the handler')
      await delay(80, undefined, { signal })
      return { title: `Result ${task.taskKey}`, content: `Synthetic result for ${task.id} from ${workerId}` }
    })
    if (outcome === 'idle') break
    if (outcome !== 'completed') throw new Error('Worker failed')
    completed++
  }
  process.send?.({ phase: 'done', completed })
} catch { process.exitCode = 1 }
finally { await Promise.all([store.close(), core.close()]); process.disconnect?.() }
