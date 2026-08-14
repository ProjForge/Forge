import assert from 'node:assert/strict'
import pg from 'pg'
import { quoteIdentifier, requiredSecret, validateIdentifier } from './admin-helpers.mjs'

const { Client } = pg
const connectionString = process.env.FORGE_ADMIN_DATABASE_URL
assert.ok(connectionString, 'FORGE_ADMIN_DATABASE_URL is required')
const password = requiredSecret(process.env, 'FORGE_RUNTIME_PASSWORD')
const roleArgument = process.argv.find((value) => value.startsWith('--role='))
const runtimeRole = validateIdentifier(roleArgument?.slice(7) ?? 'forge_runtime', 'runtime role')
const role = quoteIdentifier(runtimeRole)
const client = new Client({ connectionString, application_name: 'forge-bootstrap' })

const readable = [
  'schema_migrations', 'projects', 'agents', 'project_agents', 'tasks', 'decisions', 'memories',
  'memory_provenance', 'documents', 'document_chunks', 'embedding_profiles', 'embeddings', 'executions',
  'context_packages', 'context_package_items', 'events', 'audit_log', 'idempotency_keys',
]
const insertable = [
  'projects', 'agents', 'project_agents', 'tasks', 'decisions', 'memories', 'memory_provenance',
  'embedding_profiles', 'embeddings', 'executions', 'context_packages', 'context_package_items',
  'events', 'audit_log', 'idempotency_keys',
]
const updatable = ['tasks', 'executions', 'idempotency_keys']
const tables = (names) => names.map((name) => `forge.${quoteIdentifier(name)}`).join(', ')

try {
  await client.connect()
  await client.query('BEGIN')
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [runtimeRole])
  if (exists.rowCount === 0) await client.query(`CREATE ROLE ${role} LOGIN`)
  const memberships = await client.query(`
    SELECT granted.rolname FROM pg_auth_members membership
    JOIN pg_roles granted ON granted.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
    WHERE member.rolname = $1`, [runtimeRole])
  for (const membership of memberships.rows) {
    await client.query(`REVOKE ${quoteIdentifier(membership.rolname)} FROM ${role}`)
  }
  const passwordSql = await client.query('SELECT format(\'ALTER ROLE %I PASSWORD %L\', $1::text, $2::text) AS sql', [runtimeRole, password])
  await client.query(passwordSql.rows[0].sql)
  await client.query(`ALTER ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 20`)
  await client.query(`ALTER ROLE ${role} SET statement_timeout = '15s'`)
  await client.query(`ALTER ROLE ${role} SET lock_timeout = '5s'`)
  await client.query(`ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '30s'`)
  await client.query(`REVOKE ALL PRIVILEGES ON DATABASE ${quoteIdentifier(client.database)} FROM ${role}`)
  await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(client.database)} TO ${role}`)
  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA forge FROM ${role}`)
  await client.query(`GRANT USAGE ON SCHEMA forge TO ${role}`)
  await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA forge FROM ${role}`)
  await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA forge FROM ${role}`)
  await client.query(`GRANT SELECT ON ${tables(readable)} TO ${role}`)
  await client.query(`GRANT INSERT ON ${tables(insertable)} TO ${role}`)
  await client.query(`GRANT UPDATE ON ${tables(updatable)} TO ${role}`)
  await client.query('COMMIT')
  process.stdout.write(JSON.stringify({ role: runtimeRole, leastPrivilege: true }) + '\n')
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined)
  throw error
} finally {
  await client.end().catch(() => undefined)
}
