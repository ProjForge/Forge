# FORGE — PostgreSQL Schema 0.1.2

Status: validated implementation candidate
Date: 2026-08-10
Supersedes: `FORGE-PostgreSQL-Schema-0.1.1`

## Scope

Schema 0.1.2 preserves every 0.1.1 table and invariant. It adds one minimal
security correction required by native least-privilege vector insertion.

## Change

Migration `0006_forge_schema_0_1_2.sql` recreates
`forge.validate_embedding_dimensions()` as a locked-down `SECURITY DEFINER`
function. The trigger retains its `FOR SHARE` profile lock, but callers no
longer require profile `UPDATE` permission merely to insert an embedding.

Security properties:

- fixed `search_path = pg_catalog, pg_temp`;
- every FORGE object and `public.vector_dims` is schema-qualified;
- execution revoked from `PUBLIC`;
- no dynamic SQL;
- no new table or write privilege.

## Runtime contract

The generic application role receives:

- `SELECT` on documents, chunks, embedding profiles and embeddings;
- `INSERT` on embedding profiles and embeddings;
- no `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER` privilege on
  vector tables.

Embeddings remain heterogeneous by registered profile, dimension checked,
project/source scoped and suitable for exact retrieval. ANN indexing remains
deferred until a dimension/profile-specific workload justifies it.

## Validation

- checksum-aware migration and idempotent rerun: pass;
- embedded PostgreSQL regression: 9/9 pass;
- native runtime privilege contract: pass;
- Gateway semantic integration: pass;
- spawned MCP semantic search after process replacement: pass;
- physical PostgreSQL 18 service restart followed by runtime/Gateway/MCP
  regression: pass;
- PostgreSQL 18.4 + pgvector 0.8.2 persistence: pass.
