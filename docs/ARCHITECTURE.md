# FORGE architecture

## Goal

FORGE provides durable, project-scoped memory for agents and humans without
coupling database truth to a model provider or client transport.

## Boundaries

```text
Clients
├── MCP Server ───────────────┐
└── Local Workbench ──────────┼── Persistence Gateway ── PostgreSQL
             └── Semantic Bridge ┘             └──────── pgvector (optional)
                       │
Embedding Worker ──────┴── External model providers
Resilience CLI ───────────── PostgreSQL ⇄ encrypted recovery package
```

- **Schema** owns relational truth and invariants.
- **Gateway** owns typed transactions and persistence workflows.
- **MCP Server** is a strict transport adapter; it owns no domain SQL.
- **Embedding Worker** discovers bounded candidates and writes immutable vectors.
- **Semantic Bridge** converts natural-language queries to provider-independent
  vector searches and optionally reranks hydrated candidates.
- **Workbench** is a loopback-only human client behind a token-protected local
  HTTP boundary.
- **Resilience** creates authenticated, encrypted logical recovery packages and
  restores them transactionally into an empty compatible PostgreSQL database.
  Its policy runner verifies replicas before retention; cluster-level scripts
  separately exercise PostgreSQL base backups and WAL point-in-time recovery.

## Core invariants

- Managed document identity is immutable while managed.
- Relational references and semantic reads cannot cross projects.
- Mutable updates use optimistic locking.
- Context packages, events, audit rows and embeddings are append-only for
  application DML.
- Embeddings match their registered profile dimensions and active source version.
- Migrations are transactional, checksum-verified and idempotent.
- Core never calls an embedding or reranking provider.
- Recovery never overwrites a non-empty target and verifies migrations and
  snapshot table counts after restore.
- Retention runs only after every configured replica authenticates successfully;
  malformed or foreign files are not deletion candidates.

## Trust boundaries

PostgreSQL is trusted persistent state. MCP and Workbench inputs are untrusted
and validated before Gateway calls. Provider output is untrusted external data.
The local Workbench is not an authenticated remote multi-user service.

## Decisions

Architecturally durable choices are recorded under [`docs/decisions`](decisions/).
