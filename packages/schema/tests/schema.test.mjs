import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openEmbeddedDatabase, openServerDatabase } from '../src/database.mjs'
import { applyMigrations } from '../src/migrations.mjs'

const mode = process.argv[2] ?? '--embedded'
const connectionString = process.env.FORGE_TEST_DATABASE_URL
const restartMarker = 'forge-schema-0-1-1-restart-marker'
const results = []

function errorText(error) {
  const messages = []
  const sqlStateLabels = {
    '23503': 'foreign key constraint violation',
    '23505': 'unique constraint violation',
    '23514': 'check constraint violation',
  }
  for (let current = error; current; current = current.cause) {
    if (current.message) messages.push(current.message)
    if (current.code) {
      messages.push(`SQLSTATE ${current.code}`)
      if (sqlStateLabels[current.code]) messages.push(sqlStateLabels[current.code])
    }
    if (current.constraint) messages.push(`constraint ${current.constraint}`)
  }
  return messages.join(' | ')
}

async function expectReject(label, operation, expectedPattern) {
  try {
    await operation()
    assert.fail(`${label}: statement unexpectedly succeeded`)
  } catch (error) {
    if (error.code === 'ERR_ASSERTION') throw error
    if (expectedPattern) {
      assert.match(errorText(error), expectedPattern, `${label}: unexpected database error`)
    }
  }
}

async function check(name, operation) {
  await operation()
  results.push(name)
  process.stdout.write(`PASS ${name}\n`)
}

async function insertProject(db, label) {
  const suffix = randomUUID()
  const project = await db.query(
    `INSERT INTO forge.projects(project_key, name)
     VALUES ($1, $2)
     RETURNING id, version`,
    [`project-${label}-${suffix}`, `Project ${label}`],
  )
  return project.rows[0]
}

async function insertAgent(db, projectId, label) {
  const suffix = randomUUID()
  const agent = await db.query(
    `INSERT INTO forge.agents(agent_key, name)
     VALUES ($1, $2)
     RETURNING id`,
    [`agent-${label}-${suffix}`, `Agent ${label}`],
  )
  await db.query(
    'INSERT INTO forge.project_agents(project_id, agent_id) VALUES ($1, $2)',
    [projectId, agent.rows[0].id],
  )
  return agent.rows[0]
}

