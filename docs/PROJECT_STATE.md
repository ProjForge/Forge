# PROJECT_STATE

Updated: 2026-11-10
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
- ADR-013 — disposable operational coherent backup uses shared admission/drain,
  durable limited-role SQL sealing, protected fixture escrow and a distinct-volume
  authenticated replica. No production activation or independent-host guarantee.

## Current Work

NOW:
- Local Core and coordinator restore passed under the separate custodian account
  in an offline Windows Sandbox. The custodian authenticated four components
  and restored both PostgreSQL 18.4 databases. Row hashes matched in seven
  synthetic tables, including a pgvector row. Report reconciliation preserved
  the receipt and completed the task without calling the agent.
  [Local restore evidence](acceptance/custody/2026-11-10-local-restore/README.md)
  records the scope and artifact hashes.
- Separate-account custody passed in a disposable network-disabled Windows Sandbox.
  Two standard effective identities exercised private-key read/write/move denial,
  public-key capture and custodian verification of four synthetic components.
  Private plaintext ACLs, process exits and guest cleanup were verified separately.
  [Custody evidence](acceptance/custody/2026-11-10/README.md) records the scope.
  Remote restoration remains pending until a second preproduction machine is available.
- Operational coherent security closure: synthetic source SCRAM, private C: transient
  initdb password, NOLOGIN backup via operator pg_dump --role. Both-DB normal
  transaction probes verify 42501; authentication negatives cover 28P01 and
  correct writer credentials after sealing. Current evidence: `.run/evidence/operational-coherent/`.
- Opt-in operational coherent preproduction adds a shared fail-closed admission/
  drain gate at Gateway, MCP invoke, Workbench service, embedding batch and
  coordinator/store/report boundaries. Whole jobs retain admission through effect
  and receipt. Durable limited-role NOLOGIN/session drain covers direct SQL/DDL
  in both declared DBs; only the trusted SCRAM superuser operator remains LOGIN.
  The backup role is NOLOGIN and pg_dump selects it with --role. Unknown logins/unsafe backup privileges reject.
  Timeout, crashed admissions and controller/ownership loss never auto-reopen.
  Synthetic RSA-OAEP key custody uses separate owner-ACL escrow; distinct E:/C:
  devices are authenticated before atomic replica publication. Independent restore
  rereads custody only after source cluster, primary bundle and dumps are removed.
  Disposable target restores both archives and reconciles the original receipt
  once without replay. Production remains inactive; same-host custody/storage,
  trusted operator and unknown receiver/manual-reconciliation limits remain.
  Guide: COHERENT-BACKUP.md; evidence: `.run/evidence/operational-coherent/`.
  PS5.1 / Node 22.23.4 / PG18.4 actual exit 0: seven preflight/custody/replica negatives,
  ownership/controller-loss no-publication, eleven late-operation families,
  both-DB SQL/DDL rejection, independent receipt reconciliation with zero replay.
  Current RPO/RTO and restore-child measurements are in the evidence metrics. Restore uses parent fork IPC, no disk
  configuration/--restore entry, with child target/path/hash/PGDATA preflight; both generated roots
  removed. Previous coherent mode also passes 23/23 native + role 1/1, exit 0.
- Windows startup accepted after a real restart. The scheduled task exited 0,
  index status was fresh PASS, and Task Scheduler observed one instance at peak.
  LM Studio returned a real 1024-dimensional vector and both Codex MCPs responded
  in the new session. The disabled task history prevents attribution of the first
  run to either trigger. Evidence: `.run/evidence/windows-login/`.
- Coherent-backup preproduction path: `forge-resilience` captures actual custom
  archives with existing process primitives and seals Core/coordinator/report/
  identity in an authenticated encrypted v1 generation. External 32-byte key/keyId;
  hidden staging, atomic directory publication, all-component verification before
  restore callback. Core backup format/dependencies unchanged. `-CoherentBackup`
  reuses isolated split restore; fixture-only drained-writer lease plus EXCLUSIVE
  locks reject concurrent DML/row locks. Key input has owner-only ACL and is reread
  at restore. Wrong/mixed/missing/tampered generations never reach either restore.
  No automatic retention deletion; independent local copy authentication tested.
  This earlier callback-only rehearsal is superseded for operational preproduction
  by the separately opt-in gate/custody/replica mode above. Production still needs
  reviewed topology activation, independent-host custody/replica/retention policy
  and manual handling of survivor reports without receipts. No product scheduling
  or activation. Guide: COHERENT-BACKUP.md.
  Final 2026-11-09 PS5.1 / Node 22.23.4 / PG18.4: OS exit 0, native 23/23,
  source/target role 1/1, five encrypted-generation negatives, one retained
  receipt/effect and zero handler/provider replay. Full check/diff check 0;
  both clusters removed. RPO 2640.114 ms, RTO 10173.5527 ms, capture 1347 ms;
  phase scope and exact candidate evidence: `.run/evidence/coherent/`.
