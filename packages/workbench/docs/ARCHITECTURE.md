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

The current vertical slice deliberately limits catalogs to their first bounded
page. Task creation is idempotent and status changes carry the last observed
version, so a stale browser cannot silently overwrite a concurrent agent
transition. Execution history remains read-only in Workbench; agents own their
execution lifecycle through MCP. Cursor navigation, context-package inspection
and assignment controls remain product increments, not reasons to weaken the
existing core contracts.
