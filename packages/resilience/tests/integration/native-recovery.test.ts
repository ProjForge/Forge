import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import test from 'node:test'
import { runBackupPolicy } from '../../src/policy.js'
import { restoreBackup, verifyBackup } from '../../src/restore.js'

const { Client } = pg
const adminUrl = process.env.FORGE_TEST_ADMIN_DATABASE_URL

function databaseUrl(base: string, database: string): string {
  const parsed = new URL(base)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

function roleUrl(base: string, database: string, role: string, password: string): string {
  const parsed = new URL(databaseUrl(base, database))
  parsed.username = role
  parsed.password = password
  return parsed.toString()
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]+$/.test(value)) throw new Error('Unsafe test database name')
  return `"${value}"`
}

async function applyMigrations(connectionString: string): Promise<void> {
  const migrationsDirectory = path.resolve(process.cwd(), '../schema/database/migrations')
  const names = (await readdir(migrationsDirectory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await client.query(`CREATE SCHEMA forge; CREATE TABLE forge.schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    for (const name of names) {
      const sql = await readFile(path.join(migrationsDirectory, name), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO forge.schema_migrations(name, checksum) VALUES ($1, $2)', [name, checksum])
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
    await client.query(
      `INSERT INTO forge.projects(project_key, name, metadata)
       VALUES ('resilience-proof', 'Resilience proof', '{"restorable":true}'::jsonb)`,
    )
  } finally {
    await client.end()
  }
}

test('backs up, authenticates and restores a native PostgreSQL database', { skip: !adminUrl }, async () => {
  if (!adminUrl) return
  const suffix = randomBytes(6).toString('hex')
  const sourceName = `forge_resilience_source_${suffix}`
  const targetName = `forge_resilience_target_${suffix}`
  const backupRole = `forge_backup_${suffix}`
  const backupPassword = randomBytes(32).toString('hex')
  const admin = new Client({ connectionString: adminUrl })
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forge-native-recovery-'))
  const passphrase = Buffer.from('native recovery proof passphrase')
  await admin.connect()
  try {
    await admin.query(`CREATE ROLE ${identifier(backupRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${backupPassword}'`)
    await admin.query(`CREATE DATABASE ${identifier(sourceName)}`)
    await admin.query(`CREATE DATABASE ${identifier(targetName)}`)
    const sourceUrl = databaseUrl(adminUrl, sourceName)
    const targetUrl = databaseUrl(adminUrl, targetName)
    await applyMigrations(sourceUrl)
    await admin.query(`REVOKE CONNECT ON DATABASE ${identifier(sourceName)} FROM PUBLIC`)
    await admin.query(`REVOKE CONNECT ON DATABASE ${identifier(targetName)} FROM PUBLIC`)
    await admin.query(`GRANT CONNECT ON DATABASE ${identifier(sourceName)} TO ${identifier(backupRole)}`)
    const sourceAdmin = new Client({ connectionString: sourceUrl })
    await sourceAdmin.connect()
    try {
      await sourceAdmin.query(`GRANT USAGE ON SCHEMA forge TO ${identifier(backupRole)}`)
      await sourceAdmin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA forge TO ${identifier(backupRole)}`)
      await sourceAdmin.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA forge TO ${identifier(backupRole)}`)
    } finally {
      await sourceAdmin.end()
    }
    const backupUrl = roleUrl(adminUrl, sourceName, backupRole, backupPassword)
    const reader = new Client({ connectionString: backupUrl })
    await reader.connect()
    try {
      await assert.rejects(
        reader.query(`INSERT INTO forge.projects(project_key, name) VALUES ('forbidden', 'Forbidden')`),
        (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501',
      )
    } finally {
      await reader.end()
    }
    const replicaDirectory = path.join(directory, 'replica')
    const policyRun = await runBackupPolicy({
      connectionString: backupUrl,
      passphrase,
      policy: {
        version: 1,
        outputDirectory: path.join(directory, 'primary'),
        replicas: [{ name: 'native-replica', path: replicaDirectory }],
        retention: { keepLast: 2, maxAgeHours: 24 },
        labelPrefix: 'native-proof',
      },
      ...(process.env.FORGE_POSTGRES_BIN ? { postgresBin: process.env.FORGE_POSTGRES_BIN } : {}),
    })
    const backup = policyRun.backup
    assert.equal(policyRun.replicas.length, 1)
    await verifyBackup({ manifestPath: backup.manifestPath, passphrase })
    await verifyBackup({ manifestPath: policyRun.replicas[0]!.manifestPath, passphrase })
    const blockedTarget = new Client({ connectionString: targetUrl })
    await blockedTarget.connect()
    try {
      await blockedTarget.query('CREATE TABLE public.restore_must_not_overwrite(id integer PRIMARY KEY)')
    } finally {
      await blockedTarget.end()
    }
    await assert.rejects(
      restoreBackup({
        connectionString: targetUrl,
        manifestPath: backup.manifestPath,
        passphrase,
        ...(process.env.FORGE_POSTGRES_BIN ? { postgresBin: process.env.FORGE_POSTGRES_BIN } : {}),
      }),
      /empty database/,
    )
    const cleanedTarget = new Client({ connectionString: targetUrl })
    await cleanedTarget.connect()
    try {
      const blocker = await cleanedTarget.query<{ name: string | null }>(
        "SELECT to_regclass('public.restore_must_not_overwrite')::text AS name",
      )
      assert.equal(blocker.rows[0]?.name, 'restore_must_not_overwrite')
      await cleanedTarget.query('DROP TABLE public.restore_must_not_overwrite')
    } finally {
      await cleanedTarget.end()
    }
    const restored = await restoreBackup({
      connectionString: targetUrl,
      manifestPath: backup.manifestPath,
      passphrase,
      ...(process.env.FORGE_POSTGRES_BIN ? { postgresBin: process.env.FORGE_POSTGRES_BIN } : {}),
    })
    assert.equal(restored.tableCounts.projects, '1')
    const target = new Client({ connectionString: targetUrl })
    await target.connect()
    try {
      const project = await target.query<{ project_key: string; restorable: boolean }>(
        `SELECT project_key, (metadata ->> 'restorable')::boolean AS restorable
           FROM forge.projects WHERE project_key = 'resilience-proof'`,
      )
      assert.deepEqual(project.rows, [{ project_key: 'resilience-proof', restorable: true }])
    } finally {
      await target.end()
    }
  } finally {
    passphrase.fill(0)
    try {
      for (const database of [sourceName, targetName]) {
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [database])
        await admin.query(`DROP DATABASE IF EXISTS ${identifier(database)}`)
      }
      await admin.query(`DROP ROLE IF EXISTS ${identifier(backupRole)}`)
    } finally {
      await admin.end().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  }
})
