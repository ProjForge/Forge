# Architecture

```text
Browser on loopback
  -> token-protected local HTTP API
  -> Workbench service
     -> Persistence Gateway 0.1.5
     -> Semantic Bridge 0.1.4 `/workbench` facade
        -> LM Studio providers
  -> PostgreSQL FORGE Schema 0.1.3
```

The browser owns presentation and per-action idempotency keys. The server owns
validation and the local security boundary. Domain writes remain in Gateway;
query embedding and optional reranking remain in Semantic Bridge. Workbench
contains no schema migrations, provider implementation, raw SQL or persistent
secret storage.

The 0.1.0 vertical slice deliberately limits catalogs to their first bounded
page. Cursor navigation and richer task/execution views are product increments,
not reasons to weaken the existing core contracts.
