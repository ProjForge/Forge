# PROJECT_STATE

Updated: 2026-11-06
Status: PR #66 CI passed at f0206b2; limited-role import fixed and locally validated; updated CI pending

## Objective

Stabilize daily project memory, search, indexing and recoverability on Windows.
Include Linux/Obsidian when that separate machine becomes available.

## Stack

- Frontend: dependency-free local Workbench
- Backend/runtime: strict TypeScript, Node.js 20+, npm workspaces
- Database: PostgreSQL 14+; local live 18.4 with pgvector 0.8.2
- Providers: external embedding/reranking; Windows LM Studio
- Testing: Node runner, PGlite, native PostgreSQL and PowerShell fixtures

## Architecture

Schema owns invariants; Gateway owns transactions; MCP and loopback Workbench
compose it. External workers generate vectors. Encrypted logical backups and
physical WAL/PITR are separate recovery layers.

## Important Paths

- `packages/` — seven existing components
- `docs/guides/DAILY-OPERATIONS.md` — startup, acceptance and recovery activation
- `scripts/acceptance/` — isolated acceptance tools
- `docs/guides/AGENTIC-READINESS.md` — deployment verdict, evidence and agent-runtime limits

## Current Decisions

- Workbench uses the FORGE palette in light/dark themes; Auto follows the OS.
  Only the browser theme preference is persisted; project storage is unchanged.
- Workbench applies only the latest catalog/search/continuation response; changing
  project clears prior content, counts and agent choices before loading.
- Preserve independent Windows/Linux databases and the existing vector profile.
- Reuse the existing hidden, limited worker task for login startup and retries.
- Exclude authenticated WAL before applying the batch limit.
- Distinguish uploader execution, pending queue and PITR coverage.
- No core data migration or release publication in this work.
- FORGE provides agent memory/continuity; external hosts own dispatch, worker
  leases and caller authorization. Project scoping is not a per-caller ACL.
- Portable imports serialize by target key with a transaction-scoped advisory
  lock. Decision ancestry is set on INSERT; runtime grants remain unchanged.

## Current Work

NOW:
- Agentic assessment: native MCP continuation and concurrent-client probes passed
  on disposable PostgreSQL 18.4 with the generated limited runtime role.
  Different execution keys can start two runs of one task; no exclusive claim.
  See `AGENTIC-READINESS.md` for evidence and deployment bounds.
- Fixed both limited-role import failures: project row locking and decision-link
  updates. Four native Gateway tests pass, covering creation/replay/merge,
  concurrent imports and registration, unordered ancestry, conflicts, rollback
  and retry. Exact privilege validation and native MCP continuation pass.
  PostgreSQL CI and clean-Windows acceptance now run those limited-role checks.
- All four PR CI jobs passed at the previous head `f0206b2`.
- PR #66 contains the Windows stabilization and redesign. All four CI jobs passed
  at `a8a186f`: Linux Node 20, Windows Node 22, PostgreSQL 14/pgvector and clean
  Windows bootstrap. This does not validate the separate Linux/Obsidian machine.
- Fixed reproducible stale-response races across project switches, overlapping
  searches and continuation inspection. Catalog failures offer a retry.
  Deterministic script regressions and browser QA with delayed synthetic HTTP
  responses cover isolation and retry without writing real project data.
  Full monorepo check passes; Workbench now has 34 passing tests.
- Soft-panel Workbench redesign implemented with horizontal navigation, adaptive
  project rail and accessible Claro/Oscuro/Auto controls. Browser QA covered
  320–1440 px, all mobile views, reload/system theme changes and blocked storage.
- Workbench build and 34 tests pass, including six response-order regressions. Theme tokens and
  verification bounds are documented in `docs/guides/WORKBENCH-THEMES.md`.
- Local branch `fix/daily-reliability`, based on main `007a03c`.
- WAL fix, regression, dependency updates and operational health implemented.
- Qwen 0.6B Q8 real 1024d probe and semantic search passed; worker activated.
- Full monorepo check passed; Workbench suite 34/34; production audit zero.
- WAL starvation, partial failure/resume, monitor and diagnostics fixtures pass.
- Native synthetic logical restore passed; desktop/mobile QA and console clean.
- Upload authorization obtained for the reviewed physical S3 prefix (eu-west-1,
  30-day COMPLIANCE); 172 queued files drained in 11 bounded batches.
- Recovery task paths and shared resilience CLI now use this checkout. Original
  task XML and runtime configuration are retained in `.run/task-backups`.
- Automatic uploader exited zero; queue empty; PITR monitor PASS / zero failures.
- Real S3 base `base-20261106` plus two authenticated WAL packages recovered to
  archive end through `00000001000000000000008F`; 59 projects, 108 memories and
  migration checksums matched the source metadata snapshot. Cluster cleaned up.
- Both Codex MCP launcher paths now point here; fresh clients passed Core status
  (27 tools) and semantic search (1 tool) with the updated dependencies.
- Registered logon trigger, limited interactive principal, hidden VBS action and
  IgnoreNew policy verified. Cold HTTP/model startup through that task passed in
  about four seconds with a fresh worker PASS and a real 1024d embedding.
- A subsequent minute-triggered cycle exited zero. Fresh MCP acceptance returned
  two project-scoped semantic results. Full check and Windows regressions passed
  again before commit; production audit remains zero.

NEXT:
- Review updated PR CI, including limited-role import acceptance on PostgreSQL 14.
- Operator logout/login acceptance. The controlled task test does not simulate
  a fresh Windows session or a completely stopped LM Studio application.
- Reload Codex when convenient: existing connections still run historical
  launchers; fresh clients already use and validate the updated paths.

LATER:
- Linux/Obsidian verification deferred until the machine is available.
- Signing, another release, TencentDB certification and measured ANN work.

## Known Risks

- Archive-end restore does not certify a new named target or unarchived writes.
- Agent task claims, leases, heartbeat and per-caller ACLs are outside current Core.
- Existing MCP clients still use their historical checkout until separately reloaded.
- Linux Obsidian duplicate-path issue remains historical and unverified.
- A model catalog response does not certify inference or retrieval quality.
- One local S3 SDK fixture process failed before PR creation; isolated and full
  reruns passed, as did 12 further isolated runs. Cause remains unestablished.
- Existing rc.5 distribution is unsigned; current source changes are in PR #66.

## Constraints / Invariants

- No secrets in source, browser state or diagnostics.
- Project scope, optimistic locking and append-only histories remain enforced.
- Recovery targets must be empty; replicas authenticate before retention.
- Do not activate queued recovery egress without reviewing destination/retention.

## Recent Changes

- Fixed limited-role import without grant changes, serialized concurrent targets
  and preserved decision ancestry on insertion; added native regressions to CI.
- Prevented late catalog/search/continuation responses from replacing current
  project content; added clean loading/failure counts and catalog retry.
- Redesigned Workbench with theme-aware surfaces and persisted light/dark/Auto
  preference, preserving FORGE colors and using official logo variants.
- Stable checkout created in the current workspace; historical installation kept.
- Fixed WAL batch starvation and exposed queue freshness.
- Updated SDK MCP/Zod and compatible locked dependencies; audit reports zero.
- Added provider/worker health, error-code display and sanitized diagnostics.
- Added disposable native logical restore acceptance with synthetic data.

## Open Questions

- Linux machine is unavailable; current scripts and service state unknown.
- An actual Windows login cycle remains an operator acceptance gate.
