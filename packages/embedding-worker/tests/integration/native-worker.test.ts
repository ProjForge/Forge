import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { ForgePersistenceGateway } from 'forge-persistence-gateway'

const connectionString = process.env.FORGE_DATABASE_URL

async function runCli(env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli.js'], {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`Worker CLI exited ${code}: ${stderr}`))
      resolve({ stdout, stderr })
    })
  })
}

test('indexes a native FORGE project through a real HTTP/provider boundary and resumes after replacement', {
  skip: connectionString ? false : 'FORGE_DATABASE_URL is not configured',
  timeout: 30_000,
}, async () => {
  if (!connectionString) return
  const suffix = randomUUID()
  let providerRequests = 0
  const server = createServer(async (request, response) => {
    assert.equal(request.method, 'POST')
    assert.equal(request.url, '/v1/embeddings')
    assert.equal(request.headers.authorization, 'Bearer native-test-key')
    let raw = ''
    for await (const chunk of request) raw += String(chunk)
    const body = JSON.parse(raw) as { input: string[]; model: string; dimensions: number }
    assert.equal(body.model, 'native-http-3d')
    assert.equal(body.dimensions, 3)
    providerRequests += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      object: 'list',
      model: body.model,
      data: body.input.map((_, index) => ({
        object: 'embedding',
        index,
        embedding: [1, index + 1, 0],
      })),
      usage: { prompt_tokens: body.input.length * 3, total_tokens: body.input.length * 3 },
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  let gateway = ForgePersistenceGateway.connect({ connectionString })
  try {
    assert.equal((await gateway.assertReady()).schemaVersion, '0.1.3')
    const project = await gateway.registerProject({
      projectKey: `embedding-worker-project-${suffix}`,
      name: 'Embedding worker native integration',
    })
    const agent = await gateway.registerAgent({
      agentKey: `embedding-worker-agent-${suffix}`,
      name: 'Embedding worker integration agent',
      role: 'indexer',
    })
    await gateway.assignAgent(project.id, agent.id, 'indexer')
    const memory = await gateway.remember({
      projectId: project.id,
      agentId: agent.id,
      memoryType: 'semantic',
      epistemicState: 'verified',
      trustLevel: 'internal',
      title: 'Native embedding worker evidence',
      content: 'The external worker persists a version-bound vector through a simulated HTTP provider.',
      idempotencyKey: `embedding-worker-memory-${suffix}`,
    })
    const profileKey = `embedding-worker-profile-${suffix}`
    const { port } = server.address() as AddressInfo
    const cliEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      FORGE_DATABASE_URL: connectionString,
      FORGE_PROJECT_ID: project.id,
      FORGE_AGENT_ID: agent.id,
      FORGE_EMBEDDING_PROFILE_KEY: profileKey,
      FORGE_EMBEDDING_PROVIDER_NAME: 'native-http-simulator',
      FORGE_EMBEDDING_MODEL: 'native-http-3d',
      FORGE_EMBEDDING_DIMENSIONS: '3',
      FORGE_EMBEDDING_BASE_URL: `http://127.0.0.1:${port}/v1`,
      FORGE_EMBEDDING_API_KEY: 'native-test-key',
      FORGE_EMBEDDING_SOURCE_KINDS: 'memory',
      FORGE_EMBEDDING_PAGE_SIZE: '1',
      FORGE_EMBEDDING_MAX_CANDIDATES: '10',
    }
    const firstProcess = await runCli(cliEnvironment)
    const first = JSON.parse(firstProcess.stdout) as { status: string; result: { embedded: number; discovered: number; complete: boolean; inputTokens: number } }
    assert.equal(first.status, 'PASS')
    assert.equal(first.result.embedded, 1)
    assert.equal(first.result.discovered, 1)
    assert.equal(first.result.complete, true)
    assert.equal(first.result.inputTokens, 3)
    assert.equal(firstProcess.stderr, '')
    assert.doesNotMatch(firstProcess.stdout, /native-test-key|forge_test_runner:/)

    const candidates = await gateway.listEmbeddingCandidates({
      projectId: project.id,
      profileKey,
      sourceKinds: ['memory'],
    })
    assert.equal(candidates.items.length, 0)
    const hits = await gateway.semanticSearch({
      projectId: project.id,
      profileKey,
      queryEmbedding: [1, 1, 0],
      sourceKinds: ['memory'],
    })
    assert.equal(hits[0]?.sourceId, memory.id)

    await gateway.close()
    gateway = ForgePersistenceGateway.connect({ connectionString })
    const secondProcess = await runCli(cliEnvironment)
    const resumed = JSON.parse(secondProcess.stdout) as { result: { discovered: number; embedded: number } }
    assert.equal(resumed.result.discovered, 0)
    assert.equal(resumed.result.embedded, 0)
    assert.equal(providerRequests, 1)
  } finally {
    await gateway.close()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
