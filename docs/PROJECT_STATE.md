# PROJECT_STATE

Updated: 2026-11-06
Status: Windows scheduled startup and fresh MCP clients verified; real-login acceptance pending; Linux deferred

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

## Current Decisions

- Preserve independent Windows/Linux databases and the existing vector profile.
- Reuse the existing hidden, limited worker task for login startup and retries.
- Exclude authenticated WAL before applying the batch limit.
- Distinguish uploader execution, pending queue and PITR coverage.
- No core data migration or release publication in this work.

## Current Work

NOW:
- Local branch `fix/daily-reliability`, based on main `007a03c`.
- WAL fix, regression, dependency updates and operational health implemented.
- Qwen 0.6B Q8 real 1024d probe and semantic search passed; worker activated.
- Full monorepo check passed; final Workbench suite 28/28; production audit zero.
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
- Operator logout/login acceptance. The controlled task test does not simulate
  a fresh Windows session or a completely stopped LM Studio application.
- Reload Codex when convenient: existing connections still run historical
  launchers; fresh clients already use and validate the updated paths.

LATER:
- Linux/Obsidian verification deferred until the machine is available.
- Fresh Linux CI for this diff before publication.
- Signing, another release, TencentDB certification and measured ANN work.

## Known Risks

- Archive-end restore does not certify a new named target or unarchived writes.
- Existing MCP clients still use their historical checkout until separately reloaded.
- Linux Obsidian duplicate-path issue remains historical and unverified.
- A model catalog response does not certify inference or retrieval quality.
- Existing rc.5 distribution is unsigned; local source changes are unpublished.

## Constraints / Invariants

- No secrets in source, browser state or diagnostics.
- Project scope, optimistic locking and append-only histories remain enforced.
- Recovery targets must be empty; replicas authenticate before retention.
- Do not activate queued recovery egress without reviewing destination/retention.

## Recent Changes

- Stable checkout created in the current workspace; historical installation kept.
- Fixed WAL batch starvation and exposed queue freshness.
- Updated SDK MCP/Zod and compatible locked dependencies; audit reports zero.
- Added provider/worker health, error-code display and sanitized diagnostics.
- Added disposable native logical restore acceptance with synthetic data.

## Open Questions

- Linux machine is unavailable; current scripts and service state unknown.
- An actual Windows login cycle remains an operator acceptance gate.
