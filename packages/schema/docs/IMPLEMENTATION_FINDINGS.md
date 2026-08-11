# FORGE Schema 0.1.3 — Implementation Findings

Date: 2026-08-08

## IMP-SQL-01 — Reserved identifier blocked the core migration

Status: fixed and regression-tested

`authorization` produced PostgreSQL error `42601` because it is a SQL keyword in this grammar position.

Minimal correction:

```text
audit_log.authorization
→ audit_log.authorization_decision
```

Quoting the identifier was rejected because it would impose permanent quoting on every query.

## IMP-SQL-02 — Dimension guard needed concurrency serialization

Status: fixed and validated with two native PostgreSQL connections

The proposed dimension validator read `embedding_profiles.dimensions` without a row lock. A concurrent profile update and embedding insert could each observe a state that made the operation look valid, then commit an inconsistent pair.

Minimal correction: the embedding trigger now reads the profile `FOR SHARE`. A concurrent dimension update waits; once the insert commits, the profile guard observes the embedding and rejects the dimension change.

The two-connection regression test passed on native PostgreSQL 18.4. It cannot run in PGlite because PGlite is single-connection.

## IMP-TEST-03 — Error assertions depended on the server locale

Status: fixed and regression-tested

The first native run stopped even though the database correctly rejected an invalid row. The test expected an English error message while PostgreSQL returned its localized Spanish equivalent.

Minimal correction: constraint failures are normalized by stable SQLSTATE codes and constraint names:

```text
23503 — foreign key violation
23505 — unique violation
23514 — check violation
```

The same suite now passes under both the embedded English runtime and native Spanish PostgreSQL.

## ENV-01 — No local PostgreSQL/Docker runtime

Status: resolved

The host initially had no PostgreSQL server or container runtime. PostgreSQL 18.4 was later installed, and pgvector 0.8.2 was compiled from the official source for that installation.

The native server suite, two-connection concurrency test and Windows service restart verification all passed. Docker remains optional and is not required for the validated PostgreSQL 14+ target.

## IMP-SEC-04 — `FOR SHARE` made the trigger require invoker UPDATE privilege

Status: fixed in migration 0006 and native regression-tested

The embedding-dimension trigger correctly locks its profile row `FOR SHARE` to
serialize dimension changes. PostgreSQL also requires `UPDATE` privilege for a
locking `SELECT`, so a least-privilege role with profile `SELECT` and embedding
`INSERT` failed with SQLSTATE `42501`.

Granting profile `UPDATE` would violate the intended runtime boundary. The
minimal correction recreates only `forge.validate_embedding_dimensions()` as
`SECURITY DEFINER`, fixes `search_path` to `pg_catalog, pg_temp`, fully
qualifies schema objects and `public.vector_dims`, and revokes public function
execution. The original row-locking behavior is retained. Native Gateway and
MCP vector flows now pass while runtime profile update/delete stays denied.

## IMP-SQL-05 — Source-only uniqueness contradicted append-only reindexing

Status: fixed in migration 0007 and native regression-tested

The 0.1.2 partial indexes allowed only one embedding per profile/source. After
a source version changed, its old vector correctly became stale, but inserting
the replacement conflicted with the old row. Updating or deleting it would
weaken the immutable-history boundary.

Migration 0007 adds a required positive `source_version`, safely backfills
legacy rows from validated metadata or the current source, and changes the
partial unique indexes to include that version. A locked-down source validator
accepts only the active current version at insert time. Embedding rows now use
the existing append-only guard. Embedded and native tests prove legacy
backfill, version history, stale-write rejection and mutation denial.
