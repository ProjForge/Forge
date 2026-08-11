import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceDir = path.dirname(fileURLToPath(import.meta.url))
export const defaultMigrationsDir = path.resolve(sourceDir, '../database/migrations')

function checksum(sql) {
  return createHash('sha256').update(sql).digest('hex')
}

export async function discoverMigrations(migrationsDir = defaultMigrationsDir) {
  const names = (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()

  return Promise.all(names.map(async (name) => {
    const sql = await readFile(path.join(migrationsDir, name), 'utf8')
    return { name, sql, checksum: checksum(sql) }
  }))
}

export async function applyMigrations(db, { upTo, migrationsDir = defaultMigrationsDir } = {}) {
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS forge;
    CREATE TABLE IF NOT EXISTS forge.schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `)

  const discovered = await discoverMigrations(migrationsDir)
  const selected = upTo ? discovered.slice(0, upTo) : discovered
  const existing = await db.query('SELECT name, checksum FROM forge.schema_migrations')
  const appliedByName = new Map(existing.rows.map((row) => [row.name, row.checksum]))
  const result = { applied: [], skipped: [] }

  for (const migration of selected) {
    const recordedChecksum = appliedByName.get(migration.name)
    if (recordedChecksum) {
      if (recordedChecksum !== migration.checksum) {
        throw new Error(`Migration checksum mismatch: ${migration.name}`)
      }
      result.skipped.push(migration.name)
      continue
    }

    await db.exec('BEGIN')
    try {
      await db.exec(migration.sql)
      await db.query(
        'INSERT INTO forge.schema_migrations(name, checksum) VALUES ($1, $2)',
        [migration.name, migration.checksum],
      )
      await db.exec('COMMIT')
      result.applied.push(migration.name)
    } catch (error) {
      await db.exec('ROLLBACK')
      throw new Error(`Migration failed: ${migration.name}`, { cause: error })
    }
  }

  return result
}
