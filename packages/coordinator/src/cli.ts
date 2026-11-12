#!/usr/bin/env node
import { setTimeout as delay } from 'node:timers/promises'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { ForgePersistenceGateway } from 'forge-persistence-gateway'
import { Coordinator, reconcileReport, validateArtifact } from './coordinator.js'
import { PostgresJobStore } from './store.js'
import { LocalReportAgent } from './local-agent.js'
import { ImmutableReportPublisher, RestoredReportVerifier, captureReportTarget } from './report-publisher.js'

const [command] = process.argv.slice(2)
// Capturing the pre-loss identity needs no database or provider configuration.
if (command === 'capture-report-target' && (process.argv.length === 3 || process.argv.length === 4)) {
  try {
    const json = JSON.stringify(captureReportTarget(process.env.FORGE_COORDINATOR_REPORT_ROOT ?? ''))
    if (process.argv[3]) await writeFile(process.argv[3], json + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    else console.log(json)
  } catch { console.error('REPORT_TARGET_CAPTURE_FAILED'); process.exitCode = 1 }
} else if (command === 'reconcile-report') {
  const [, projectId, jobId, extra] = process.argv.slice(2)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!projectId || !uuid.test(projectId) || !jobId || !uuid.test(jobId) || extra !== undefined) {
    console.error('Usage: reconcile-report <projectId UUID> <jobId UUID>'); process.exitCode = 2
  } else {
    const coreUrl = process.env.FORGE_DATABASE_URL
    const stateUrl = process.env.FORGE_COORDINATOR_DATABASE_URL
    if (!coreUrl || !stateUrl) { console.error('COORDINATOR_CONFIGURATION_REQUIRED'); process.exitCode = 1 }
    else {
      const core = ForgePersistenceGateway.connect({ connectionString: coreUrl, maxConnections: 2 })
      const store = new PostgresJobStore(stateUrl)
      try {
        const outcome = await reconcileReport(store, core, projectId, jobId, process.env.FORGE_COORDINATOR_REPORT_ROOT ?? '')
        console.log(JSON.stringify({ outcome }))
        if (outcome === 'not_found' || outcome === 'not_eligible') process.exitCode = 1
      } catch { console.error('COORDINATOR_RECONCILE_VERIFICATION_FAILED'); process.exitCode = 1 }
      finally { await Promise.all([store.close(), core.close()]) }
    }
  }
} else if (command === 'list-blocked') {
  const [, projectId, afterJobId, extra] = process.argv.slice(2)
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!projectId || !uuid.test(projectId) || (afterJobId !== undefined && !uuid.test(afterJobId)) || extra !== undefined) {
    console.error('Usage: list-blocked <projectId UUID> [afterJobId UUID]')
    process.exitCode = 2
  } else {
    const stateUrl = process.env.FORGE_COORDINATOR_DATABASE_URL
    if (!stateUrl) { console.error('FORGE_COORDINATOR_DATABASE_URL is required'); process.exitCode = 1 }
    else {
      const store = new PostgresJobStore(stateUrl)
      try { console.log(JSON.stringify(await store.listBlocked(projectId, afterJobId))) }
      catch { console.error('COORDINATOR_LIST_BLOCKED_FAILED'); process.exitCode = 1 }
      finally { await store.close() }
    }
  }
} else {
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
  const [, projectKey, taskKey] = process.argv.slice(2)
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
  } else if (command === 'recover-report' && projectKey && taskKey && process.argv.length === 6) {
    const project = await core.getProjectByKey(projectKey)
    const task = await core.getTaskByKey(project.id, taskKey)
    const proof = JSON.parse((await readFile(process.argv[5]!, 'utf8')).replace(/^\uFEFF/, ''))
    const verifier = new RestoredReportVerifier(process.env.FORGE_COORDINATOR_REPORT_ROOT ?? '', proof)
    const job = await store.recoveryCheckpoint(project.id, task.id)
    if (!job?.artifact || !job.effectReceipt) {
      console.error('RECOVERY_REQUIRES_PREPARED_OUTPUT_AND_RECEIPT')
      throw new Error('Missing recovery checkpoint')
    }
    if (!task.assignedAgentId || job.agentId !== task.assignedAgentId || job.effectTarget !== verifier.targetId) throw new Error('Recovery checkpoint mismatch')
    const receipt = job.effectReceipt
    // Verify before consuming an attempt, then reverify under the existing fence.
    await verifier.publish({ key: `coordinator:v1:${project.id}:${task.id}:report`, artifact: validateArtifact(job.artifact),
      expected: receipt, signal: stop.signal })
    const coordinator = new Coordinator(store, core, { publisher: verifier, recovery: { taskId: task.id, receipt } })
    const state = await coordinator.runOnce({ projectId: project.id, agentId: task.assignedAgentId, workerId: randomUUID() }, async () => { throw new Error('Recovery cannot run an agent') })
    console.log(JSON.stringify({ state }))
    if (state === 'failed' || state === 'lost') process.exitCode = 1
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
    console.error('Usage: enqueue <projectKey> <taskKey> | status <projectKey> <taskKey> | worker [--watch] | capture-report-target [proof-file] | recover-report <projectKey> <taskKey> <proof-file> | list-blocked <projectId UUID> [afterJobId UUID] | reconcile-report <projectId UUID> <jobId UUID>')
    process.exitCode = 2
  }
} catch {
  // Connection strings and provider messages can carry credentials.
  console.error('COORDINATOR_FAILED: inspect task identity and isolated state/Core configuration')
  process.exitCode = 1
} finally { await Promise.all([store.close(), core.close()]) }

}
