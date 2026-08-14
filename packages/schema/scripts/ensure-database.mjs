import assert from 'node:assert/strict'
import pg from 'pg'
import { quoteIdentifier, validateIdentifier } from './admin-helpers.mjs'

const { Client } = pg
const connectionString = process.env.FORGE_ADMIN_DATABASE_URL
assert.ok(connectionString, 'FORGE_ADMIN_DATABASE_URL is required')
const nameArgument = process.argv.find((value) => value.startsWith('--name='))
const databaseName = validateIdentifier(nameArgument?.slice(7), 'database name')
const client = new Client({ connectionString, application_name: 'forge-bootstrap' })

try {
  await client.connect()
  const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName])
  if (existing.rowCount === 0) await client.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
  process.stdout.write(JSON.stringify({ database: databaseName, created: existing.rowCount === 0 }) + '\n')
} finally {
  await client.end().catch(() => undefined)
}
