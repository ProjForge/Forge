# Architecture

## Objective

Expose the validated FORGE persistence use cases to local MCP hosts without
moving protocol concerns into the Gateway or database schema.

## Components

```text
MCP client/host
    |
    | MCP JSON-RPC over stdin/stdout
    v
stdio.ts
    |
    v
server.ts -- Zod input contracts, tool annotations, error translation
    |
    v
ForgePersistenceGateway -- transactions and use cases
    |
    v
FORGE PostgreSQL Schema 0.1.3 -- relational and versioned-vector invariants
```

## Decisions

- MCP is a separate package and depends on the packaged Gateway.
- The first transport is `stdio`: local, process-scoped and free of network
  authentication/CORS concerns.
- All 26 public Gateway workflows are exposed as tools, including five bounded
  operational catalogs and four provider-agnostic semantic workflows.
- Context loading remains a tool in 0.1. Read-only MCP resources can be added
  later when URI discovery and authorization semantics are defined.
- Input validation belongs at the transport boundary; relational truth remains
  in PostgreSQL.
- Expected domain errors preserve their stable Gateway codes. Unexpected errors
  return `INTERNAL_ERROR` without database detail.
- Stdout is protocol-only. Diagnostics go to stderr.

## Lifecycle

The stdio entrypoint validates schema readiness before accepting MCP calls. It
closes the MCP server and PostgreSQL pool when stdin ends or the process receives
`SIGINT`/`SIGTERM`.

## Security

- No connection string in source, documentation examples with real values, logs
  or MCP results.
- The runtime uses `forge_test_runner`, not `postgres`.
- Zod schemas reject unknown properties and bound large text/array inputs.
- Tools declare read-only, destructive and idempotency hints.
- Project IDs remain mandatory on every scoped operation.
- Catalogs use deterministic keyset cursors; summary tools omit large body
  fields.
- Vector schemas reject unknown fields, non-finite/oversized inputs and missing
  source versions before the Gateway call.

## Semantic boundary

The MCP server never invokes an embedding model. It returns bounded,
deterministically paged missing/stale candidates, accepts vectors computed by
the caller, forwards stable profile definitions and source-version tokens, and
returns bounded semantic summaries. Project isolation, profile dimensions,
source validity, immutable vector history, stale filtering and ranking remain
owned by the Gateway/database layers.

## Trade-offs

`stdio` is the smallest safe first transport but creates one server process per
host connection and is not remotely accessible. A later remote service should
use Streamable HTTP with explicit authentication, authorization, origin/host
validation, rate limits and observability; none of those concerns are implied by
this local release.
