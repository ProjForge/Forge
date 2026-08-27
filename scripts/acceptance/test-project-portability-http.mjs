import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ForgePersistenceGateway } from '../../packages/persistence-gateway/dist/index.js'
import { createWorkbenchServer } from '../../packages/workbench/dist/server.js'
import { ForgeWorkbenchService } from '../../packages/workbench/dist/service.js'

const connectionString = process.env.FORGE_DATABASE_URL
assert.ok(connectionString, 'FORGE_DATABASE_URL is required')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const gateway = ForgePersistenceGateway.connect({ connectionString })
const service = new ForgeWorkbenchService(gateway, { search: async () => [] })
const token = 'portability-acceptance-token'
const server = createWorkbenchServer(service, { publicDir: path.join(root, 'packages/workbench/public'), token })

try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const headers = { 'content-type': 'application/json', 'x-forge-token': token }
  const suffix = Date.now().toString(36)

  const onboardedResponse = await fetch(`${base}/api/imports/repository`, {
    method: 'POST', headers,
    body: JSON.stringify({
      projectKey: `existing-${suffix}`,
      name: 'Existing repository',
      files: [
        { path: 'README.md', content: '# Existing repository\n\nDurable context.' },
        { path: 'docs/architecture.md', content: '# Architecture\n\nPostgreSQL is the source of truth.' },
      ],
      idempotencyKey: `onboard-${suffix}`,
    }),
  })
  assert.equal(onboardedResponse.status, 201)
  const onboarded = (await onboardedResponse.json()).result
  assert.equal(onboarded.imported.memories, 2)

  const exportedResponse = await fetch(`${base}/api/projects/${onboarded.project.id}/export`, { headers })
  assert.equal(exportedResponse.status, 200)
  assert.match(exportedResponse.headers.get('content-disposition') ?? '', /\.forge-project/)
  const bundle = await exportedResponse.json()
  assert.equal(bundle.payload.memories.length, 2)

  const tampered = structuredClone(bundle)
  tampered.payload.project.name = 'Tampered'
  const rejected = await fetch(`${base}/api/imports/forge-project`, {
    method: 'POST', headers,
    body: JSON.stringify({ bundle: tampered, targetProjectKey: `tampered-${suffix}`, mode: 'create', idempotencyKey: `tampered-${suffix}` }),
  })
  assert.equal(rejected.status, 400)

  const targetProjectKey = `portable-copy-${suffix}`
  const importedResponse = await fetch(`${base}/api/imports/forge-project`, {
    method: 'POST', headers,
    body: JSON.stringify({ bundle, targetProjectKey, targetProjectName: 'Portable copy', mode: 'create', idempotencyKey: `import-${suffix}` }),
  })
  assert.equal(importedResponse.status, 201)
  const imported = (await importedResponse.json()).result
  assert.equal(imported.imported.memories, 2)

  const catalogResponse = await fetch(`${base}/api/projects/${imported.project.id}/catalog`, { headers })
  assert.equal(catalogResponse.status, 200)
  const catalog = (await catalogResponse.json()).result
  assert.deepEqual(catalog.memories.map((memory) => memory.title).sort(), ['README.md', 'docs/architecture.md'])

  process.stdout.write('Workbench project portability HTTP acceptance: PASS\n')
} finally {
  await new Promise((resolve) => server.close(() => resolve()))
  await gateway.close()
}
