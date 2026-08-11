# FORGE Semantic Bridge 0.1.4

External adapter that turns natural-language queries into vectors and delegates
project-scoped retrieval to the generic FORGE Gateway. It adds one MCP tool:
`forge_search_text`.

Fast semantic retrieval remains the default. Pass `rerank: true` to hydrate the
version-bound top five and promote the candidate selected by the optional
external precision model.
Scores remain embedding-similarity scores even when precision mode changes the
result order.

Required environment variables:

- `FORGE_DATABASE_URL`
- `FORGE_EMBEDDING_BASE_URL`
- `FORGE_EMBEDDING_MODEL`
- `FORGE_EMBEDDING_PROFILE_KEY`
- `FORGE_EMBEDDING_DIMENSIONS`

Optional: `FORGE_EMBEDDING_QUERY_PREFIX`, `FORGE_EMBEDDING_API_KEY`,
`FORGE_EMBEDDING_TIMEOUT_MS`, and `FORGE_EMBEDDING_SEND_DIMENSIONS=false`.

Optional reranking is enabled when `FORGE_RERANKER_MODEL` is set. Its base URL
defaults to the embedding base URL. Additional settings are
`FORGE_RERANKER_BASE_URL`, `FORGE_RERANKER_API_KEY`,
`FORGE_RERANKER_TIMEOUT_MS`, `FORGE_RERANKER_CANDIDATES` (2–5) and
`FORGE_RERANKER_MAX_TEXT_CHARS` (maximum 32,000).

For the validated local Qwen profile use LM Studio at
`http://127.0.0.1:1234/v1`, model `text-embedding-qwen3-embedding-0.6b`,
profile `qwen3-embedding-0.6b-q8-1024-forge-retrieval-v1`, and 1024 dimensions.
Load the optional reranker with a bounded inference configuration:

```powershell
lms load qwen/qwen3.5-9b --identifier forge-reranker-qwen35-9b --context-length 4096 --parallel 1 --gpu max
```

LM Studio's observed defaults (262,144 context tokens and parallelism 4) exceed
the 30-second precision budget on the validated machine.

The bridge is read-only with respect to FORGE. Provider credentials are read
from the process environment and never logged.

The `forge-semantic-bridge/workbench` subpath exposes composition, configuration,
reranking, Gateway and the compatible embedding provider without loading MCP
transport dependencies. Local clients can therefore reuse the validated stack
without depending on bundled implementation packages directly.

The Windows `dist/codex.js` launcher reuses the existing CurrentUser DPAPI
credential and constructs the PostgreSQL connection string only in memory.
