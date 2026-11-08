import pg, { type PoolClient } from 'pg'
import type { Artifact, Change, Claim, EffectKind, EffectPolicy, EffectReceipt, FailureCode, Job, JobStore, WorkerIdentity } from './types.js'
import { LeaseLostError } from './types.js'

function job(row: Record<string, unknown>): Job {
  return {
    id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id),
    taskKey: String(row.task_key), agentId: String(row.agent_id), state: row.state as Job['state'],
    owner: row.owner === null ? null : String(row.owner), epoch: Number(row.epoch),
    attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts), artifact: row.artifact as Artifact | null,
    effectKind: row.effect_kind as EffectKind, effectTarget: String(row.effect_target), effectReceipt: row.effect_receipt as EffectReceipt | null,
  }
}

export class PostgresJobStore implements JobStore {
  private readonly pool: pg.Pool
  constructor(connectionString: string, readonly leaseMs = 30_000) {
    if (!Number.isInteger(leaseMs) || leaseMs < 300 || leaseMs > 300_000) throw new RangeError('leaseMs must be 300..300000')
    this.pool = new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000, statement_timeout: 15_000, application_name: 'forge-coordinator-state' })
  }
  close(): Promise<void> { return this.pool.end() }

  async inspect(projectId: string, taskId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(`SELECT id,state,owner,epoch,attempts,max_attempts,lease_until,error_code,updated_at,effect_kind,effect_target,
      effect_receipt->>'filename' AS report_file,effect_receipt->>'sha256' AS report_sha256,
      CASE WHEN effect_kind='none' THEN 'not_requested' WHEN effect_receipt IS NULL THEN 'unconfirmed' ELSE 'confirmed' END AS effect_state
      FROM forge_coordinator.jobs WHERE project_id=$1 AND task_id=$2`, [projectId, taskId])
    return result.rows[0] ?? null
  }

  // Internal exact-task checkpoint; never exposed by the status projection.
  async recoveryCheckpoint(projectId: string, taskId: string): Promise<Job | null> {
    const result = await this.pool.query('SELECT * FROM forge_coordinator.jobs WHERE project_id=$1 AND task_id=$2', [projectId, taskId])
    return result.rows[0] ? job(result.rows[0]) : null
  }

  async enqueue(input: Pick<Job, 'projectId' | 'taskId' | 'taskKey' | 'agentId'>, maxAttempts = 3, effect: EffectPolicy = { kind: 'none', targetId: '' }): Promise<Job> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new RangeError('maxAttempts must be 1..20')
    if ((effect.kind === 'none' && effect.targetId !== '') || (effect.kind === 'immutable-report-v1' && !/^[a-f0-9]{64}$/.test(effect.targetId)) || !['none', 'immutable-report-v1'].includes(effect.kind)) throw new TypeError('Unknown effect policy or target')
    const inserted = await this.pool.query(`INSERT INTO forge_coordinator.jobs(project_id, task_id, task_key, agent_id, max_attempts,effect_kind,effect_target)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (project_id,task_id) DO NOTHING RETURNING *`,
    [input.projectId, input.taskId, input.taskKey, input.agentId, maxAttempts, effect.kind, effect.targetId])
    const resolved = inserted.rows[0] ?? (await this.pool.query('SELECT * FROM forge_coordinator.jobs WHERE project_id=$1 AND task_id=$2', [input.projectId, input.taskId])).rows[0]
    const result = job(resolved)
    if (result.taskKey !== input.taskKey || result.agentId !== input.agentId || result.maxAttempts !== maxAttempts || result.effectKind !== effect.kind || result.effectTarget !== effect.targetId) throw new Error('Coordinator job identity conflict')
    return result
  }

  async claim({ projectId, agentId, workerId }: WorkerIdentity, effect: EffectPolicy = { kind: 'none', targetId: '' }, recovery?: { taskId: string; receipt: EffectReceipt }): Promise<Claim | null> {
    if (recovery && (typeof recovery.taskId !== 'string' || !recovery.taskId.trim() || !recovery.receipt ||
        recovery.receipt.kind !== effect.kind || recovery.receipt.targetId !== effect.targetId)) throw new TypeError('Invalid exact recovery selector')
    if (!workerId.trim() || workerId.length > 200) throw new RangeError('workerId must be 1..200 characters')
    return this.transaction(async (client) => {
      if (!recovery) await client.query(`UPDATE forge_coordinator.jobs SET state='failed', owner=NULL, lease_until=NULL, error_code='ATTEMPTS_EXHAUSTED', updated_at=clock_timestamp()
        WHERE id IN (SELECT id FROM forge_coordinator.jobs WHERE agent_id=$1 AND project_id=$2 AND effect_kind=$3 AND effect_target=$4 AND attempts>=max_attempts
          AND (state='queued' OR (state='running' AND lease_until<=clock_timestamp())) FOR UPDATE SKIP LOCKED)`, [agentId, projectId, effect.kind, effect.targetId])
      const selected = await client.query(`SELECT id FROM forge_coordinator.jobs WHERE agent_id=$1 AND attempts<max_attempts
        AND (state='queued' OR (state='running' AND lease_until<=clock_timestamp()))
        AND project_id=$2 AND effect_kind=$3 AND effect_target=$4
        AND ($5::uuid IS NULL OR (task_id=$5 AND artifact IS NOT NULL AND effect_receipt=$6::jsonb))
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [agentId, projectId, effect.kind, effect.targetId, recovery?.taskId ?? null, recovery ? JSON.stringify(recovery.receipt) : null])
      if (!selected.rows[0]) return null
      const updated = await client.query(`UPDATE forge_coordinator.jobs SET state='running', owner=$2, epoch=epoch+1,
        attempts=attempts+1, lease_until=clock_timestamp()+$3::int*interval '1 millisecond', updated_at=clock_timestamp()
        WHERE id=$1 RETURNING *`, [selected.rows[0].id, workerId, this.leaseMs])
      const claimed = job(updated.rows[0])
      return { job: claimed, workerId, epoch: claimed.epoch }
    })
  }

  async heartbeat(claim: Claim): Promise<boolean> {
    const updated = await this.pool.query(`UPDATE forge_coordinator.jobs SET lease_until=clock_timestamp()+$4::int*interval '1 millisecond', updated_at=clock_timestamp()
      WHERE id=$1 AND owner=$2 AND epoch=$3 AND state='running' AND lease_until>clock_timestamp() RETURNING id`,
    [claim.job.id, claim.workerId, claim.epoch, this.leaseMs])
    return updated.rowCount === 1
  }

  async fenced<T>(claim: Claim, operation: (current: Job) => Promise<Change<T>>): Promise<T> {
    return this.transaction(async (client) => {
      // Claim/takeover and every publication serialize on this row. The lock is
      // held until the Core call returns, including uncertain-response failures.
      const selected = await client.query('SELECT * FROM forge_coordinator.jobs WHERE id=$1 FOR UPDATE', [claim.job.id])
      const row = selected.rows[0]
      if (!row || row.owner !== claim.workerId || Number(row.epoch) !== claim.epoch || row.state !== 'running') throw new LeaseLostError()
      // Evaluate time after acquiring the lock, never using a pre-wait snapshot.
      const valid = await client.query('SELECT lease_until>clock_timestamp() AS valid FROM forge_coordinator.jobs WHERE id=$1', [claim.job.id])
      if (!valid.rows[0]?.valid) throw new LeaseLostError()
      const change = await operation(job(row))
      if (change.artifact && row.artifact !== null &&
        (row.artifact.title !== change.artifact.title || row.artifact.content !== change.artifact.content)) throw new Error('Prepared artifact is immutable')
      if (change.effectReceipt && row.effect_receipt !== null) {
        const prior = row.effect_receipt as EffectReceipt
        if (prior.kind !== change.effectReceipt.kind || prior.key !== change.effectReceipt.key || prior.sha256 !== change.effectReceipt.sha256 || prior.filename !== change.effectReceipt.filename || prior.targetId !== change.effectReceipt.targetId) throw new Error('Effect receipt is immutable')
      }
      await client.query(`UPDATE forge_coordinator.jobs SET artifact=COALESCE($2::jsonb,artifact), state=$3,
        lease_until=CASE WHEN $3='completed' THEN NULL ELSE clock_timestamp()+$4::int*interval '1 millisecond' END,
        effect_receipt=COALESCE($5::jsonb,effect_receipt),error_code=NULL, updated_at=clock_timestamp() WHERE id=$1`,
      [claim.job.id, change.artifact === undefined ? null : JSON.stringify(change.artifact), change.completed ? 'completed' : 'running', this.leaseMs, change.effectReceipt === undefined ? null : JSON.stringify(change.effectReceipt)])
      return change.value
    })
  }

  async fail(claim: Claim, code: FailureCode = 'WORKER_FAILED'): Promise<void> {
    await this.pool.query(`UPDATE forge_coordinator.jobs SET state=CASE WHEN attempts>=max_attempts THEN 'failed' ELSE 'queued' END,
      owner=NULL, lease_until=NULL, error_code=$4, updated_at=clock_timestamp()
      WHERE id=$1 AND owner=$2 AND epoch=$3 AND state='running' AND lease_until>clock_timestamp()`, [claim.job.id, claim.workerId, claim.epoch, code])
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error }
    finally { client.release() }
  }
}
