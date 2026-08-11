import assert from 'node:assert/strict'
import { openServerDatabase } from '../src/database.mjs'
import { applyMigrations } from '../src/migrations.mjs'

const connectionString = process.env.FORGE_DATABASE_URL
assert.ok(connectionString, 'FORGE_DATABASE_URL is required')

const upToArgument = process.argv.find((argument) => argument.startsWith('--up-to='))
const upTo = upToArgument ? Number.parseInt(upToArgument.split('=')[1], 10) : undefined
if (upToArgument) {
  assert.ok(Number.isInteger(upTo) && upTo > 0, '--up-to must be a positive migration count')
}

const db = await openServerDatabase(connectionString)
try {
  const result = await applyMigrations(db, { upTo })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await db.close()
}
