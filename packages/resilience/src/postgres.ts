import pg, { type Client } from 'pg'
import type { BackupSourceMetadata, MigrationRecord } from './types.js'

const { Client: PgClient } = pg

function schemaVersion(migrations: readonly MigrationRecord[]): string {
  const names = new Set(migrations.map((migration) => migration.name))
  if (names.has('0007_forge_schema_0_1_3.sql')) return '0.1.3'
  if (names.has('0006_forge_schema_0_1_2.sql')) return '0.1.2'
  if (names.has('0005_forge_schema_0_1_1.sql')) return '0.1.1'
  throw new Error('FORGE schema 0.1.1 or newer is not installed')
}

function quoteIdentifier(value: string): string {
  if (!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(value)) throw new Error(`Unsafe PostgreSQL identifier: ${value}`)
  return `"${value.replaceAll('"', '""')}"`
}

export async function connectDatabase(connectionString: string): Promise<Client> {
  const client = new PgClient({ connectionString })
  await client.connect()
  return client
}

export async function forgeTableCounts(client: Client): Promise<Record<string, string>> {
  const tables = await client.query<{ table_name: string }>(
    `SELECT relation.relname AS table_name
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'forge'
        AND relation.relkind IN ('r', 'p')
      ORDER BY relation.relname`,
  )
  const counts: Record<string, string> = {}
  for (const row of tables.rows) {
    const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM forge.${quoteIdentifier(row.table_name)}`)
    const count = result.rows[0]?.count
    if (count === undefined) throw new Error(`Could not count forge.${row.table_name}`)
    counts[row.table_name] = count
  }
  return counts
}

export async function assertBackupReadable(client: Client): Promise<void> {
  const missing = await client.query<{ name: string }>(
    `SELECT relation.relname AS name
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'forge'
        AND (
          (relation.relkind IN ('r', 'p') AND NOT has_table_privilege(current_user, relation.oid, 'SELECT'))
          OR (relation.relkind = 'S' AND NOT has_sequence_privilege(current_user, relation.oid, 'SELECT'))
        )
      ORDER BY relation.relname`,
  )
  if (missing.rows.length > 0) {
    throw new Error(`Backup role lacks SELECT on FORGE relations: ${missing.rows.map((row) => row.name).join(', ')}`)
  }
}

export async function sourceMetadata(client: Client): Promise<BackupSourceMetadata> {
  await assertBackupReadable(client)
  const migrations = await client.query<MigrationRecord>(
    'SELECT name, checksum FROM forge.schema_migrations ORDER BY name',
  )
  const runtime = await client.query<{
    database_name: string
    server_version: string
    server_version_num: string
    vector_version: string | null
  }>(
    `SELECT current_database() AS database_name,
            current_setting('server_version') AS server_version,
            current_setting('server_version_num') AS server_version_num,
            (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version`,
  )
  const row = runtime.rows[0]
  if (!row) throw new Error('PostgreSQL runtime metadata is unavailable')
  const extensions = await client.query<{ extname: string; extversion: string }>(
    `SELECT extname, extversion
       FROM pg_extension
      WHERE extname IN ('pgcrypto', 'vector')
      ORDER BY extname`,
  )
  const records = migrations.rows.map((migration) => ({ name: migration.name, checksum: migration.checksum }))
  return {
    databaseName: row.database_name,
    serverVersion: row.server_version,
    serverVersionNumber: Number.parseInt(row.server_version_num, 10),
    schemaVersion: schemaVersion(records),
    vectorVersion: row.vector_version,
    extensions: Object.fromEntries(extensions.rows.map((extension) => [extension.extname, extension.extversion])),
    migrations: records,
    tableCounts: await forgeTableCounts(client),
  }
}

export async function assertEmptyTarget(client: Client): Promise<{ serverVersion: string; serverVersionNumber: number }> {
  const relations = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_class AS relation
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname !~ '^pg_toast'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`,
  )
  if (relations.rows[0]?.count !== '0') {
    throw new Error('Restore target must be an empty database; existing relations were found')
  }
  const runtime = await client.query<{ server_version: string; server_version_num: string }>(
    `SELECT current_setting('server_version') AS server_version,
            current_setting('server_version_num') AS server_version_num`,
  )
  const row = runtime.rows[0]
  if (!row) throw new Error('Restore target runtime metadata is unavailable')
  return { serverVersion: row.server_version, serverVersionNumber: Number.parseInt(row.server_version_num, 10) }
}

export async function assertRestoredDatabase(client: Client, expected: BackupSourceMetadata): Promise<Record<string, string>> {
  const actual = await sourceMetadata(client)
  if (JSON.stringify(actual.migrations) !== JSON.stringify(expected.migrations)) {
    throw new Error('Restored migration checksums do not match the backup manifest')
  }
  if (JSON.stringify(actual.tableCounts) !== JSON.stringify(expected.tableCounts)) {
    throw new Error('Restored table counts do not match the backup snapshot')
  }
  return { ...actual.tableCounts }
}