async function insertContract(db, projectId, label) {
  const result = await db.query(
    `INSERT INTO forge.context_contracts(project_id, contract_key, name)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [projectId, `contract-${label}-${randomUUID()}`, `Contract ${label}`],
  )
  return result.rows[0]
}

async function insertExecution(db, projectId, agentId, contractId, label) {
  const result = await db.query(
    `INSERT INTO forge.executions(
       project_id, agent_id, context_contract_id, execution_key, status
     ) VALUES ($1, $2, $3, $4, 'running')
     RETURNING id`,
    [projectId, agentId, contractId, `execution-${label}-${randomUUID()}`],
  )
  return result.rows[0]
}

async function verifyRuntime(db) {
  const version = await db.query('SHOW server_version')
  const serverVersion = String(version.rows[0].server_version)
  const major = Number.parseInt(serverVersion, 10)
  assert.ok(major >= 14, `PostgreSQL 14+ required, got ${serverVersion}`)

  const extension = await db.query(
    "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
  )
  assert.equal(extension.rows.length, 1, 'pgvector extension is not installed')
  return { serverVersion, vectorVersion: extension.rows[0].extversion }
}

async function verifyPrePatchConflictConstraint(db) {
  const project = await insertProject(db, 'pre-patch-conflict')
  const forgeId = randomUUID()
  const first = await db.query(
    `INSERT INTO forge.documents(project_id, forge_id, management_state, title)
     VALUES ($1, $2, 'conflict', 'Pre-patch conflict')
     RETURNING id`,
    [project.id, forgeId],
  )
  await expectReject(
    '0.1 duplicate conflict baseline',
    () => db.query(
      `INSERT INTO forge.documents(project_id, forge_id, management_state, title)
       VALUES ($1, $2, 'conflict', 'Pre-patch duplicate')`,
      [project.id, forgeId],
    ),
    /documents_forge_id_key|duplicate key|unique constraint/i,
  )
  await db.query('DELETE FROM forge.documents WHERE id = $1', [first.rows[0].id])

  const vectorProject = await insertProject(db, 'pre-patch-vector')
  const memory = await db.query(
    `INSERT INTO forge.memories(project_id, memory_type, content)
     VALUES ($1, 'semantic', 'Legacy embedding before source_version')
     RETURNING id`,
    [vectorProject.id],
  )
  const profile = await db.query(
    `INSERT INTO forge.embedding_profiles(profile_key, provider, model, dimensions)
     VALUES ($1, 'test-provider', 'legacy-model', 3) RETURNING id`,
    [`profile-legacy-${randomUUID()}`],
  )
  await db.query(
    `INSERT INTO forge.embeddings(project_id, profile_id, memory_id, embedding, metadata)
     VALUES ($1, $2, $3, '[1,0,0]'::vector, '{"migration_test":"legacy"}'::jsonb)`,
    [vectorProject.id, profile.rows[0].id, memory.rows[0].id],
  )
}

async function runInvariantTests(db) {
  await check('migration upgrade path and runner idempotency', async () => {
    const rerun = await applyMigrations(db)
    assert.deepEqual(rerun.applied, [])
    assert.equal(rerun.skipped.length, 7)
    const count = await db.query('SELECT count(*)::integer AS count FROM forge.schema_migrations')
    assert.equal(count.rows[0].count, 7)
    const backfilled = await db.query(
      `SELECT source_version
         FROM forge.embeddings
        WHERE metadata ->> 'migration_test' = 'legacy'`,
    )
    assert.equal(backfilled.rows.length, 1)
    assert.equal(Number(backfilled.rows[0].source_version), 1)
  })

  await check('managed forge_id immutability and conflict representation', async () => {
    const project = await insertProject(db, 'documents')
    const duplicateForgeId = randomUUID()

    await db.query(
      `INSERT INTO forge.documents(project_id, forge_id, management_state, title)
       VALUES ($1, $2, 'conflict', 'Conflict A'),
              ($1, $2, 'conflict', 'Conflict B')`,
      [project.id, duplicateForgeId],
    )

    const conflicts = await db.query(
      `SELECT count(*)::integer AS count
         FROM forge.documents
        WHERE forge_id = $1 AND management_state = 'conflict'`,
      [duplicateForgeId],
    )
    assert.equal(conflicts.rows[0].count, 2)

    const managedForgeId = randomUUID()
    const managed = await db.query(
      `INSERT INTO forge.documents(project_id, forge_id, management_state, title)
       VALUES ($1, $2, 'managed', 'Canonical')
       RETURNING id`,
      [project.id, managedForgeId],
    )

    await expectReject(
      'managed forge_id update',
      () => db.query('UPDATE forge.documents SET forge_id = $1 WHERE id = $2', [randomUUID(), managed.rows[0].id]),
      /immutable for managed documents/i,
    )

    await expectReject(
      'duplicate managed forge_id',
      () => db.query(
        `INSERT INTO forge.documents(project_id, forge_id, management_state, title)
         VALUES ($1, $2, 'managed', 'Duplicate canonical')`,
        [project.id, managedForgeId],
      ),
      /uq_documents_managed_forge_id|duplicate key|unique constraint/i,
    )

    await expectReject(
      'managed document without forge_id',
      () => db.query(
        `INSERT INTO forge.documents(project_id, management_state, title)
         VALUES ($1, 'managed', 'Missing identity')`,
        [project.id],
      ),
      /check constraint|violates check/i,
    )
  })

  await check('cross-project relational integrity', async () => {
    const projectA = await insertProject(db, 'boundary-a')
    const projectB = await insertProject(db, 'boundary-b')
    const agentA = await insertAgent(db, projectA.id, 'boundary-a')
    const contractA = await insertContract(db, projectA.id, 'boundary-a')
    const executionA = await insertExecution(db, projectA.id, agentA.id, contractA.id, 'boundary-a')

    await expectReject(
      'context package crossing project boundary',
      () => db.query(
        `INSERT INTO forge.context_packages(project_id, execution_id, package_hash)
         VALUES ($1, $2, $3)`,
        [projectB.id, executionA.id, randomUUID()],
      ),
      /foreign key constraint/i,
    )

    await expectReject(
      'event execution crossing project boundary',
      () => db.query(
        `INSERT INTO forge.events(project_id, execution_id, event_type)
         VALUES ($1, $2, 'cross_project')`,
        [projectB.id, executionA.id],
      ),
      /foreign key constraint/i,
    )

    await expectReject(
      'event agent crossing project boundary',
      () => db.query(
        `INSERT INTO forge.events(project_id, agent_id, event_type)
         VALUES ($1, $2, 'cross_project')`,
        [projectB.id, agentA.id],
      ),
      /foreign key constraint/i,
    )

    await expectReject(
      'audit execution crossing project boundary',
      () => db.query(
        `INSERT INTO forge.audit_log(project_id, execution_id, action, authorization_decision)
         VALUES ($1, $2, 'cross_project', 'denied')`,
        [projectB.id, executionA.id],
      ),
      /foreign key constraint/i,
    )

    const packageA = await db.query(
      `INSERT INTO forge.context_packages(project_id, execution_id, package_hash)
       VALUES ($1, $2, $3) RETURNING id`,
      [projectA.id, executionA.id, randomUUID()],
    )

    await expectReject(
      'context package item crossing project boundary',
      () => db.query(
        `INSERT INTO forge.context_package_items(
           context_package_id, project_id, position, source_kind, source_ref, content_hash
         ) VALUES ($1, $2, 0, 'memory', 'memory-x', 'hash-x')`,
        [packageA.rows[0].id, projectB.id],
      ),
      /foreign key constraint/i,
    )
  })

  await check('embedding dimensions and profile stability', async () => {
    const project = await insertProject(db, 'vectors')
    const memory = await db.query(
      `INSERT INTO forge.memories(project_id, memory_type, content)
       VALUES ($1, 'semantic', 'Vector test memory') RETURNING id, version`,
      [project.id],
    )
    const profile = await db.query(
      `INSERT INTO forge.embedding_profiles(profile_key, provider, model, dimensions)
       VALUES ($1, 'test-provider', 'test-model', 3) RETURNING id`,
      [`profile-${randomUUID()}`],
    )

    await expectReject(
      'embedding dimension mismatch',
      () => db.query(
        `INSERT INTO forge.embeddings(
           project_id, profile_id, memory_id, source_version, embedding
         ) VALUES ($1, $2, $3, $4, $5::vector)`,
        [project.id, profile.rows[0].id, memory.rows[0].id, memory.rows[0].version, '[1,2]'],
      ),
      /dimension mismatch: expected 3, got 2/i,
    )

    await db.query(
      `INSERT INTO forge.embeddings(
         project_id, profile_id, memory_id, source_version, embedding
       ) VALUES ($1, $2, $3, $4, $5::vector)`,
      [project.id, profile.rows[0].id, memory.rows[0].id, memory.rows[0].version, '[1,2,3]'],
    )

    await expectReject(
      'profile dimension update with embeddings',
      () => db.query(
        'UPDATE forge.embedding_profiles SET dimensions = 2 WHERE id = $1',
        [profile.rows[0].id],
      ),
      /cannot change dimensions/i,
    )

    const unused = await db.query(
      `INSERT INTO forge.embedding_profiles(profile_key, provider, model, dimensions)
       VALUES ($1, 'test-provider', 'unused-model', 2) RETURNING id`,
      [`profile-unused-${randomUUID()}`],
    )
    const changed = await db.query(
      'UPDATE forge.embedding_profiles SET dimensions = 4 WHERE id = $1 RETURNING dimensions',
      [unused.rows[0].id],
    )
    assert.equal(changed.rows[0].dimensions, 4)
  })

  await check('versioned embedding history and append-only enforcement', async () => {
    const project = await insertProject(db, 'embedding-history')
    const memory = await db.query(
      `INSERT INTO forge.memories(project_id, memory_type, content)
       VALUES ($1, 'semantic', 'Embedding source v1')
       RETURNING id, version`,
      [project.id],
    )
    const profile = await db.query(
      `INSERT INTO forge.embedding_profiles(profile_key, provider, model, dimensions)
       VALUES ($1, 'test-provider', 'history-model', 3) RETURNING id`,
      [`profile-history-${randomUUID()}`],
    )
    const firstEmbedding = await db.query(
      `INSERT INTO forge.embeddings(
         project_id, profile_id, memory_id, source_version, embedding
       ) VALUES ($1, $2, $3, $4, '[1,0,0]'::vector)
       RETURNING id`,
      [project.id, profile.rows[0].id, memory.rows[0].id, memory.rows[0].version],
    )

    await expectReject(
      'future source version',
      () => db.query(
        `INSERT INTO forge.embeddings(
           project_id, profile_id, memory_id, source_version, embedding
         ) VALUES ($1, $2, $3, 2, '[0,1,0]'::vector)`,
        [project.id, profile.rows[0].id, memory.rows[0].id],
      ),
      /source version mismatch: expected 1, got 2/i,
    )

    const updatedMemory = await db.query(
      `UPDATE forge.memories SET content = 'Embedding source v2'
        WHERE id = $1 RETURNING version`,
      [memory.rows[0].id],
    )
    assert.equal(Number(updatedMemory.rows[0].version), 2)

    await db.query(
      `INSERT INTO forge.embeddings(
         project_id, profile_id, memory_id, source_version, embedding
       ) VALUES ($1, $2, $3, $4, '[0,1,0]'::vector)`,
      [project.id, profile.rows[0].id, memory.rows[0].id, updatedMemory.rows[0].version],
    )
    const history = await db.query(
      `SELECT source_version
         FROM forge.embeddings
        WHERE profile_id = $1 AND memory_id = $2
        ORDER BY source_version`,
      [profile.rows[0].id, memory.rows[0].id],
    )
    assert.deepEqual(history.rows.map((row) => Number(row.source_version)), [1, 2])

    await expectReject(
      'duplicate embedding source version',
      () => db.query(
        `INSERT INTO forge.embeddings(
           project_id, profile_id, memory_id, source_version, embedding
         ) VALUES ($1, $2, $3, $4, '[0,0,1]'::vector)`,
        [project.id, profile.rows[0].id, memory.rows[0].id, updatedMemory.rows[0].version],
      ),
      /uq_embeddings_profile_memory|duplicate key|unique constraint/i,
    )
    await expectReject(
      'embedding update',
      () => db.query(
        `UPDATE forge.embeddings SET metadata = '{"forbidden":true}'::jsonb WHERE id = $1`,
        [firstEmbedding.rows[0].id],
      ),
      /embeddings is append-only/i,
    )
    await expectReject(
      'embedding delete',
      () => db.query('DELETE FROM forge.embeddings WHERE id = $1', [firstEmbedding.rows[0].id]),
      /embeddings is append-only/i,
    )
  })

  await check('optimistic locking version token', async () => {
    const project = await insertProject(db, 'optimistic-lock')
    assert.equal(Number(project.version), 1)

    const firstWriter = await db.query(
      `UPDATE forge.projects
          SET description = 'writer one'
        WHERE id = $1 AND version = 1
        RETURNING version`,
      [project.id],
    )
    assert.equal(firstWriter.rowCount, 1)
    assert.equal(Number(firstWriter.rows[0].version), 2)

    const staleWriter = await db.query(
      `UPDATE forge.projects
          SET description = 'stale writer'
        WHERE id = $1 AND version = 1
        RETURNING version`,
      [project.id],
    )
    assert.equal(staleWriter.rowCount, 0)

    const current = await db.query('SELECT description, version FROM forge.projects WHERE id = $1', [project.id])
    assert.equal(current.rows[0].description, 'writer one')
    assert.equal(Number(current.rows[0].version), 2)
  })

  await check('append-only context packages, events and audit log', async () => {
    const project = await insertProject(db, 'append-only')
    const agent = await insertAgent(db, project.id, 'append-only')
    const contract = await insertContract(db, project.id, 'append-only')
    const execution = await insertExecution(db, project.id, agent.id, contract.id, 'append-only')
    const contextPackage = await db.query(
      `INSERT INTO forge.context_packages(project_id, execution_id, context_contract_id, package_hash)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [project.id, execution.id, contract.id, randomUUID()],
    )
    const event = await db.query(
      `INSERT INTO forge.events(project_id, execution_id, agent_id, event_type)
       VALUES ($1, $2, $3, 'validation') RETURNING id`,
      [project.id, execution.id, agent.id],
    )
    const audit = await db.query(
      `INSERT INTO forge.audit_log(
         project_id, execution_id, context_package_id, agent_id, action, authorization_decision
       ) VALUES ($1, $2, $3, $4, 'validate', 'allowed') RETURNING id`,
      [project.id, execution.id, contextPackage.rows[0].id, agent.id],
    )

    for (const [table, id] of [
      ['context_packages', contextPackage.rows[0].id],
      ['events', event.rows[0].id],
      ['audit_log', audit.rows[0].id],
    ]) {
      await expectReject(
        `${table} update`,
        () => db.query(`UPDATE forge.${table} SET id = id WHERE id = $1`, [id]),
        /append-only/i,
      )
      await expectReject(
        `${table} delete`,
        () => db.query(`DELETE FROM forge.${table} WHERE id = $1`, [id]),
        /append-only/i,
      )
    }
  })

  await check('business idempotency keys', async () => {
    const project = await insertProject(db, 'idempotency')
    const key = `request-${randomUUID()}`
    await db.query(
      `INSERT INTO forge.idempotency_keys(project_id, scope, idempotency_key, request_hash)
       VALUES ($1, 'memory.write', $2, 'sha256:first')`,
      [project.id, key],
    )
    await expectReject(
      'duplicate idempotency key',
      () => db.query(
        `INSERT INTO forge.idempotency_keys(project_id, scope, idempotency_key, request_hash)
         VALUES ($1, 'memory.write', $2, 'sha256:second')`,
        [project.id, key],
      ),
      /duplicate key|unique constraint/i,
    )

    const eventKey = `event-${randomUUID()}`
    await db.query(
      `INSERT INTO forge.events(project_id, event_type, idempotency_key)
       VALUES ($1, 'idempotent', $2)`,
      [project.id, eventKey],
    )
    await expectReject(
      'duplicate event idempotency key',
      () => db.query(
        `INSERT INTO forge.events(project_id, event_type, idempotency_key)
         VALUES ($1, 'idempotent-retry', $2)`,
        [project.id, eventKey],
      ),
      /duplicate key|unique constraint/i,
    )
  })
}

