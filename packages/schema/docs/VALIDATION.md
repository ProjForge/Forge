# Validation

Date: 2026-08-10

## Schema 0.1.3 result

Migration `0007_forge_schema_0_1_3.sql` was applied transactionally to the
native PostgreSQL 18.4 database. The embedded regression passed **10/10** test
groups, including legacy `source_version` backfill, immutable version history
and runtime close/reopen persistence.

The Windows `postgresql-x64-18` service was then physically stopped and
started. After recovery, all current native consumers passed through the
limited role:

| Post-restart path | Result |
|---|---:|
| Runtime permission contract | 1/1 pass |
| Gateway continuity/indexing integration | 1/1 pass |
| MCP spawned-process continuity/indexing integration | 1/1 pass |

Gateway and MCP startup both require migration 0007, so these successful paths
also prove that the seven-name checksum history and Schema 0.1.3 persisted
through the service restart.

## Native PostgreSQL server

Runtime:

- PostgreSQL: 18.4 (Windows service `postgresql-x64-18`)
- pgvector: 0.8.2, compiled from the official source
- Test database: isolated `forge_test`
- Node.js: 24.15.0

Schema 0.1.2 baseline before migration 0007: **8/8 server integration groups passed**.

| Test group | Result |
|---|---:|
| `0.1 → 0.1.2` migration and repeat-run idempotency | Pass |
| Managed `forge_id` immutability and duplicate conflict representation | Pass |
| Cross-project relational integrity | Pass |
| Embedding dimensions and profile stability | Pass |
| Optimistic locking token behavior | Pass |
| Append-only context packages/events/audit | Pass |
| Business/event idempotency keys | Pass |
| Two-connection dimension concurrency serialization | Pass |

The Windows PostgreSQL service was then stopped and started. Post-restart verification passed:

- persistence marker retained;
- pgvector 0.8.2 available;
- six migration names/checksums retained;
- migration rerun applied zero files and skipped all six.

## Embedded regression

Runtime:

- PostgreSQL engine: PGlite PostgreSQL 18.3
- pgvector: 0.8.1
- Node.js: 24.15.0
- Dependency audit: 0 known vulnerabilities

Result: **10/10 embedded integration groups passed**.

| Test group | Result |
|---|---:|
| Relational core installs without pgvector | Pass |
| `0.1 → 0.1.3` migration, legacy backfill and repeat-run idempotency | Pass |
| Managed `forge_id` immutability and duplicate conflict representation | Pass |
| Cross-project relational integrity | Pass |
| Embedding dimensions and profile stability | Pass |
| Versioned embedding history and append-only enforcement | Pass |
| Optimistic locking token behavior | Pass |
| Append-only context packages/events/audit | Pass |
| Business/event idempotency keys | Pass |
| Persistence after runtime close/reopen | Pass |

Command:

```powershell
npm test
```

## Least-privilege runtime role

The local `forge_test_runner` role was recreated/configured interactively after
the administrator password rotation.

Result: **Pass**.

- non-superuser, no database/role creation, replication or RLS bypass;
- no role memberships and a 20-connection limit;
- `USAGE` but no `CREATE` on the `forge` schema;
- read/insert only on the immutable Gateway output tables;
- updates limited to `tasks`, `executions` and `idempotency_keys`;
- no delete, truncate, trigger, reference or migration-write privilege;
- vector source reads plus profile/embedding read+insert, with no update/delete;
- explicit denial tests returned SQLSTATE `42501`;
- Gateway continuity integration, semantic retrieval and spawned MCP restart
  flow passed under this role.

Credentials were entered only through interactive hidden prompts and were not
persisted by the validation scripts.

## Optional PostgreSQL 14 container path

Prepared image: `pgvector/pgvector:0.8.2-pg14`.

The server mode adds:

- two-connection serialization test for embedding insert vs. dimension update;
- physical container restart;
- post-restart marker and migration-history verification.

Command:

```powershell
npm run test:docker
```

Docker is not installed on this host, so this optional exact-version path was not executed. Native PostgreSQL 18.4 satisfies the declared PostgreSQL 14+ target and completed the full server suite.

## Compatibility assessment

The migrations intentionally avoid post-14 SQL features. Syntax, constraints, locking and restart persistence were validated on PostgreSQL 18.4. Exact PostgreSQL 14 binary execution remains an optional compatibility-matrix check, not a blocker for the PostgreSQL 14+ implementation candidate.

## Schema 0.1.2 regression history

The checksum runner applied `0006_forge_schema_0_1_2.sql` transactionally on
the existing native database. Embedded regression remained **9/9 pass**. The
dedicated permission contract, Gateway native integration and MCP native
spawn/restart integration all passed afterward. These paths prove that the
limited role can serialize and insert valid vectors while profile
`UPDATE`/`DELETE` remains denied.

The Windows `postgresql-x64-18` service was then physically stopped and
started with Schema 0.1.2 in place. The runtime permission contract, Gateway
semantic integration and MCP spawned-process integration all passed again
after service recovery, confirming database and migration persistence.
