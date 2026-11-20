import pg from 'pg'
import type { WindowsWorkbenchConfig } from './windows-config.js'

export const probeExit = { credentials: 10, schema: 11, permissions: 12, unavailable: 13, configuration: 14 } as const

const readable = [
  'schema_migrations', 'projects', 'agents', 'project_agents', 'tasks', 'decisions', 'memories',
  'memory_provenance', 'documents', 'document_chunks', 'embedding_profiles', 'embeddings',
  'executions', 'context_packages', 'context_package_items', 'events', 'audit_log', 'idempotency_keys',
]

export async function probeWindowsDatabase(database: WindowsWorkbenchConfig['database'], password: string): Promise<number> {
  const client = new pg.Client({
    host: database.host.replace(/^\[(.*)\]$/, '$1'),
    port: database.port, database: database.name, user: database.user, password,
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 4500,
    options: '-c default_transaction_read_only=on',
  })
  client.on('error', () => {})
  try {
    await client.connect()
    const runtime = await client.query<{ server_version_num: string }>("SHOW server_version_num")
    if (Number(runtime.rows[0]?.server_version_num) < 140_000) return probeExit.schema
    const { rows } = await client.query(`
      SELECT n.oid AS schema_id, c.oid AS table_id,
             has_schema_privilege(n.oid, 'USAGE') AS usable,
             has_table_privilege(c.oid, 'SELECT') AS readable,
             has_table_privilege(c.oid, 'INSERT') AS insertable,
             has_table_privilege(c.oid, 'UPDATE') AS updatable
      FROM unnest($1::text[]) AS expected(name)
      LEFT JOIN pg_namespace n ON n.nspname = 'forge'
      LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = expected.name AND c.relkind IN ('r','p')
      ORDER BY array_position($1::text[], expected.name)
    `, [readable])
    if (rows.some(row => !row.table_id)) return probeExit.schema
    if (rows.some((row, index) => !row.usable || !row.readable ||
      (!['schema_migrations', 'documents', 'document_chunks'].includes(readable[index]!) && !row.insertable) ||
      (['tasks', 'executions', 'idempotency_keys'].includes(readable[index]!) && !row.updatable))) return probeExit.permissions
    const requiredMigrations = ['0005_forge_schema_0_1_1.sql', '0006_forge_schema_0_1_2.sql', '0007_forge_schema_0_1_3.sql']
    const migrations = await client.query('SELECT name FROM forge.schema_migrations WHERE name = ANY($1::text[])', [requiredMigrations])
    return migrations.rowCount === requiredMigrations.length ? 0 : probeExit.schema
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code?.startsWith('28')) return probeExit.credentials
    if (code === '3D000' || code === '42P01' || code === '3F000') return probeExit.schema
    if (code === '42501') return probeExit.permissions
    return probeExit.unavailable
  } finally {
    await client.end().catch(() => {})
  }
}
