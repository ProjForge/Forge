import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const outputPath = process.argv[2]
assert.ok(outputPath, 'An output path is required')
const status = process.env.FORGE_PI_RESULT_STATUS
assert.ok(status === 'PASS' || status === 'FAIL', 'Result status must be PASS or FAIL')

const result = {
  formatVersion: 1,
  product: 'FORGE',
  suite: 'raspberry-pi-5-arm64-acceptance',
  status,
  stage: process.env.FORGE_PI_RESULT_STAGE,
  sourceCommit: process.env.FORGE_PI_RESULT_COMMIT,
  startedAt: process.env.FORGE_PI_RESULT_STARTED_AT,
  finishedAt: process.env.FORGE_PI_RESULT_FINISHED_AT,
  platform: {
    model: process.env.FORGE_PI_RESULT_MODEL,
    os: process.env.FORGE_PI_RESULT_OS,
    kernel: process.env.FORGE_PI_RESULT_KERNEL,
    architecture: process.env.FORGE_PI_RESULT_ARCH,
  },
  runtime: {
    node: process.env.FORGE_PI_RESULT_NODE,
    npm: process.env.FORGE_PI_RESULT_NPM,
    docker: process.env.FORGE_PI_RESULT_DOCKER,
    postgresql: process.env.FORGE_PI_RESULT_POSTGRES,
    pgvector: process.env.FORGE_PI_RESULT_VECTOR,
  },
  safety: {
    loopbackOnly: true,
    disposableDatabase: true,
    hostDatabaseTouched: false,
    secretsIncluded: false,
  },
}

const resolved = path.resolve(outputPath)
await mkdir(path.dirname(resolved), { recursive: true })
await writeFile(resolved, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
