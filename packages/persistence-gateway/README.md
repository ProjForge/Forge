# FORGE Persistence Gateway 0.1.5

Typed PostgreSQL boundary for the first generic FORGE continuity slice.

Status: implementation validated on PostgreSQL 18.4 with FORGE Schema 0.1.3 and pgvector 0.8.2.

The Gateway does not own the database schema and does not duplicate migrations.
Its relational workflows remain compatible with Schema 0.1.1; the embedding
and semantic-indexing/search workflows require `FORGE-PostgreSQL-Schema-0.1.3`.

## Scope

- Register generic projects and agents.
- Recover projects, assigned agents, tasks and executions by stable keys.
- List projects, tasks, executions, active memories and decisions with
  deterministic keyset pagination and bounded filters.
- Assign agents to projects.
- Create tasks and start/finish executions.
- Persist memories with provenance.
- Persist decisions.
- Hydrate bounded, version-bound semantic candidate text without crossing project scope.
- Compile immutable context packages.
- Reload a package after process replacement and report stale sources.
- Record events and audit entries transactionally.
- Enforce persistent idempotency and optimistic locking.
- Register model/provider-agnostic embedding profiles.
- Discover missing/stale embedding candidates through bounded, deterministic pages.
- Store one immutable vector per profile, supported source and source version.
- Run exact, project-scoped semantic search with deterministic ranking.

Not included: HTTP/MCP transport, authentication, policy evaluation,
embedding-provider calls, approximate ANN indexes or production deployment.

## Setup

Requires Node.js 20+, PostgreSQL 14+ and an already migrated FORGE database.

```powershell
npm install
npm run build
```

Configure the connection only in the process environment:

```powershell
$env:FORGE_DATABASE_URL = 'postgresql://user:password@127.0.0.1:5432/forge_test'
```

Do not commit credentials. Use a dedicated non-superuser role outside local prototyping.

The Schema package includes
`scripts/setup-and-test-runtime-role.ps1`, which configures
`forge_test_runner` interactively and validates this Gateway with that role.
`postgres` is required only for schema administration, never for normal Gateway
execution.

FORGE MCP Server 0.1 consumes this package as a compiled dependency and maps its
public use cases to local MCP tools. The Gateway itself remains transport-free.

## Validation

```powershell
npm test
npm run test:integration
npm run smoke
```

The integration test uses unique project/agent/task keys and intentionally leaves its trace in the test database so persistence and audit can be inspected.

## Usage

```ts
import { ForgePersistenceGateway } from 'forge-persistence-gateway'

const gateway = ForgePersistenceGateway.connect({
  connectionString: process.env.FORGE_DATABASE_URL!,
})

await gateway.assertReady()

const context = await gateway.compileContinuationContext({
  projectId,
  taskId,
  agentId,
  executionId,
  idempotencyKey: requestId,
})

const recoveredTask = await gateway.getTaskByKey(projectId, taskKey)

const firstPage = await gateway.listTasks({
  projectId,
  status: 'in_progress',
  limit: 20,
})

const nextPage = firstPage.nextCursor
  ? await gateway.listTasks({ projectId, cursor: firstPage.nextCursor, limit: 20 })
  : null

await gateway.registerEmbeddingProfile({
  profileKey: 'generic-3d',
  provider: 'caller-managed',
  model: 'example',
  dimensions: 3,
  distanceMetric: 'cosine',
})

const candidates = await gateway.listEmbeddingCandidates({
  projectId,
  profileKey: 'generic-3d',
  limit: 20,
  maxTextChars: 8000,
})

// Generate vectors outside FORGE, then call putEmbedding with each candidate's
// sourceId and sourceVersion. Reuse candidates.nextCursor to resume the scan.

const hits = await gateway.semanticSearch({
  projectId,
  profileKey: 'generic-3d',
  queryEmbedding: [0.9, 0.1, 0],
  sourceKinds: ['memory', 'decision'],
  limit: 10,
})
```

Every retryable write requires an idempotency key. Every mutable update requires the expected entity version.
Catalog cursors are opaque continuation values to callers and must be reused
unchanged. Memory and decision catalogs return operational summaries rather
than potentially large body fields.

FORGE never calls an embedding provider. Callers page through deterministic
candidates, generate vectors externally, then submit them with the candidate's
`sourceVersion`. A source change between discovery and write is rejected;
rerunning the scan discovers its newest version. Historical vectors remain
immutable and search excludes them by default. Cosine profiles reject zero
vectors because their distance is undefined.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [VALIDATION.md](docs/VALIDATION.md).
