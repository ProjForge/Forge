#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { ForgePersistenceGateway } from 'forge-persistence-gateway'
import { Coordinator } from './coordinator.js'
import { PostgresJobStore } from './store.js'
import { LocalReportAgent } from './local-agent.js'
import { ImmutableReportPublisher } from './report-publisher.js'

const coreUrl = process.env.FORGE_DATABASE_URL
const stateUrl = process.env.FORGE_COORDINATOR_DATABASE_URL
if (!coreUrl || !stateUrl) throw new Error('FORGE_DATABASE_URL and FORGE_COORDINATOR_DATABASE_URL are required')
const core = ForgePersistenceGateway.connect({ connectionString: coreUrl, maxConnections: 2 })
const store = new PostgresJobStore(stateUrl)
const stop = new AbortController()
process.once('SIGINT', () => stop.abort())
process.once('SIGTERM', () => stop.abort())
try {
  await core.assertReady()
  const mode = process.env.FORGE_COORDINATOR_AGENT_MODE ?? 'demo'
  if (!['demo', 'local-report'].includes(mode)) throw new Error('Unknown agent mode')
  const publisher = mode === 'local-report' ? new ImmutableReportPublisher(process.env.FORGE_COORDINATOR_REPORT_ROOT ?? '') : undefined
  const [command, projectKey, taskKey] = process.argv.slice(2)
  if (command === 'status' && projectKey && taskKey) {
    const project = await core.getProjectByKey(projectKey)
    const task = await core.getTaskByKey(project.id, taskKey)
    console.log(JSON.stringify({ job: await store.inspect(project.id, task.id) }))
  } else if (command === 'enqueue' && projectKey && taskKey) {
    const project = await core.getProjectByKey(projectKey)
    const task = await core.getTaskByKey(project.id, taskKey)
    if (!task.assignedAgentId || !['ready', 'in_progress'].includes(task.status)) throw new Error('Task must be ready/in progress and assigned')
    const queued = await store.enqueue({ projectId: project.id, taskId: task.id, taskKey: task.taskKey, agentId: task.assignedAgentId }, 3,
      { kind: publisher?.kind ?? 'none', targetId: publisher?.targetId ?? '' })
    console.log(JSON.stringify({ jobId: queued.id, state: queued.state }))
  } else if (command === 'worker') {
    const agentKey = process.env.FORGE_COORDINATOR_AGENT_KEY
    const scope = process.env.FORGE_COORDINATOR_PROJECT_KEY
    if (!agentKey || !scope) throw new Error('Coordinator agent and project keys are required')
    const project = await core.getProjectByKey(scope)
    const agent = await core.getAgentByKey(project.id, agentKey)
    const workerId = randomUUID()
    const coordinator = new Coordinator(store, core, publisher ? { publisher } : {})
    const reportAgent = mode === 'local-report' ? new LocalReportAgent({ baseUrl: process.env.FORGE_COORDINATOR_AGENT_BASE_URL ?? '', model: process.env.FORGE_COORDINATOR_AGENT_MODEL ?? '' }) : undefined
    // The default remains a side-effect-free demonstration; real work is opt-in.
    const once = !process.argv.includes('--watch')
    do {
      const state = await coordinator.runOnce({ projectId: project.id, agentId: agent.id, workerId }, reportAgent?.run ?? (async ({ task, signal }) => {
        signal.throwIfAborted()
        return { title: `Pilot: ${task.title}`, content: `Deterministic coordinator pilot completed task ${task.taskKey}. No external work was performed.` }
      }))
      console.log(JSON.stringify({ state }))
      if (state === 'failed') process.exitCode = 1
      if (once) break
      await delay(1_000, undefined, { signal: stop.signal }).catch(() => undefined)
    } while (!stop.signal.aborted)
  } else {
    console.error('Usage: enqueue <projectKey> <taskKey> | status <projectKey> <taskKey> | worker [--watch]')
    process.exitCode = 2
  }
} catch {
  // Connection strings and provider messages can carry credentials.
  console.error('COORDINATOR_FAILED: inspect task identity and isolated state/Core configuration')
  process.exitCode = 1
} finally { await Promise.all([store.close(), core.close()]) }
