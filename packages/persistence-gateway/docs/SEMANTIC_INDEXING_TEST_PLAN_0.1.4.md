# Semantic Indexing 0.1.4 — Test Strategy

Status: implemented and passed on embedded and native PostgreSQL paths.

## Critical behaviors

| Behavior | Protection |
|---|---|
| Legacy embeddings migrate safely | `source_version` backfill regression |
| Same source/version cannot conflict silently | versioned unique indexes + replay checks |
| A later source version appends history | schema and Gateway integration tests |
| Discovery/write race fails closed | locked current-version validation |
| Embedding rows cannot mutate | append-only trigger regression |
| Candidate ordering and cursors are stable | pagination with one-item pages |
| Work is bounded | page and text caps at transport/application boundaries |
| Indexed current versions disappear | candidate-to-write integration flow |
| Interrupted work resumes after replacement | persisted cursor/input-hash recovery test |
| Project data never leaks | negative cross-project candidate/search tests |

## Test pyramid

- Unit: strict inputs, forwarding, finite vector and bound rejection.
- Embedded integration: migrations, legacy backfill, immutable history and restart.
- Native integration: least-privilege PostgreSQL, MCP process replacement and
  physical database service restart.
- Packaging: clean tarball install/import and dependency audit.

## Deferred evidence

Provider-specific embedding quality, high-volume ANN performance and
multi-worker chaos testing remain outside this provider-agnostic release.
