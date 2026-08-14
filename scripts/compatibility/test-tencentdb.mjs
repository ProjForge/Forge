import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import pg from 'pg'
import { quoteIdentifier, requiredSecret } from '../../packages/schema/scripts/admin-helpers.mjs'
import {
  deriveConnectionUrl,
  namesForRun,
  parseConnectionUrl,
  redactSecrets,
  versionAtLeast,
} from './tencentdb-gate-lib.mjs'

const { Client } = pg
const repositoryRoot = new URL('../../', import.meta.url)
const adminUrl = parseConnectionUrl(process.env.FORGE_TENCENTDB_ADMIN_URL, 'FORGE_TENCENTDB_ADMIN_URL')
const runtimePassword = requiredSecret(process.env, 'FORGE_TENCENTDB_RUNTIME_PASSWORD')
const runId = process.env.FORGE_TENCENTDB_RUN_ID ?? `${Date.now()}`
const names = namesForRun(runId)
const keepFailed = process.env.FORGE_TENCENTDB_KEEP_FAILED === '1'
const adminTestUrl = deriveConnectionUrl(adminUrl, names.database)
const runtimeUrl = deriveConnectionUrl(adminUrl, names.database, names.role, runtimePassword)
let databaseCreated = false
let roleCreated = false
let passed = false
let preflight

function runNode(relativePath, args = [], environment = {}) {
  const result = spawnSync(process.execPath, [relativePath, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(redactSecrets(result.stderr))
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${relativePath} failed with exit code ${result.status}`)
}

function runNpm(args, environment = {}) {
  const npmCli = process.env.npm_execpath
  assert.ok(npmCli, 'Run the gate through npm so its pinned npm CLI can be reused')
  runNode(npmCli, args, environment)
}

async function connect(connectionString, applicationName) {
  const client = new Client({ connectionString, application_name: applicationName })
  await client.connect()
  return client
}

async function inspectTencentDb(client) {
  const result = await client.query(`
    SELECT current_setting('server_version_num')::integer AS server_version_num,
           current_setting('server_version') AS server_version,
           current_user AS admin_role,
           current_database() AS control_database,
           pg_is_in_recovery() AS in_hot_standby,
           current_role_attributes.rolcreatedb,
           current_role_attributes.rolcreaterole,
           COALESCE(connection_ssl.ssl, false) AS tls,
           connection_ssl.version AS tls_version,
           connection_ssl.cipher AS tls_cipher,
           vector.default_version AS vector_version,
           EXISTS (
             SELECT 1 FROM pg_roles provider_role
              WHERE provider_role.rolname IN ('pg_tencentdb_superuser', 'tencentdb_superuser')
           ) AS provider_role_available,
           EXISTS (
             SELECT 1 FROM pg_roles provider_role
              WHERE provider_role.rolname IN ('pg_tencentdb_superuser', 'tencentdb_superuser')
                AND (provider_role.rolname = current_user OR pg_has_role(current_user, provider_role.oid, 'member'))
           ) AS provider_admin
      FROM pg_roles current_role_attributes
      LEFT JOIN pg_stat_ssl connection_ssl ON connection_ssl.pid = pg_backend_pid()
      LEFT JOIN pg_available_extensions vector ON vector.name = 'vector'
     WHERE current_role_attributes.rolname = current_user`)
  assert.equal(result.rowCount, 1, 'TencentDB preflight returned no current role')
  const row = result.rows[0]
  assert.ok(row.server_version_num >= 140000, 'TencentDB PostgreSQL 14 or newer is required')
  assert.equal(row.in_hot_standby, false, 'TencentDB gate requires a writable primary')
  assert.equal(row.tls, true, 'TencentDB connection is not encrypted')
  assert.equal(row.provider_role_available, true, 'TencentDB provider role was not detected')
  assert.equal(row.provider_admin, true, 'Current user is not a TencentDB administrative account')
  assert.equal(row.rolcreatedb, true, 'TencentDB administrative account requires CREATEDB')
  assert.equal(row.rolcreaterole, true, 'TencentDB administrative account requires CREATEROLE')
  assert.ok(row.vector_version, 'TencentDB does not expose the vector extension')
  assert.ok(versionAtLeast(row.vector_version, '0.8.2'), 'TencentDB vector 0.8.2 or newer is required')
  return {
    serverVersion: row.server_version,
    vectorVersion: row.vector_version,
    tlsVersion: row.tls_version,
    tlsCipher: row.tls_cipher,
  }
}

async function assertFreshTargets(client) {
  const result = await client.query(`
    SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS database_exists,
           EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS role_exists`,
  [names.database, names.role])
  assert.equal(result.rows[0].database_exists, false, `Refusing to overwrite database ${names.database}`)
  assert.equal(result.rows[0].role_exists, false, `Refusing to overwrite role ${names.role}`)
}

async function cleanup() {
  const client = await connect(adminUrl.toString(), 'forge-tencentdb-cleanup')
  try {
    if (databaseCreated) {
      await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [names.database])
      await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(names.database)}`)
    }
    if (roleCreated) await client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(names.role)}`)
  } finally {
    await client.end().catch(() => undefined)
  }
}

try {
  const control = await connect(adminUrl.toString(), 'forge-tencentdb-preflight')
  try {
    preflight = await inspectTencentDb(control)
    await assertFreshTargets(control)
    await control.query(`CREATE DATABASE ${quoteIdentifier(names.database)}`)
    databaseCreated = true
  } finally {
    await control.end().catch(() => undefined)
  }

  runNode('packages/schema/tests/schema.test.mjs', ['--server-before-restart'], {
    FORGE_TEST_DATABASE_URL: adminTestUrl,
    FORGE_TEST_RESET: '1',
  })
  runNode('packages/schema/tests/schema.test.mjs', ['--server-after-reconnect'], {
    FORGE_TEST_DATABASE_URL: adminTestUrl,
  })
  runNode('packages/schema/scripts/configure-runtime-role.mjs', [`--role=${names.role}`], {
    FORGE_ADMIN_DATABASE_URL: adminTestUrl,
    FORGE_RUNTIME_PASSWORD: runtimePassword,
  })
  roleCreated = true
  runNode('packages/schema/tests/runtime-role.test.mjs', [], {
    FORGE_DATABASE_URL: runtimeUrl,
    FORGE_EXPECTED_RUNTIME_ROLE: names.role,
  })
  runNpm(['run', 'build', '-w', 'forge-persistence-gateway'])
  runNpm(['run', 'test:integration', '-w', 'forge-persistence-gateway'], { FORGE_DATABASE_URL: runtimeUrl })
  runNpm(['run', 'test:integration', '-w', 'forge-mcp-server'], { FORGE_DATABASE_URL: runtimeUrl })
  passed = true
} catch (error) {
  process.stderr.write(`TencentDB compatibility gate failed: ${redactSecrets(error?.message ?? error)}\n`)
  process.exitCode = 1
} finally {
  if (passed || !keepFailed) {
    try {
      await cleanup()
    } catch (error) {
      process.stderr.write(`TencentDB cleanup failed: ${redactSecrets(error?.message ?? error)}\n`)
      process.exitCode = 1
      passed = false
    }
  }
}

if (passed) {
  process.stdout.write(`${JSON.stringify({
    provider: 'TencentDB for PostgreSQL',
    ...preflight,
    database: names.database,
    runtimeRole: names.role,
    tlsVerified: true,
    connectionRecycle: true,
    schemaInvariants: true,
    leastPrivilege: true,
    gatewayContinuity: true,
    mcpContinuity: true,
    cleanup: true,
  }, null, 2)}\n`)
}
