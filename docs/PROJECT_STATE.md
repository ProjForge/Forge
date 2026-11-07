# PROJECT_STATE

Updated: 2026-11-07
Status: real local review-agent pilot implemented; production coordinator inactive

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

- `packages/` — eight components, including the separate coordinator pilot
- `packages/coordinator/` — durable ownership, fenced Core publication and agent-host API
- `scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1` — isolated multi-process pilot acceptance
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
- ADR-010 — external coordinator state has its own owner/schema. Database-clock
  leases and epochs fence publication; prepared output and stable Core keys
  reconcile process death. Core schema and runtime grants are unchanged.
- ADR-011 — opt-in local review agent has no tool authority. Immutable local
  reports use a frozen target, durable prepared output and verified receipts;
  arbitrary external effects need their own receiver-side contract.

## Current Work

NOW:
- ADR-012 — explicit exact-task confirmed-report recovery after full receiver
  directory loss. Original receipt/target stay immutable; pre-loss canonical
  path/dev/inode proof authorizes verification only on a pinned replacement.
  Existing execution, artifact, receipt and retry budget required; no agent replay.
  Follow-up: UTF-8 proof FILE (optional BOM), exclusive UTF-8 capture without DB,
  internal exact checkpoint read and verification before claim; status omits raw
  receipt/artifact. Invalid backup/checkpoint leaves the entire row untouched;
  normal post-claim attempts and fenced reverification remain unchanged.
  Default three-attempt budget recovers on attempt 2 after rejected operator input.
  Follow-up JointRestore: 23/23 + role 1/1, PS5.1 real exit 0/retained Handle,
  2026-11-07T20:06:58.6390618Z; npm run check exit 0. Evidence:
  .run/evidence/report-review-followup/{process.json,joint.stdout.log,check.log}.
  Native JointRestore passed 23/23 plus limited-role 1/1, hidden PowerShell 5.1
  OS exit 0 (2026-11-07T20:01:33Z); full npm run check exit 0.
  Wrong proof/path/bytes, missing report, concurrent CLI/replay and unrelated
  same-agent task isolation covered. Operator guide: CONFIRMED-REPORT-RECOVERY.md.
  Still a synthetic disposable pilot, not production/disk-loss certification.
- Opt-in synthetic joint restore passed on Windows Node 22.23.4 / PostgreSQL
  18.4: actual quiescent Core+coordinator pg_dump/pg_restore into a generated
  empty database, plus report-byte backup/restore in the retained original
  receiver directory (path/dev/inode). Real receipt-committed worker death,
  missing-file and relocated-target negatives pass; resume preserves task/run
  identity with one final memory/context/execution and no handler/model replay.
  Native 23/23 plus exact runtime-role 1/1; hidden PowerShell 5.1 child exit 0.
  This is logical restore with retained receiver storage, not total disk loss
  or a production backup plan. Run instructions: AGENTIC-READINESS.md.
- Local recovery safety rejects receipt-without-artifact with `EFFECT_UNCONFIRMED`
  inside the initial fence, before handler invocation or Core admission.
  Windows Node 22.23.4 compiles and passes 18 normal tests (8 recovery cases),
  full npm run check and 22 native PostgreSQL 18.4 tests. The exact limited-role
  contract also passes. Two new native cases cover checkpoint loss after worker
  death and a ready task without an execution; Core, receipts and report bytes
  remain unchanged. Diagnostics separate 9 completed effects from 2 retained
  receipts on rejected jobs. No real model calls or production activation.
  Acceptance job e516e0ce-492c-4021-ba29-7f3010a2a8ba reached PASS and removed
  its disposable cluster. Child OS exit was not captured. Documented Windows
  PowerShell 5.1 passed; the prior direct PowerShell 7 setup stall has no proven
  cause. Evidence and scope: `docs/guides/AGENTIC-READINESS.md`.
- External `forge-coordinator` pilot implements project/agent-scoped ownership,
  heartbeat, bounded retries/deadlines, prepared artifacts and fenced publication.
  Its opt-in local-report host connects a real local Qwen3.5-9B review model.
  Process acceptance covers three logical agents/six competing processes,
  four model/report crash boundaries, stale owners, HTTP retry and CLI operation.
  Reports are verified before Core completion; committed output avoids repeated
  inference. Only disposable PostgreSQL/report directories are used.
  Node 22.23.4 / PostgreSQL 18.4 live acceptance passed 20 tests: 11 real Qwen
  inferences, nine confirmed reports and one preserved conflicting file, plus
  an injected HTTP 503 recovered on retry. Full monorepo check passes.
- The Windows acceptance wrapper stops/removes its disposable cluster and checks
  the unchanged Core runtime privilege contract. CI includes the pilot on
  PostgreSQL 14 and in clean Windows bootstrap.
- Agentic assessment: native MCP continuation and concurrent-client probes passed
  on disposable PostgreSQL 18.4 with the generated limited runtime role.
  Different execution keys can start two runs of one task; no exclusive claim.
  See `AGENTIC-READINESS.md` for evidence and deployment bounds.
- Fixed both limited-role import failures: project row locking and decision-link
  updates. Four native Gateway tests pass, covering creation/replay/merge,
  concurrent imports and registration, unordered ancestry, conflicts, rollback
  and retry. Exact privilege validation and native MCP continuation pass.
  PostgreSQL CI and clean-Windows acceptance now run those limited-role checks.
- All four PR CI jobs passed for the limited-role import fix at `cf59d4b`.
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
- Plan production-consistent backup/recovery beyond the synthetic joint drill before any
  production worker activation. Exhausted jobs require operator reconciliation.
- Accept another effect receiver only with durable idempotency/reconciliation;
  the current contract covers immutable local reports on retained storage.
- Operator logout/login acceptance. The controlled task test does not simulate
  a fresh Windows session or a completely stopped LM Studio application.
- Reload Codex when convenient: existing connections still run historical
  launchers; fresh clients already use and validate the updated paths.

LATER:
- Linux/Obsidian verification deferred until the machine is available.
- Signing, another release, TencentDB certification and measured ANN work.

## Known Risks

- Archive-end restore does not certify a new named target or unarchived writes.
- Claims/leases/heartbeat exist only in the external trusted-host pilot. Per-caller
  ACLs remain outside Core; coordinator handlers must not bypass its write fence.
- Coordinator control state needs protected backup and consistent recovery with
  Core before relying on recovery from data loss. No production service is activated.
- The missing-artifact guard requires a retained receipt; it does not detect
  loss of both artifact and receipt, reconstruct output from a report, or certify
  arbitrary restore/state loss. A requeued job without either checkpoint may
  still invoke its handler before encountering an existing report conflict.
  Operator reconciliation remains required; existing bounded failure/requeue
  policy is unchanged. No automatic worker retry or production activation was
  performed for this local fix.
- Native Node 24.15 worker/CLI exits intermittently failed with 0xC0000409 on
  this Windows host. Node 22 is the Windows CI baseline; the failure is not
  classified as an agent/provider error or hidden by acceptance retries.
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

- Reject receipt-without-artifact recovery before regeneration, using the
  existing `EFFECT_UNCONFIRMED` code; Core grants/schema and dependencies unchanged.
- Added local model review adapter, target-bound immutable reports, receipt
  reconciliation and real model/process-crash acceptance (ADR-011). Only the
  separate control-state setup gains columns; Core grants/schema stay unchanged.
- Added external coordinator pilot, separate state owner, process-level failure
  acceptance, scoped CLI and ADR-010 without changing Core permissions/schema.
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
