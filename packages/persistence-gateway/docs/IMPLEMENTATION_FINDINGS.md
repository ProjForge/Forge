# FORGE Persistence Gateway 0.1 — Implementation Findings

Date: 2026-08-10

## GW-TEST-01 — Windows glob produced a zero-test false positive

Status: fixed and regression-tested

The initial npm script passed a wildcard directly to Node. Windows did not expand it, and the command exited successfully with `tests 0`.

Correction:

- test TypeScript is explicitly included in `tsconfig.test.json`;
- npm scripts execute concrete compiled entry paths;
- validation records the executed test count, not only the exit code.

## GW-SEC-01 — Development runtime introduced an avoidable advisory

Status: removed; audit clean

`tsx` pulled a low-severity `esbuild` advisory concerning its Windows development server. The Gateway does not need runtime TypeScript execution.

Correction: tests and CLI are compiled with `tsc` and executed as JavaScript. `tsx`/`esbuild` were removed rather than overridden outside their declared compatibility range.

Final dependency audit: zero known vulnerabilities.

## GW-SQL-01 — No new schema correction required

Status: confirmed

The Gateway exercised transactions, composite project FKs, append-only tables, idempotency, version triggers and context package persistence on native PostgreSQL. No additional DDL change was required.

## GW-SEC-02 — Registration locks expanded runtime privileges unnecessarily

Status: fixed and regression-tested

The replay paths for projects, agents and assignments used `SELECT FOR UPDATE`
after `INSERT ... ON CONFLICT DO NOTHING`. PostgreSQL consequently required
`UPDATE` privilege even though these paths never update the rows.

Minimal correction: use a normal `SELECT` after the conflict. The unique
constraint already serializes the conflicting insert, so the committed row is
visible before the fallback read executes.

This removed `UPDATE` access from `projects`, `agents` and
`project_agents`. Runtime updates are now limited to tasks, executions and
idempotency records.

## GW-READ-03 — Durable recovery required stable-key reads

Status: fixed and native restart-tested

The initial write-oriented API returned UUIDs but could not recover them after
a new process or host session without replaying writes or retaining earlier
tool output. This made operational continuity depend on chat history.

Gateway 0.1.1 adds parameterized reads for project, assigned agent, non-deleted
task and execution keys. Agent, task and execution lookups require `projectId`;
cross-project attempts return `NOT_FOUND`. The existing least-privilege role
already had the necessary `SELECT` grants, so Schema 0.1.1 did not change.

## GW-CATALOG-04 — Operational discovery needed bounded, stable catalogs

Status: fixed and native restart-tested

Stable-key lookups recover known entities but do not answer operational
questions such as which tasks are active or which executions are running.
Offset pagination would become unstable when new rows are inserted between
requests, and returning full memory/decision bodies would make discovery
payloads grow unnecessarily.

Gateway 0.1.2 adds five parameterized catalogs ordered by
`created_at DESC, id DESC`. Continuation uses a typed `(createdAt, id)` keyset
cursor, defaults to 20 rows and is capped at 100. All subordinate catalogs
require `projectId`; active memories exclude superseded/deleted rows; memory
and decision catalogs use explicit summary projections. Native tests cover
filters, page boundaries, equal-timestamp tie breaking, cross-project
isolation and recovery after Gateway replacement. Existing indexes and grants
were sufficient, so no Schema 0.1.1 migration was added.

## GW-VECTOR-05 — Retrieval must not bind FORGE to an embedding provider

Status: implemented and native-tested

Gateway 0.1.3 accepts caller-generated vectors behind stable embedding profile
keys. Provider/model values are descriptive metadata, not executable adapters.
Writes validate finite values, dimensions, supported versioned sources and
idempotent replay. Exact search is bounded, deterministic, project-scoped and
excludes stale sources by default.

## GW-SEC-06 — Dimension serialization accidentally required runtime UPDATE

Status: fixed in Schema 0.1.2 and regression-tested with the limited role

The dimension trigger uses `SELECT ... FOR SHARE` to serialize an embedding
insert against a concurrent profile-dimension change. PostgreSQL evaluates that
lock using the invoker's privileges, so a role with only `SELECT` and `INSERT`
received SQLSTATE `42501` unless it was also granted `UPDATE` on profiles.

Granting `UPDATE` would have weakened the runtime boundary. Migration `0006`
therefore recreates only the validator as `SECURITY DEFINER`, pins its search
path to `pg_catalog, pg_temp`, schema-qualifies every object and revokes public
execution. The native Gateway and MCP flows can now insert safely while the
runtime role still has no profile update/delete privilege.

## GW-INDEX-07 — Source-only uniqueness blocked incremental reindexing

Status: fixed in Schema 0.1.3 and regression-tested

Schema 0.1.2 made `(profile_id, source_id)` unique. That detected stale vectors
but also prevented a changed source from receiving a new embedding unless the
runtime updated or deleted immutable history.

The minimal correction adds a positive `source_version`, backfills legacy rows
and keys uniqueness by `(profile, source, source_version)`. Gateway 0.1.4 adds
bounded deterministic candidate discovery while keeping provider execution
outside FORGE. Native tests cover missing/stale classification, cursor resume,
restart recovery, project isolation and append-only version history.

## GW-SEMANTIC-08 — Reranking needs current text without widening search results

Status: implemented and native-tested

Returning full source bodies from every semantic search would inflate the
default read path and create a time-of-check/time-of-use ambiguity. Gateway
0.1.5 adds `getSemanticCandidateTexts`: callers submit at most 50 ordered
`(sourceKind, sourceId, sourceVersion)` references plus mandatory `projectId`.
The query returns at most 32,000 characters per source, preserves input order
and rejects the entire request with `NOT_FOUND` when any source changed, became
inactive or belongs to another project. No provider logic or schema migration
was introduced.
