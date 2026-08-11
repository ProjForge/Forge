import type { PoolClient } from 'pg'
import { ConflictError, IdempotencyConflictError } from '../domain/errors.js'
import { canonicalize, hashJson, type JsonValue } from '../domain/json.js'

interface IdempotencyRow {
  request_hash: string
  status: 'in_progress' | 'completed' | 'failed'
  response: JsonValue | null
}

export async function runIdempotent<T>(
  client: PoolClient,
  options: {
    projectId: string
    scope: string
    key: string
    request: unknown
  },
  operation: () => Promise<T>,
): Promise<T> {
  const requestHash = hashJson(options.request)
  const claim = await client.query<IdempotencyRow>(
    `INSERT INTO forge.idempotency_keys(
       project_id, scope, idempotency_key, request_hash
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, scope, idempotency_key) DO NOTHING
     RETURNING request_hash, status, response`,
    [options.projectId, options.scope, options.key, requestHash],
  )

  if (claim.rowCount === 0) {
    const existing = await client.query<IdempotencyRow>(
      `SELECT request_hash, status, response
         FROM forge.idempotency_keys
        WHERE project_id = $1 AND scope = $2 AND idempotency_key = $3
        FOR UPDATE`,
      [options.projectId, options.scope, options.key],
    )
    const row = existing.rows[0]
    if (!row) throw new ConflictError('Idempotency claim disappeared during transaction')
    if (row.request_hash !== requestHash) {
      throw new IdempotencyConflictError(options.scope, options.key)
    }
    if (row.status !== 'completed' || row.response === null) {
      throw new ConflictError(`Idempotent operation is not replayable in state ${row.status}`)
    }
    return row.response as T
  }

  const result = await operation()
  const response = canonicalize(result)
  await client.query(
    `UPDATE forge.idempotency_keys
        SET status = 'completed', response = $4::jsonb
      WHERE project_id = $1 AND scope = $2 AND idempotency_key = $3`,
    [options.projectId, options.scope, options.key, JSON.stringify(response)],
  )
  return result
}
