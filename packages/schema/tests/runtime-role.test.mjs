import assert from 'node:assert/strict'
import test from 'node:test'
import pg from 'pg'

const { Pool } = pg
const connectionString = process.env.FORGE_DATABASE_URL
const connection = connectionString ? new URL(connectionString) : undefined
const expectedRuntimeRole = process.env.FORGE_EXPECTED_RUNTIME_ROLE ?? (connection ? decodeURIComponent(connection.username) : undefined)
const expectedDatabase = connection ? decodeURIComponent(connection.pathname.slice(1)) : undefined

const expectedPrivileges = new Map([
  ['schema_migrations', ['SELECT']],
  ['projects', ['INSERT', 'SELECT']],
  ['agents', ['INSERT', 'SELECT']],
  ['project_agents', ['INSERT', 'SELECT']],
  ['tasks', ['INSERT', 'SELECT', 'UPDATE']],
  ['decisions', ['INSERT', 'SELECT']],
  ['memories', ['INSERT', 'SELECT']],
  ['memory_provenance', ['INSERT', 'SELECT']],
  ['documents', ['SELECT']],
  ['document_chunks', ['SELECT']],
  ['embedding_profiles', ['INSERT', 'SELECT']],
  ['embeddings', ['INSERT', 'SELECT']],
  ['executions', ['INSERT', 'SELECT', 'UPDATE']],
  ['context_packages', ['INSERT', 'SELECT']],
  ['context_package_items', ['INSERT', 'SELECT']],
  ['events', ['INSERT', 'SELECT']],
  ['audit_log', ['INSERT', 'SELECT']],
  ['idempotency_keys', ['INSERT', 'SELECT', 'UPDATE']],
])

function sqlState(error) {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined
}

test('runtime role follows the least-privilege contract', {
  skip: connectionString ? false : 'FORGE_DATABASE_URL is not configured',
  timeout: 15_000,
}, async () => {
  if (!connectionString) return

  const pool = new Pool({
    connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: 'forge-runtime-role-validation',
  })

  try {
    const identity = await pool.query([
      'SELECT current_user AS role_name,',
      '       current_database() AS database_name,',
      "       has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect,",
      "       has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database_objects,",
      "       has_schema_privilege(current_user, 'forge', 'USAGE') AS can_use_schema,",
      "       has_schema_privilege(current_user, 'forge', 'CREATE') AS can_create_in_schema",
    ].join('\n'))
    assert.deepEqual(identity.rows[0], {
      role_name: expectedRuntimeRole,
      database_name: expectedDatabase,
      can_connect: true,
      can_create_database_objects: false,
      can_use_schema: true,
      can_create_in_schema: false,
    })

    const role = await pool.query([
      'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit',
      '  FROM pg_roles',
      ' WHERE rolname = current_user',
    ].join('\n'))
    assert.deepEqual(role.rows[0], {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      rolconnlimit: 20,
    })

    const memberships = await pool.query([
      'SELECT count(*)::integer AS membership_count',
      '  FROM pg_auth_members membership',
      '  JOIN pg_roles member_role ON member_role.oid = membership.member',
      ' WHERE member_role.rolname = current_user',
    ].join('\n'))
    assert.equal(memberships.rows[0].membership_count, 0)

    const privileges = await pool.query([
      'SELECT tablename,',
      "       has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'SELECT') AS can_select,",
      "       has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'INSERT') AS can_insert,",
      "       has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'UPDATE') AS can_update,",
      "       has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'DELETE') AS can_delete,",
      "       has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRUNCATE') AS can_truncate,",
      "       has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'REFERENCES') AS can_reference,",
      "       has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRIGGER') AS can_trigger",
      '  FROM pg_tables',
      " WHERE schemaname = 'forge'",
      ' ORDER BY tablename',
    ].join('\n'))

    const seenTables = new Set()
    for (const row of privileges.rows) {
      seenTables.add(row.tablename)
      const actual = []
      if (row.can_select) actual.push('SELECT')
      if (row.can_insert) actual.push('INSERT')
      if (row.can_update) actual.push('UPDATE')
      if (row.can_delete) actual.push('DELETE')
      if (row.can_truncate) actual.push('TRUNCATE')
      if (row.can_reference) actual.push('REFERENCES')
      if (row.can_trigger) actual.push('TRIGGER')
      assert.deepEqual(actual.sort(), (expectedPrivileges.get(row.tablename) ?? []).sort(), row.tablename)
    }
    for (const table of expectedPrivileges.keys()) {
      assert.ok(seenTables.has(table), 'Expected FORGE table is missing: ' + table)
    }

    await assert.rejects(
      pool.query('CREATE TABLE forge.runtime_role_must_not_create(id integer)'),
      (error) => sqlState(error) === '42501',
    )
    await assert.rejects(
      pool.query([
        'INSERT INTO forge.schema_migrations(name, checksum)',
        "VALUES ('forbidden-runtime-write.sql', repeat('0', 64))",
      ].join('\n')),
      (error) => sqlState(error) === '42501',
    )
    await assert.rejects(
      pool.query('UPDATE forge.events SET event_type = event_type WHERE false'),
      (error) => sqlState(error) === '42501',
    )
    await assert.rejects(
      pool.query('DELETE FROM forge.projects WHERE false'),
      (error) => sqlState(error) === '42501',
    )
  } finally {
    await pool.end()
  }
})
