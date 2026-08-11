# Test Strategy

Status: implemented.

## Coverage matrix

| Critical behavior | Test level |
|---|---|
| Indexed response order follows provider `index` | HTTP adapter unit |
| API key is sent but never emitted | HTTP adapter + native child process |
| Remote HTTP is rejected | Security unit |
| `429`/`Retry-After` and transient retry | Adapter/worker unit |
| Permanent invalid response fails closed | Adapter/worker validation |
| Page bounds and deterministic continuation | Worker unit |
| Stable SHA-256 idempotency keys | Worker unit |
| Restart becomes no-op for current vectors | Worker unit + native integration |
| Truncation policy is explicit | Worker unit |
| Provider/model input prefix is applied and profile-bound | Worker unit |
| Source-version race is skipped safely | Worker unit |
| Real Gateway/pgvector persistence and search | Native integration |
| CLI process/config/stdout boundary | Native child-process integration |

## Pyramid

- Unit: provider parsing/security, retry mechanics and worker orchestration.
- Integration: real HTTP server, compiled CLI child, limited PostgreSQL role,
  Gateway, Schema 0.1.3 and pgvector.
- Live-provider smoke: LM Studio + Nomic Embed Text v1.5 validates the real
  compatible endpoint and 768-dimensional finite output without credentials.

## Deferred gaps

- provider-specific tokenization and maximum-token preflight;
- `evaluation/corpus-v2.json` now covers 30 facts and 60 bilingual queries with
  fixed top-1/top-3/MRR, isolation and staleness gates. Qwen 0.6B currently
  fails the top-1/MRR gates; this remains a release blocker, not a waived test.
- multi-worker chaos and rate-limit load tests;
- live provider latency/cost telemetry.
