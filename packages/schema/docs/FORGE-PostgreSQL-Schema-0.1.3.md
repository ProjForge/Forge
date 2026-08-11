# FORGE — PostgreSQL Schema 0.1.3

Version: 0.1.3
Status: implementation validated
Supersedes: 0.1.2
Database: PostgreSQL 14+
Optional vector layer: pgvector

## Purpose

Schema 0.1.3 enables incremental semantic reindexing without overwriting or
deleting earlier embeddings. It makes the version represented by every vector
an explicit database invariant.

## Migration 0007

- Adds required positive `forge.embeddings.source_version`.
- Backfills legacy rows from a valid `metadata.forge_source_version`, otherwise
  from the source version present during migration.
- Replaces source-only unique indexes with
  `(profile_id, source_id, source_version)` partial unique indexes.
- Validates, under a source-row lock, that a new embedding targets an active
  source at its current version.
- Makes embedding rows append-only for application DML.
- Uses a `SECURITY DEFINER` validator with fixed `search_path`, qualified
  objects and no public execution privilege.

## Semantics

`source_version` identifies the mutable source state represented by a vector;
it does not create a full source snapshot. When a source changes, its old vector
remains historical and search excludes it by default. A new vector is inserted
for the new version. If the source changes between discovery and insertion, the
database rejects the stale write.

The vector layer remains optional: migration 0001 installs the relational core
without pgvector, while migrations 0002 and later are applied only where vector
workflows are required.

## Compatibility

The DDL avoids features newer than PostgreSQL 14. It has been executed and
restart-tested on PostgreSQL 18.4 with pgvector 0.8.2, and regression-tested on
embedded PostgreSQL 18.3/PGlite with pgvector 0.8.1.
