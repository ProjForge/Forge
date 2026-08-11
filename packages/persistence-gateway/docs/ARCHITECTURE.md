# FORGE Persistence Gateway 0.1 — Architecture

## Objective

Prove that a generic FORGE agent can persist useful task state and reconstruct it after its process/session disappears, without exposing PostgreSQL details to future transports.

## Boundaries

```text
Future REST / MCP / Agent adapters
                │
                ▼
      ForgePersistenceGateway
      ├── typed use cases
      ├── transaction boundaries
      ├── idempotency
      ├── optimistic locking
      ├── bounded operational catalogs
      └── context assembly / drift report
                │
                ▼
 FORGE PostgreSQL Schema 0.1.3
      ├── relational invariants
      ├── append-only records
      └── migration history
```

The schema is an external contract. This package neither copies nor mutates migrations.

## Transaction rules

- A use case and its idempotency claim commit together.
- Domain state, event and audit rows commit together.
- Failed operations roll back their claim and may be retried.
- A repeated key with the same request returns the persisted response.
- A repeated key with different request data fails closed.

## Context packages

Compilation selects:

- the requested task;
- active task memories plus project-level memories;
- accepted/draft task decisions.

The append-only package stores ordered source identifiers, versions and content hashes. Reload resolves current rows and reports version drift through `staleSources`.

Schema 0.1.3 does not keep historical row snapshots, so a stale package can identify drift but cannot reconstruct an older mutated source verbatim. Revision storage remains deferred.

## Operational catalogs

Projects are globally discoverable; tasks, executions, memories and decisions
require project scope. Pages are ordered by `created_at DESC, id DESC` and use
that pair as a keyset cursor, so insertion of newer rows does not shift later
pages. The default page size is 20 and the hard maximum is 100. Memory and
decision catalogs return explicit summary projections; full bodies remain in
continuation context rather than routine discovery results.

## Semantic retrieval

Embedding generation remains outside FORGE. Callers register a stable profile
and page through missing/stale candidates ordered by `(sourceKind, sourceId)`.
Pages default to 20 items, cap at 50 and bound source text independently. Each
candidate supplies a source version and deterministic SHA-256 input hash. The
caller computes a finite vector and submits it through the existing idempotent
write API.

Embeddings are immutable history keyed by profile, source and source version.
A source mutation between candidate discovery and write fails closed under a
source-row lock; the next scan exposes the new version. Reusing a cursor resumes
an interrupted scan, while starting again safely finds anything changed behind
that cursor.

Search is exact and scoped by `projectId` plus one profile. It excludes stale,
superseded or deleted sources by default, returns bounded summaries instead of
full payloads, and orders ties deterministically by distance, source kind and
source ID. ANN indexes are deferred because the heterogeneous untyped vector
column cannot safely support one global dimension-specific index.

## Reliability and security

- Parameterized SQL only.
- Pool and statement timeouts are bounded.
- Project IDs are present in every scoped query.
- Database composite FKs remain the final isolation boundary.
- Credentials are accepted only through runtime configuration.
- Gateway startup verifies migration `0005` for relational work and migration
  `0007` before vector work.

## Trade-offs

- Raw SQL is explicit and matches the reviewed schema, but requires mapper maintenance.
- A library-first API minimizes scope, but transport contracts remain future work.
- Semantic indexing/retrieval is exact; provider integration and ANN tuning remain
  deliberately outside this release.
- Registration is idempotent by natural key, while project-scoped writes use persistent idempotency records.

## Revisit when growing

- Split read/write repositories if query volume or ownership boundaries justify it.
- Add observability metrics around transaction latency, retries and stale packages.
- Add profile-specific typed ANN indexes only when measured retrieval volume
  justifies the extra schema complexity.
- Add a transport adapter only after the application contracts stabilize.