async function runServerConcurrencyTest(db) {
  const project = await insertProject(db, 'vector-concurrency')
  const memory = await db.query(
    `INSERT INTO forge.memories(project_id, memory_type, content)
     VALUES ($1, 'semantic', 'Concurrent vector memory') RETURNING id, version`,
    [project.id],
  )
  const profile = await db.query(
    `INSERT INTO forge.embedding_profiles(profile_key, provider, model, dimensions)
     VALUES ($1, 'test-provider', 'concurrent-model', 3) RETURNING id`,
    [`profile-concurrent-${randomUUID()}`],
  )

  const inserter = await openServerDatabase(connectionString)
  const updater = await openServerDatabase(connectionString)
  try {
    await inserter.exec('BEGIN')
    await inserter.query(
      `INSERT INTO forge.embeddings(
         project_id, profile_id, memory_id, source_version, embedding
       ) VALUES ($1, $2, $3, $4, $5::vector)`,
      [project.id, profile.rows[0].id, memory.rows[0].id, memory.rows[0].version, '[1,2,3]'],
    )

    let updateSettled = false
    const updateAttempt = updater.query(
      'UPDATE forge.embedding_profiles SET dimensions = 2 WHERE id = $1',
      [profile.rows[0].id],
    ).then(
      () => ({ error: undefined }),
      (error) => ({ error }),
    ).finally(() => {
      updateSettled = true
    })

    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(updateSettled, false, 'profile update did not wait for embedding validation lock')
    await inserter.exec('COMMIT')

    const outcome = await updateAttempt
    assert.ok(outcome.error, 'concurrent dimension update unexpectedly succeeded')
    assert.match(errorText(outcome.error), /cannot change dimensions/i)
  } catch (error) {
    await inserter.exec('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    await inserter.close()
    await updater.close()
  }
}

async function insertRestartMarker(db) {
  await db.query(
    `INSERT INTO forge.projects(project_key, name)
     VALUES ($1, 'Persistence marker')
     ON CONFLICT (project_key) DO NOTHING`,
    [restartMarker],
  )
}

async function verifyRestartMarker(db) {
  const marker = await db.query(
    'SELECT count(*)::integer AS count FROM forge.projects WHERE project_key = $1',
    [restartMarker],
  )
  assert.equal(marker.rows[0].count, 1, 'persistence marker was lost across restart')
  const rerun = await applyMigrations(db)
  assert.equal(rerun.applied.length, 0)
  assert.equal(rerun.skipped.length, 7)
}

async function runCoreIsolationTest() {
  const coreDataDir = await mkdtemp(path.join(os.tmpdir(), 'forge-core-'))
  let db
  try {
    db = await openEmbeddedDatabase(coreDataDir)
    const applied = await applyMigrations(db, { upTo: 1 })
    assert.deepEqual(applied.applied, ['0001_forge_core.sql'])
    const extension = await db.query(
      "SELECT count(*)::integer AS count FROM pg_extension WHERE extname = 'vector'",
    )
    assert.equal(extension.rows[0].count, 0)
    await insertProject(db, 'core-without-vector')
  } finally {
    if (db) await db.close()
    await rm(coreDataDir, { recursive: true, force: true })
  }
}

async function runEmbedded() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'forge-schema-'))
  let db
  try {
    await check('relational core installs without pgvector', runCoreIsolationTest)
    db = await openEmbeddedDatabase(dataDir)
    const base = await applyMigrations(db, { upTo: 4 })
    assert.equal(base.applied.length, 4)
    await verifyPrePatchConflictConstraint(db)
    const patch = await applyMigrations(db)
    assert.deepEqual(patch.applied, [
      '0005_forge_schema_0_1_1.sql',
      '0006_forge_schema_0_1_2.sql',
      '0007_forge_schema_0_1_3.sql',
    ])
    const runtime = await verifyRuntime(db)
    await runInvariantTests(db)
    await insertRestartMarker(db)
    await db.close()
    db = undefined

    db = await openEmbeddedDatabase(dataDir)
    await check('persistence after embedded PostgreSQL restart', () => verifyRestartMarker(db))
    await db.close()
    db = undefined

    process.stdout.write(`${JSON.stringify({ runtime, passed: results.length, tests: results }, null, 2)}\n`)
  } finally {
    if (db) await db.close()
    await rm(dataDir, { recursive: true, force: true })
  }
}

