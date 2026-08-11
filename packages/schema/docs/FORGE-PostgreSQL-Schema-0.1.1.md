# FORGE — PostgreSQL Schema 0.1.1

Version: 0.1.1
Status: implementation validated on native PostgreSQL 18.4 and embedded PostgreSQL 18.3
Scope: Generic FORGE Core

## Objective

Persist project/agent registration, task continuity, memory, decisions, managed knowledge, context packages, executions, events, idempotency and audit without coupling the core to any named project, agent, model or tool.

The executable migration files are the source of truth. This document records their boundaries and guarantees without duplicating the DDL.

## Migration model

| Migration | Responsibility | pgvector dependency |
|---|---|---:|
| `0001_forge_core.sql` | Relational entities and base constraints | No |
| `0002_forge_vector.sql` | Extension, embedding profiles and vectors | Yes |
| `0003_forge_indexes.sql` | Query/idempotency indexes | Vector tables already present |
| `0004_forge_guards.sql` | Version/path/append-only triggers | Vector profile trigger included |
| `0005_forge_schema_0_1_1.sql` | Reviewed invariant corrections | Dimension guards use pgvector |

## 0.1.1 guarantees

### Managed document identity

- A `managed` document requires a non-null `forge_id`.
- `forge_id` values may be duplicated while documents are `conflict`/`unmanaged`.
- A `forge_id` is unique among `managed` documents.
- A writer cannot change the `forge_id` of a row whose previous state is `managed`.

### Project isolation

Composite foreign keys bind scoped references to their project for tasks, decisions, memories, document chunks, executions, context packages/items, embeddings, events and audit records.

Global events/audit rows remain possible only when no scoped execution, context package or agent is referenced.

### Embedding contract

- Each vector dimension equals `embedding_profiles.dimensions`.
- A profile dimension cannot change after an embedding exists.
- Embedding validation takes a row-level `FOR SHARE` lock, serializing it with concurrent profile dimension updates.

### Concurrency and immutability

- Mutable aggregates increment `version` and refresh `updated_at` on every update.
- Conditional updates with an expected version provide optimistic locking.
- Context packages, their items, events, audit rows and path history reject application `UPDATE`/`DELETE`.

### Idempotency

- Business operations can claim `(project_id, scope, idempotency_key)` once.
- Project/global event idempotency keys are unique in their respective scopes.
- Migration names/checksums are persistent and repeat execution is a no-op.

## Deferred

- Historical entity revision tables; `version` is a concurrency token, not a snapshot store.
- ANN indexes and tombstone-specific ANN maintenance.
- Semantic JSON Schema validation inside PostgreSQL.
- DBA-proof immutability; database owners retain DDL/TRUNCATE authority.
