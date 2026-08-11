# FORGE MCP Server 0.1.5

Local MCP `stdio` adapter for FORGE Persistence Gateway 0.1.

Status: implementation validated on PostgreSQL 18.4 with FORGE Schema 0.1.3,
pgvector 0.8.2 and the limited `forge_test_runner` role.

## Boundary

```text
MCP host
  -> JSON-RPC over stdio
  -> FORGE MCP Server
  -> FORGE Persistence Gateway
  -> PostgreSQL
```

This package owns protocol translation only. It contains no migrations, raw
domain SQL, project-specific names, agent-specific policy or embedded
credentials.

## Tools

| Tool | Purpose |
|---|---|
| `forge_status` | Verify runtime and schema compatibility |
| `forge_register_project` | Register/replay a generic project |
| `forge_register_agent` | Register/replay a generic agent |
| `forge_assign_agent` | Assign an agent within a project |
| `forge_create_task` | Create an idempotent task |
| `forge_update_task_status` | Update with optimistic locking |
| `forge_start_execution` | Start an idempotent execution |
| `forge_remember` | Persist memory and provenance |
| `forge_save_decision` | Persist a decision |
| `forge_compile_context` | Materialize immutable continuation context |
| `forge_load_context` | Reload context and report stale sources |
| `forge_finish_execution` | Finalize with optimistic locking |
| `forge_get_audit_trail` | Read ordered append-only audit records |
| `forge_get_project` | Recover a project by stable key |
| `forge_get_agent` | Recover an assigned agent by stable key |
| `forge_get_task` | Recover a project task by stable key |
| `forge_get_execution` | Recover a project execution by stable key |
| `forge_list_projects` | List projects with keyset pagination |
| `forge_list_tasks` | List/filter project tasks |
| `forge_list_executions` | List/filter project executions |
| `forge_list_memories` | List active memory summaries |
| `forge_list_decisions` | List decision summaries |
| `forge_register_embedding_profile` | Register/replay a stable vector profile |
| `forge_list_embedding_candidates` | Page through missing/stale sources for external embedding |
| `forge_put_embedding` | Store a precomputed, version-bound source vector |
| `forge_semantic_search` | Search one profile exactly within one project |
| `forge_get_semantic_candidate_texts` | Load bounded, version-bound candidate text within one project |

All UUID fields are validated; stable keys are trimmed and bounded. Unknown
fields are rejected. Retryable writes expose mandatory idempotency keys and
state transitions expose mandatory expected versions. Catalog pages contain at
most 100 rows and return a cursor that must be reused unchanged. Memory and
decision catalogs intentionally omit their large body fields.
Vectors contain at most 4096 finite numbers and must match their profile.
Candidate pages contain at most 50 sources and separately bound source text.
FORGE does not call a provider or infer embeddings; the caller computes vectors
externally and submits each candidate's current source version.

## Setup

Requires Node.js 20+, the migrated FORGE database and the dedicated runtime role.

```powershell
npm ci
npm run build
$env:FORGE_DATABASE_URL = 'postgresql://forge_test_runner:password@127.0.0.1:5432/forge_test'
npm start
```

The deployable tarball can be installed independently:

```powershell
npm install .\forge-mcp-server-0.1.5.tgz
```

It bundles the compiled Gateway dependency while keeping the MCP SDK, Zod and
database driver under normal npm dependency management.

Do not commit the connection string. A real MCP host should inject
`FORGE_DATABASE_URL` from its local secret mechanism. The server never writes
the value to stdout, stderr or MCP results.

The host launches:

```text
command: node
args: <absolute-path>/dist/stdio.js
environment: FORGE_DATABASE_URL
```

Stdout is reserved exclusively for MCP JSON-RPC. Operational messages use
stderr.

### Codex on Windows

The included Codex launcher uses Windows DPAPI (`CurrentUser`) instead of
storing the PostgreSQL password in `~/.codex/config.toml` or an environment
variable. Configure and validate the credential interactively:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-codex-secret.ps1
```

Register the compiled launcher with the absolute paths for the local checkout:

```powershell
codex mcp add forge -- "C:\Program Files\nodejs\node.exe" "<package-root>\dist\codex.js"
```

Restart Codex after registration. `scripts/check-codex-registration.mjs`
performs an end-to-end check of the same launcher without printing the secret.

## Validation

Fast contract tests:

```powershell
npm test
```

Native PostgreSQL and spawned-process validation on Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-native.ps1
```

The native script asks for the `forge_test_runner` password through a hidden
prompt, holds it only in process memory, and runs the complete test suite.

See `docs/ARCHITECTURE.md`, `docs/VALIDATION.md` and
`docs/IMPLEMENTATION_FINDINGS.md`.
