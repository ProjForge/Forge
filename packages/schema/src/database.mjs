import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import pg from 'pg'

const { Client } = pg

function normalizePgliteResult(result) {
  return {
    rows: result.rows ?? [],
    rowCount: result.affectedRows ?? result.rows?.length ?? 0,
  }
}

export async function openEmbeddedDatabase(dataDir) {
  const client = await PGlite.create({
    dataDir,
    extensions: { vector },
  })

  return {
    kind: 'pglite',
    exec: (sql) => client.exec(sql),
    query: async (sql, params = []) => normalizePgliteResult(await client.query(sql, params)),
    close: () => client.close(),
  }
}

export async function openServerDatabase(connectionString) {
  const client = new Client({ connectionString })
  await client.connect()

  return {
    kind: 'postgres',
    exec: (sql) => client.query(sql),
    query: (sql, params = []) => client.query(sql, params),
    close: () => client.end(),
  }
}