async function runServerBeforeRestart() {
  assert.ok(connectionString, 'FORGE_TEST_DATABASE_URL is required')
  const db = await openServerDatabase(connectionString)
  try {
    if (process.env.FORGE_TEST_RESET === '1') {
      await db.exec('DROP SCHEMA IF EXISTS forge CASCADE')
    }
    const base = await applyMigrations(db, { upTo: 4 })
    assert.equal(base.applied.length, 4)
    await verifyPrePatchConflictConstraint(db)
    const patch = await applyMigrations(db)
    assert.ok(patch.applied.every((name) => [
      '0005_forge_schema_0_1_1.sql',
      '0006_forge_schema_0_1_2.sql',
      '0007_forge_schema_0_1_3.sql',
    ].includes(name)))
    assert.equal(patch.applied.at(-1), '0007_forge_schema_0_1_3.sql')
    const runtime = await verifyRuntime(db)
    await runInvariantTests(db)
    await check('embedding dimension concurrency serialization', () => runServerConcurrencyTest(db))
    await insertRestartMarker(db)
    process.stdout.write(`${JSON.stringify({ runtime, passed: results.length, restart: 'pending' }, null, 2)}\n`)
  } finally {
    await db.close()
  }
}

async function runServerAfterRestart() {
  assert.ok(connectionString, 'FORGE_TEST_DATABASE_URL is required')
  const db = await openServerDatabase(connectionString)
  try {
    const runtime = await verifyRuntime(db)
    await check('persistence after PostgreSQL server restart', () => verifyRestartMarker(db))
    process.stdout.write(`${JSON.stringify({ runtime, passed: results.length, restart: 'verified' }, null, 2)}\n`)
  } finally {
    await db.close()
  }
}

if (mode === '--server-before-restart') {
  await runServerBeforeRestart()
} else if (mode === '--server-after-restart') {
  await runServerAfterRestart()
} else {
  await runEmbedded()
}
