# Validation

Status: passed

Date: 2026-08-11

## Runtime

- PostgreSQL: 18.4
- FORGE schema: 0.1.3
- pgvector: 0.8.2
- Database role: `forge_test_runner`
- Node.js: 24.15.0
- TypeScript: 5.9.3 strict
- MCP SDK: 1.30.0 stable
- Zod: 4.4.3

## Results

| Layer | Result |
|---|---:|
| Strict production build | Pass |
| In-memory MCP contract tests | 7/7 pass |
| Native spawned stdio continuity | 1/1 pass |
| Codex DPAPI launcher | Pass |
| Codex global MCP registration | Enabled |
| Tool discovery | 27/27 tools |
| Standalone tarball clean install/import | Pass |
| npm dependency audit | 0 vulnerabilities |

## In-memory coverage

- exact tool names and safety annotations;
- Zod rejection before Gateway invocation;
- typed call forwarding and structured results;
- catalog filter/cursor forwarding and limit rejection;
- embedding candidate/profile/write/search forwarding and boundary rejection;
- ordered, version-bound candidate-text hydration and boundary rejection;
- stable domain error propagation;
- sanitization of unexpected failures.

## Native stdio coverage

The official MCP client spawned `dist/stdio.js` as a child process and:

- completed protocol initialization and tool discovery;
- verified schema/runtime readiness;
- registered a project and agent and assigned them;
- created and versioned a task;
- started an execution;
- persisted memory with provenance and a decision;
- compiled an immutable continuation package;
- terminated and replaced the MCP server process;
- recovered project, assigned agent, task and execution through stable-key
  read tools after process replacement;
- listed filtered projects, tasks, executions, active-memory summaries and
  decision summaries after process replacement;
- confirmed project isolation and omission of full memory/decision bodies;
- replayed an idempotent task request;
- reloaded the same package and content;
- finalized the execution and read its ordered audit trail.
- registered/replayed a stable embedding profile;
- stored version-bound memory and decision vectors and rejected invalid input;
- replaced the process, searched again and preserved deterministic ranking;
- confirmed semantic project isolation and embedding audit records.
- paged missing/stale candidates before indexing and verified indexed current
  versions disappeared after process replacement.
- hydrated the ranked memory/decision texts in order through the native stdio
  process while retaining project and version scope.

The run used the limited PostgreSQL role. The password was supplied through a
hidden interactive prompt and was not persisted.

## Codex host validation

The Windows-specific `dist/codex.js` launcher was tested through the official
MCP client after encrypting the runtime-role password with DPAPI `CurrentUser`.
It discovered all 27 tools and `forge_status` reported schema `0.1.3`.

Codex CLI then registered the server globally as `forge`. A post-registration
inspection confirmed it is enabled, uses stdio with the absolute Node/launcher
paths, and contains no environment variables or plaintext credential.

## Packaging validation

The generated `forge-mcp-server-0.1.5.tgz` was installed into an empty
directory. npm resolved the bundled Gateway and normal external dependencies,
`npm ls` accepted the exact Gateway 0.1.5 dependency, and Node successfully
imported the public `createForgeMcpServer` factory. The bundled Gateway exposes
all five catalog methods and all five semantic methods.
