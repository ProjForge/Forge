# FORGE Embedding Worker 0.1.6

External, bounded semantic-indexing worker for FORGE Gateway 0.1.4 and Schema
0.1.3.

Status: implementation validated on PostgreSQL 18.4, pgvector 0.8.2 and the
least-privilege `forge_test_runner` role. The HTTP provider contract was tested
through a real local child-process boundary and LM Studio with Nomic Embed Text
v1.5 and Qwen3 Embedding 0.6B; no provider credential is required or stored for
the local endpoint.

## Boundary

The worker:

- registers/replays one stable embedding profile;
- pages missing/stale candidates deterministically;
- batches at most 50 texts per provider request;
- validates item order, dimensions, finite values and cosine zero vectors;
- retries only retryable provider failures (`408`, `429`, `5xx`, timeouts and
  network failures);
- derives persistent idempotency keys from profile/source/version/input hash;
- stores vectors through the typed Gateway;
- returns a continuation cursor when a bounded run stops early.

It does not add migrations, call MCP, own provider credentials, run a daemon or
  silently downgrade HTTPS. Plain HTTP is accepted only for loopback development
and tests.

## Setup

```powershell
npm ci
npm run build
npm test
```

Configure secrets only in the process environment:

```powershell
$env:FORGE_DATABASE_URL = 'postgresql://runtime-role:password@127.0.0.1:5432/forge_test'
$env:FORGE_PROJECT_ID = '<project UUID>'
$env:FORGE_EMBEDDING_PROFILE_KEY = 'knowledge-embedding-v1'
$env:FORGE_EMBEDDING_MODEL = '<embedding model>'
$env:FORGE_EMBEDDING_DIMENSIONS = '<model output dimensions>'
$env:FORGE_EMBEDDING_API_KEY = '<provider API key>'
npm start
```

Recommended multilingual LM Studio profile:

```powershell
$env:FORGE_EMBEDDING_BASE_URL = 'http://127.0.0.1:1234/v1'
$env:FORGE_EMBEDDING_PROFILE_KEY = 'qwen3-embedding-0.6b-q8-1024-forge-retrieval-v1'
$env:FORGE_EMBEDDING_MODEL = 'text-embedding-qwen3-embedding-0.6b'
$env:FORGE_EMBEDDING_DIMENSIONS = '1024'
$env:FORGE_EMBEDDING_QUERY_PREFIX = "Instruct: Given a user question about a software project, retrieve the most relevant project decision or memory that answers the question`nQuery:"
```

For a retrieval smoke, reuse the same profile and set the model's query-side
prefix:

```powershell
$env:FORGE_EMBEDDING_QUERY_PREFIX = 'search_query:'
$env:FORGE_EMBEDDING_QUERY = 'Which PostgreSQL version was validated?'
npm run smoke:live-query
```

Default provider URL: `https://api.openai.com/v1`. A compatible endpoint may be
selected with `FORGE_EMBEDDING_BASE_URL`. The adapter follows the current
[official OpenAI embeddings request/response contract](https://developers.openai.com/api/reference/resources/embeddings/methods/create): batched string input, indexed float vectors and optional requested dimensions.

## Configuration

| Variable | Default | Bounds/purpose |
|---|---|---|
| `FORGE_DATABASE_URL` | required | Runtime PostgreSQL connection; never logged |
| `FORGE_PROJECT_ID` | required | Project isolation boundary |
| `FORGE_EMBEDDING_PROFILE_KEY` | required | Stable vector-space identity |
| `FORGE_EMBEDDING_MODEL` | required | Provider model identifier |
| `FORGE_EMBEDDING_DIMENSIONS` | required | `1..4096` |
| `FORGE_EMBEDDING_BASE_URL` | OpenAI API | HTTPS or loopback HTTP |
| `FORGE_EMBEDDING_API_KEY` | required for OpenAI | Optional for local compatible servers |
| `FORGE_EMBEDDING_SOURCE_KINDS` | all | Comma-separated supported kinds |
| `FORGE_EMBEDDING_PAGE_SIZE` | `20` | `1..50` |
| `FORGE_EMBEDDING_MAX_CANDIDATES` | `100` | `1..10000` per run |
| `FORGE_EMBEDDING_MAX_TEXT_CHARS` | `8000` | `1..32000` |
| `FORGE_EMBEDDING_INPUT_PREFIX` | unset | Optional provider/model document prefix |
| `FORGE_EMBEDDING_QUERY_PREFIX` | unset | Optional query transform stored in profile metadata |
| `FORGE_EMBEDDING_REJECT_TRUNCATED` | `false` | Fail-safe opt-out of prefix embeddings |
| `FORGE_EMBEDDING_MAX_ATTEMPTS` | `4` | Provider attempts `1..10` |
| `FORGE_EMBEDDING_CURSOR_KIND/ID` | unset | Resume a returned checkpoint |
| `FORGE_EMBEDDING_CONTINUOUS` | `false` | Poll continuously instead of exiting |
| `FORGE_EMBEDDING_POLL_INTERVAL_MS` | `30000` | Idle polling interval |
| `FORGE_EMBEDDING_ERROR_DELAY_MS` | `15000` | Delay after a failed cycle |
| `FORGE_EMBEDDING_STATUS_FILE` | unset | Atomic JSON health/status snapshot |

On Windows, `scripts/register-windows-task.ps1` registers the validated local
Qwen profile at user logon and every minute. Each invocation is a bounded,
idempotent one-shot, avoiding fragile long-lived desktop processes. It reuses
the CurrentUser DPAPI credential and runs with limited privileges. The last cycle is written to
`%APPDATA%\FORGE\embedding-worker-status.json`.

The CLI writes one JSON result to stdout and sanitized errors to stderr. A run
can safely restart from the beginning: completed current versions no longer
appear as candidates, and deterministic write keys make races replay-safe.
Document and query transforms are profile metadata and therefore part of the
immutable vector-space contract. Change `FORGE_EMBEDDING_PROFILE_KEY` when
changing the model, quantization, dimensions or either transform.

See `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md` and `docs/VALIDATION.md`.
