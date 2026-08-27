import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createOnboardingPayload,
  createPortableProjectBundle,
  normalizeOnboardingPath,
  parsePortableProjectBundle,
} from '../src/project-portability.js'
import type { PortableProjectPayloadV1 } from 'forge-semantic-bridge/workbench'

const payload: PortableProjectPayloadV1 = {
  formatVersion: 1,
  sourceSchemaVersion: '0.1.3',
  project: { projectKey: 'existing-app', name: 'Existing App', description: 'Imported', metadata: {} },
  agents: [],
  tasks: [],
  memories: [{
    portableId: 'memory-1', taskKey: null, createdByAgentKey: null,
    memoryType: 'project', epistemicState: 'observed', trustLevel: 'internal',
    title: 'README.md', content: '# Existing App', summary: null, importance: 'high', metadata: {},
    provenance: [{ sourceKind: 'document', sourceRef: 'README.md', sourceVersion: 'v1', evidence: {} }],
  }],
  decisions: [],
  omitted: ['embeddings', 'executions', 'context_packages', 'events', 'audit_log'],
}

test('creates and verifies a deterministic portable project envelope', () => {
  const bundle = createPortableProjectBundle(payload, '2026-08-21T00:00:00.000Z')
  assert.equal(bundle.format, 'forge-project')
  assert.match(bundle.checksum.value, /^[0-9a-f]{64}$/)
  assert.deepEqual(parsePortableProjectBundle(JSON.parse(JSON.stringify(bundle))), bundle)

  const tampered = structuredClone(bundle)
  tampered.payload.project.name = 'Tampered'
  assert.throws(() => parsePortableProjectBundle(tampered), /checksum mismatch/)
})

test('turns supported repository documentation into provenance-bound memories', () => {
  const imported = createOnboardingPayload({
    projectKey: 'existing-app',
    name: 'Existing App',
    files: [
      { path: 'README.md', content: '# Existing App' },
      { path: 'docs/architecture.md', content: '# Architecture' },
      { path: 'package.json', content: '{"name":"existing-app"}' },
    ],
  })
  assert.equal(imported.memories.length, 3)
  assert.deepEqual(imported.memories.map((memory) => memory.provenance[0]?.sourceRef), [
    'README.md', 'docs/architecture.md', 'package.json',
  ])
  const onboarding = imported.project.metadata.onboarding as { fileCount: number }
  assert.equal(onboarding.fileCount, 3)
  assert.equal(imported.memories[0]?.importance, 'high')
})

test('rejects unsafe paths, likely secrets and unsupported source files', () => {
  assert.equal(normalizeOnboardingPath('.\\docs\\guide.md'), 'docs/guide.md')
  for (const path of ['../README.md', '.env', 'docs/client-secret.txt', 'docs/api-key.txt', 'README.exe', 'src/index.ts', 'node_modules/pkg/README.md']) {
    assert.throws(() => createOnboardingPayload({
      projectKey: 'unsafe', name: 'Unsafe', files: [{ path, content: 'value' }],
    }), /safe relative paths|excluded for safety|not supported/)
  }
})

test('rejects duplicate identities, unresolved references and decision cycles', () => {
  const duplicate = structuredClone(payload)
  duplicate.memories.push(structuredClone(duplicate.memories[0]!))
  assert.throws(() => createPortableProjectBundle(duplicate), /duplicate key/)

  const unresolved = structuredClone(payload)
  unresolved.tasks.push({ taskKey: 'TASK-1', title: 'Unresolved', objective: null, assignedAgentKey: 'missing-agent', status: 'ready', priority: 'normal', metadata: {} })
  assert.throws(() => createPortableProjectBundle(unresolved), /unknown agent/)

  const cyclic = structuredClone(payload)
  cyclic.decisions = [
    { decisionKey: 'A', taskKey: null, createdByAgentKey: null, title: 'A', decisionText: 'A', rationale: null, alternatives: [], consequences: [], status: 'superseded', supersedesDecisionKey: 'B', metadata: {} },
    { decisionKey: 'B', taskKey: null, createdByAgentKey: null, title: 'B', decisionText: 'B', rationale: null, alternatives: [], consequences: [], status: 'superseded', supersedesDecisionKey: 'A', metadata: {} },
  ]
  assert.throws(() => createPortableProjectBundle(cyclic), /contains a cycle/)
})
