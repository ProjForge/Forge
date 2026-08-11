# Validation

Validated on 2026-08-11 with Node.js 20+, PostgreSQL 18.4, pgvector 0.8.2,
LM Studio and Qwen3 Embedding 0.6B Q8.

## Automated

- TypeScript production build: PASS
- Unit/MCP tests: 9/9 PASS
- npm audit: 0 vulnerabilities
- Clean tarball install and public-module import: PASS
- DPAPI-backed Codex launcher: PASS (1 tool, 2 live results)
- Global Codex MCP registration `forge-semantic`: enabled
- Post-restart Codex tool discovery and real `forge_search_text` call: PASS
- Corrected post-restart `rerank: true` call through the actual Codex MCP: PASS (1.6 s)
- Empty and 32,001-character query rejection: PASS
- Immutable query-prefix application: PASS
- Project/profile/vector forwarding: PASS
- Fast path remains unchanged unless `rerank: true`: PASS
- Ordered project/version-bound top-5 hydration: PASS
- Deterministic `reasoning_effort: none` reranker request: PASS
- Qwen `/no_think` prompt and 64-token completion budget: PASS
- Invalid reranker output and insecure remote HTTP rejection: PASS
- Live Qwen3.5 9B precision path through PostgreSQL + LM Studio: PASS
- DPAPI-backed MCP precision call: PASS

## Live

Query: `¿Qué modelo local de embeddings multilingüe recomendamos para FORGE y por qué?`

- Top-1: decision `4332fb0b-b868-4a05-9ad5-3783dfd1ead2`, score 0.6579
- Top-2: memory `a9fe66f8-dc4b-4722-b8fb-2212832f4642`, score 0.6434
- Both results were current (`stale=false`).
- Credential was decrypted from the existing CurrentUser DPAPI envelope and was
  neither printed nor persisted in plaintext.

## Live precision result

With `rerank: true`, vector similarity initially ranked the comparison memory
above the adoption decision (`0.6480` vs `0.6380`). Candidate text was hydrated
through Gateway 0.1.5 and Qwen3.5 9B promoted the more direct adoption decision
to top-1. The same call passed through the MCP/DPAPI launcher. Returned `score`
values remain vector scores; reranking changes order, not score semantics.

## Implementation finding

The first post-restart precision call reproduced `RERANKER_TIMEOUT`. The code
used a 16-token completion budget and LM Studio had loaded Qwen3.5 9B with a
262,144-token context and parallelism 4. The minimum reliable correction was a
64-token bounded completion, `/no_think`, and loading the model with context
4096, parallelism 1 and GPU offload. The same five-candidate PostgreSQL + LM
Studio query then passed within the existing 30-second provider timeout.
After rebuilding and restarting Codex, the same precision query passed through
the actual global MCP connection in 1.6 seconds and returned the adoption
decision first. This closes the host-reload validation gap.
