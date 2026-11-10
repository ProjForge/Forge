import pg from 'pg'
import { setTimeout as delay } from 'node:timers/promises'

const identifier = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** Disposable topology only. The caller drains managed effects before invoking.
 * Role NOLOGIN is durable across loss of this connection; never reopen in finally.
 * The superuser operator remains trusted and explicitly outside this barrier.
 */
export async function sealCoherentDatabases(options: {
  connectionString: string; dataDirectory: string; databases: [string, string]
  writerRoles: string[]; backupRole: string
  maintenance: { assertHeld(): Promise<void> }
}): Promise<{ assertHeld(): Promise<void>; resume(): Promise<void>; close(): Promise<void> }> {
  if (options.databases[0] === options.databases[1] || !options.writerRoles.length || new Set(options.writerRoles).size !== options.writerRoles.length || options.writerRoles.includes(options.backupRole)) throw new Error('Invalid isolated database topology')
  const client = new pg.Client({ connectionString: options.connectionString, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 })
  await client.connect()
  let healthy = true
  client.on('error', () => { healthy = false })
  const roles = [...options.writerRoles, options.backupRole]
  try {
    await options.maintenance.assertHeld()
    const identity = (await client.query("SELECT current_setting('data_directory') AS directory, current_user AS operator, host(inet_server_addr()) AS host")).rows[0]
    if (identity.directory.replaceAll('\\', '/').toLowerCase() !== options.dataDirectory.replaceAll('\\', '/').toLowerCase() || identity.host !== '127.0.0.1') throw new Error('Disposable cluster identity mismatch')
    const declared = (await client.query('SELECT rolname,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=ANY($1)', [roles])).rows
    if (declared.length !== roles.length || declared.some(row => row.rolsuper || row.rolcreaterole || row.rolcreatedb || row.rolreplication || row.rolbypassrls || (row.rolname === options.backupRole ? row.rolcanlogin : !row.rolcanlogin))) throw new Error('Writers must be limited LOGIN roles and backup must be limited NOLOGIN')
    const unknown = await client.query('SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname<>current_user AND NOT (rolname=ANY($1))', [roles])
    if (unknown.rowCount) throw new Error('Unmanaged login role in disposable cluster')
    const operator = await client.query("SELECT 1 FROM pg_authid WHERE rolname=current_user AND rolcanlogin AND rolsuper AND rolpassword LIKE 'SCRAM-SHA-256$%'")
    if (operator.rowCount !== 1) throw new Error('Trusted operator must use SCRAM')
    const dbs = await client.query('SELECT datname,datallowconn FROM pg_database WHERE datname=ANY($1)', [options.databases])
    if (dbs.rowCount !== 2 || dbs.rows.some(row => !row.datallowconn)) throw new Error('Both source databases must be declared')
    // Backup role cannot be a member of a writer/owner role, or vice versa.
    const membership = await client.query('SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=ANY($1)', [roles])
    if (membership.rowCount) throw new Error('Role inheritance outside declared limited topology')
    for (const database of options.databases) {
      const url = new URL(options.connectionString); url.pathname = `/${database}`
      const inspector = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000, statement_timeout: 5_000 })
      await inspector.connect()
      try {
        const unsafe = await inspector.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
          AND (pg_get_userbyid(c.relowner)=$1 OR (c.relkind IN ('r','p','v','m','f') AND
            has_table_privilege($1,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) OR
            (c.relkind='S' AND has_sequence_privilege($1,c.oid,'USAGE,UPDATE')))
          UNION ALL SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname<>'information_schema'
            AND (pg_get_userbyid(nspowner)=$1 OR has_schema_privilege($1,oid,'CREATE'))
          UNION ALL SELECT 1 FROM pg_database WHERE datname=current_database() AND
            (pg_get_userbyid(datdba)=$1 OR has_database_privilege($1,oid,'CREATE'))`, [options.backupRole])
        if (unsafe.rowCount) throw new Error('Backup role must have no persistent write or DDL authority in either database')
      } finally { await inspector.end() }
    }
    await client.query('BEGIN')
    for (const role of options.writerRoles) await client.query(`ALTER ROLE ${identifier(role)} NOLOGIN`)
    await client.query('COMMIT')
    // Evict preexisting direct SQL/migration sessions on BOTH databases. Effect
    // admissions have already drained; never terminate an admitted external job.
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=ANY($1) AND usename<>current_user AND pid<>pg_backend_pid()', [options.databases])
    const deadline = Date.now() + 5_000
    while ((await client.query('SELECT 1 FROM pg_stat_activity WHERE datname=ANY($1) AND usename<>current_user', [options.databases])).rowCount) {
      if (Date.now() >= deadline) throw new Error('Database session drain timeout; roles remain sealed')
      await delay(20)
    }
    const assertHeld = async () => {
      if (!healthy) throw new Error('Database gate connection lost; roles remain sealed')
      await options.maintenance.assertHeld()
      const drift = await client.query('SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname<>current_user')
      const sessions = await client.query('SELECT pid FROM pg_stat_activity WHERE datname=ANY($1) AND usename<>current_user', [options.databases])
      if (drift.rowCount || sessions.rowCount) throw new Error('Database gate lost exclusivity')
    }
    await assertHeld()
    return { assertHeld, close: () => client.end(), resume: async () => {
      await assertHeld()
      await client.query('BEGIN')
      try {
        for (const role of options.writerRoles) await client.query(`ALTER ROLE ${identifier(role)} LOGIN`)
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    } }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    await client.end()
    throw error
  }
}
