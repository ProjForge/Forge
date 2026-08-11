# Architecture

## Requirements and assumptions

Functional requirements:

- consume bounded missing/stale FORGE candidates;
- obtain vectors from a replaceable external provider;
- persist current source-version embeddings idempotently;
- resume after provider, worker or host interruption.

Non-functional requirements:

- no plaintext secret persistence or provider coupling in FORGE Core;
- deterministic behavior, project isolation and bounded memory/network work;
- PostgreSQL remains the source of progress truth;
- a single worker is sufficient now; concurrent workers must remain safe.

Current scale assumption: at most 50 inputs per provider request and 100
candidates per cycle. Latency is provider-dominated. Continuous polling reuses
database candidate truth and requires no queue or durable daemon state.

## Components and data flow

```text
Scheduler / operator / continuous loop
        |
        v
Embedding Worker CLI
  |  register/replay profile
  |  list bounded candidates + cursor
  v
FORGE Persistence Gateway ---> PostgreSQL / pgvector
        ^                            |
        | version-bound put          | current source/version invariant
        |                            |
Embedding Provider Adapter ---------+
        |
        v
HTTPS /v1/embeddings-compatible provider
```

One page is fetched, optionally filtered by explicit truncation policy, given
an explicit model input prefix when configured, embedded as one batch and
written sequentially. The next page begins only after every accepted item has a
successful idempotent write or a classified source-version race.

## Reliability

- Idempotency keys are SHA-256 over profile, source kind/ID/version and input
  hash; they contain no source text.
- Provider/model input transforms are recorded in immutable profile metadata;
  changing a prefix requires a new profile key and cannot silently mix spaces.
- Provider retries use bounded exponential backoff with jitter and honor
  `Retry-After`.
- Only transient provider/network classes retry automatically. Invalid vectors
  and permanent HTTP errors fail closed.
- A source mutation between discovery and write becomes
  `OPTIMISTIC_LOCK_FAILED`; the worker counts it and a later scan discovers the
  new version.
- PostgreSQL is the durable checkpoint. Starting from the beginning is safe;
  explicit cursors are returned only to reduce repeated scans after a bounded
  stop.
- Sequential database writes favor clear failure recovery over maximum
  throughput. Provider calls remain batched.
- Continuous mode polls after complete cycles, drains incomplete bounded work
  promptly, and delays/retries failed provider cycles without exiting.
- The Windows task runs one bounded cycle at logon and every minute with limited
  privileges, supports battery use and records only sanitized atomic health JSON.
  This deliberately avoids a fragile long-lived desktop child process.

## Security

- Database URLs and provider keys enter through environment variables and are
  never returned or logged.
- Provider response bodies are not included in HTTP errors.
- Remote provider endpoints require HTTPS; HTTP is loopback-only.
- The worker uses the existing least-privilege Gateway role and adds no SQL.
- Project scope is mandatory on candidate reads and vector writes.
- Response indexes, counts, dimensions and finite values are validated before
  persistence.

## Trade-offs and growth triggers

- Stateless execution avoids a new job table/queue. One-shot callers may use a
  cursor; continuous mode safely rescans because indexed versions disappear.
- Prefix embedding for text over `maxTextChars` preserves progress and is marked
  in metadata; strict callers can reject it. True long-document chunking remains
  a source-ingestion concern.
- The adapter uses standard `fetch` instead of a provider SDK, reducing
  dependencies but requiring explicit response validation.
- Direct Gateway use keeps the worker local and typed. A remote deployment
  should use an authenticated service boundary rather than exposing PostgreSQL.

Revisit when measured throughput requires parallel puts, provider batch jobs,
distributed leases, durable job state, rate-limit telemetry or ANN retrieval.