- Prior accepted NTFS exact-ID work is preserved. Historical Windows scheduled-run
  observation was read-only. Capacity reference: 10 eligible, 40 jobs/point;
  concurrency 2→4: 14.36→21.80 jobs/s, wait p95 2571→1623 ms; Core peak 6/20;
  one recovery retry, zero handler replay. Retain concurrency cap 4. These are
  supplied prior results, not new measurements from coherent-backup acceptance.
- Applied exact split candidate 30e421a8 (SHA-256 b353782e4665f46a84ffc14d4ebca4f4b9f82ba3d49f99ae6005635c4b8aeacc)
  plus split-only isolation: clear/restore inherited PG*, read-only source
  preflight before createdb/migrations, owned source/target data_directory and
  DB/user/loopback identity guards; pinned generated provisioner path/hash.
  Missing config and arbitrary provisioner reject before connections (exit 1).
  Final hidden PS5.1 / Node 22.23.4 / PostgreSQL 18.4: retained Handle, OS exit 0
  at 2026-11-08T16:35:07.8769526Z; stderr empty; native 23/23, source/target
  role 1/1, five generation negatives, two old-password 28P01 rejections,
  handler/provider replay 0. PGHOSTADDR=127.0.0.2 and bogus PGSERVICE ignored
  and restored. Both owned clusters stopped/removed; no source port listener.
  Retained 60 projects/222 memories/95 tasks/54 runs/95 jobs; actual synthetic
  losses 13 tasks/12 jobs (12 matched pairs). Capture 593 ms; RPO 1963.360 ms;
  RTO 8048.9613 ms, including provision 5098.4341 ms. Split provisioner now
  waits on actual exit without inherited output pipes (bounded 60 seconds).
  Full npm run check on Node 22 exit 0; diff check 0. Evidence:
  `.run/evidence/split-final/`; guide CONFIRMED-REPORT-RECOVERY.md.
  Previous candidate Fresh + Joint passes remain historical (23/23 + role 1/1;
  Fresh target 1/1); final hardening leaves their restore bodies unchanged.
  Acceptance-only synthetic fixtures; no runtime/schema/dependency changes,
  production SLA, activation, commit or publication.
- Exact-review P2: fresh report restore uses authenticated on-disk report.bytes;
  Core runtime host/database/role preflight precedes Core calls. Final PS5.1
  OS exit 0/retained Handle, native 23/23 + source/target role 1/1; SCRAM,
  five rejection cases, cutoff and cleanup pass; npm run check exit 0.
  Capture 633 ms / reconcile 2629 ms; .run/evidence/exact-review/.
  Synthetic local fixture only; reviewed candidate is applied in this worktree.
- Opt-in `-FreshClusterRestore` extends the joint rehearsal to a separate fresh
  PostgreSQL 18.4 cluster/catalog and generated loopback ports. Acceptance-only
  HMAC generation/inventory/digests reject mixed/missing/unauthenticated input
  before restore; a later real dump/marker establishes the controlled cutoff.
  Fresh fixture roles use unchanged provisioning/exact Core privilege acceptance.
  ADR-012 IDs/receipt/target and unrelated pending work survive exact CLI recovery
  in a replacement inode without handler/provider replay. Both schemas remain in
  one database; the later split drill covers separate databases, not production RTO/RPO.
  Guide: CONFIRMED-REPORT-RECOVERY.md. Evidence: .run/evidence/fresh-cluster-final
  and joint-regression; full check: fresh-cluster-fixed/check-final.log.
  Windows PS5.1 hidden/redirected final OS exit 0 (retained Handle), native
  23/23 + exact role 1/1 in source and target; JointRestore 23/23 + role 1/1.
  Full check exit 0. Measured capture 535 ms / restore-to-reconciled 2668 ms,
  cutoff 2026-11-08T15:50:33.614263Z; both owned clusters stopped/removed.
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
- Review production topology/gate activation, independent-host custody and replica/
  retention policy before any production worker activation. Local disposable
  operational acceptance does not authorize that activation.
  Exhausted jobs and survivor reports without receipts require manual reconciliation.
- Accept another effect receiver only with durable idempotency/reconciliation;
  the current contract covers immutable local reports on retained storage.

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

- Workbench validates the loopback Host and listening port before serving files
  or issuing the API token. HTTP regression covers foreign and duplicate Host.
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

FreshClusterRestore hardening: target SCRAM with owner-only transient admin
password file; two old source passwords must fail with 28P01. Fresh restore is
transactional. Both owned cluster stops are attempted independently and files
are retained on any unconfirmed stop. Synthetic-only; no production activation.
Validated hardening: PS5.1 retained Handle / OS exit 0; native 23/23, both
role contracts 1/1; two 28P01 rejections, five negative generations, no replay.
Both clusters stopped/removed; npm run check and diff check passed. Evidence:
.run/evidence/fresh-hardening/. JointRestore compared to prior validated path.
