# Validation

Date: 2026-08-11
Status: passed; live-provider smoke completed.

## Runtime

- Node.js: 24.15.0
- TypeScript: 5.9.3 strict
- PostgreSQL: 18.4
- FORGE Schema: 0.1.3
- Gateway: 0.1.4
- pgvector: 0.8.2
- Database role: `forge_test_runner`

## Results

| Layer | Result |
|---|---:|
| Strict production build | Pass |
| Provider/worker/continuous unit tests | 12/12 pass |
| Native HTTP + CLI + PostgreSQL integration | 1/1 pass |
| LM Studio compatible endpoint | Pass |
| Live FORGE Core indexing | 17/17 current sources per profile |
| Controlled multilingual corpus | 6 facts, 12 queries/model |
| Qwen3 top-1 / MRR | ES 6/6, 1.0; EN 6/6, 1.0 |
| Nomic top-1 / MRR | ES 5/6, 0.875; EN 6/6, 1.0 |
| Replay/idempotency | 0 candidates, 0 provider calls |
| Cross-project live query | 0 leaked results |
| Clean TGZ install/import | Pass |
| Final TGZ operational script allowlist | Pass |
| Dependency audit | 0 vulnerabilities |
| Invisible Windows logon/minute task | Manual + automatic run; exit 0; next run scheduled |
| Automatic new-memory indexing | 1 discovered, 1 embedded, 1 provider call |
| Post-index text retrieval | Probe memory top-1, score 0.7485, current |
| Semantic Evaluation v2 baseline | FAIL: top-1 83.33%, top-3 98.33%, MRR 0.9028 |
| Isolation / stale gates v2 | PASS: 0 leaks, 0 stale |
| Specific-instruction experiment | Rejected: 81.67%, 96.67%, MRR 0.8861 |
| Qwen3 Embedding 4B Q4_K_M | Rejected: top-1 86.67%, top-3 96.67%, MRR 0.9167 |
| 0.6B + Qwen3.5 9B reranker top-5 | Pass: top-1 90%, recall 98.33%, 0 errors |
| Reranker latency | mean 622 ms; p50 615 ms; p95 675 ms |

The native test launches the compiled CLI as a child process, calls a real
loopback HTTP server using the compatible embeddings JSON contract, persists a
3-dimensional memory vector through the limited role, verifies semantic search,
replaces both Gateway and worker process, and proves the second run makes no
provider request.

The fake API key and database connection are absent from CLI stdout/stderr. The
real database credential is decrypted from the existing DPAPI `CurrentUser`
store only into process memory.

## Live providers

LM Studio served `text-embedding-nomic-embed-text-v1.5` on loopback. The worker
registered profile `nomic-embed-text-v1.5-q4-k-m-768-search-v1`, applied the
required `search_document:` prefix and produced finite 768-dimensional vectors.

LM Studio also served the official Qwen3 Embedding 0.6B Q8_0 GGUF (639,150,592
bytes) as `text-embedding-qwen3-embedding-0.6b`. It produced finite
1024-dimensional vectors with a 32K model context. Worker 0.1.2 registered the
query instruction as immutable profile metadata. Both profiles indexed all 17
current FORGE Core sources and replayed with zero pending candidates/provider
calls.

Worker 0.1.6 was registered as `FORGE Embedding Worker` for the current Windows
user. A newly persisted probe memory was detected on the next cycle,
embedded once, and returned top-1 by the live semantic bridge. Atomic health is
available at `%APPDATA%\FORGE\embedding-worker-status.json`. A live regression
also found Task Scheduler's default battery-stop policy and managed-session
termination of long-lived children. Windows now runs bounded one-shot cycles
every minute; two consecutive scheduled executions exited with code zero.
The task action now uses packaged `run-qwen-hidden.vbs` through `wscript.exe`,
preventing a console flash while preserving the limited interactive identity
required by the existing DPAPI credential.

The controlled comparison used six distinct English facts and matching Spanish
and English queries. Qwen ranked every expected fact first in both languages.
Nomic missed one Spanish project-isolation query but ranked every English query
first. Qwen is therefore the recommended multilingual profile; Nomic remains
the lightweight English/integration baseline. An unrelated project returned no
results for either profile.

## Semantic Evaluation v2

The versioned regression expands coverage to 30 closely related FORGE facts and
60 Spanish/English queries. The operational profile passes top-3, project
isolation and staleness gates, but fails the unchanged 90% top-1 and 0.94 MRR
gates. Production acceptance is therefore blocked pending measured reranking or
a larger embedding profile. The benchmark and both experiment reports ship in
`evaluation/`.

Qwen3 Embedding 4B Q4_K_M (2.50 GB, 2560 dimensions) improved top-1 but
regressed top-3 and still failed the gate. A generative Qwen3.5 9B reranker,
already present locally, reranked the 0.6B profile's top five candidates and met
the 90% gate with no parser, isolation or staleness failures. Its ~622 ms mean
latency and 9.73 GiB loaded footprint make it an optional precision stage, not
a replacement for default fast retrieval.
