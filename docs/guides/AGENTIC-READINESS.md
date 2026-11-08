# Agentic integration readiness

Assessment baseline: 2026-11-06, source `f0206b2`, PR #66.
Follow-up: limited-role import corrected and validated on 2026-11-06.
Pilot follow-up: `forge-coordinator` now provides external leases, epochs,
heartbeat and recovery; see [its guide](../../packages/coordinator/README.md).
Real-agent follow-up: opt-in local Qwen review and immutable report publication
are implemented and accepted on disposable PostgreSQL; production workers remain off.

## Verdict

FORGE can serve as a durable memory and execution-record layer for a controlled,
trusted agent runtime over local MCP stdio. An external host must plan and run
the agents, enforce permissions, dispatch work and recover stalled workers.
This assessment does not certify an autonomous distributed orchestrator or an
authenticated remote multi-tenant service.

| Deployment | Assessment |
| --- | --- |
| Local trusted agent with an MCP host | Ready for a supervised pilot |
| Trusted agents with an external dispatcher and bounded concurrency | Conditional pilot; task ownership belongs to the dispatcher |
| External coordinator pilot in this repository | Local real-model review and immutable-report crash/retry acceptance passed |
| Unattended workers relying on FORGE to claim/reclaim tasks exclusively | Missing native claim, lease and heartbeat semantics |
| Mutually untrusted agents or remote tenants sharing one runtime credential | No per-caller authorization boundary established |
| Project onboarding through portable import with the generated limited role | Validated after the follow-up fix; original permissions retained |

## Evidence collected

- Live `forge_status` returned PostgreSQL 18.4, schema 0.1.3 and pgvector 0.8.2.
- Live semantic MCP search returned three current results, all in the requested
  `forge-core` project and the configured Qwen 1024d profile. This is availability
  evidence, not a retrieval-quality benchmark.
- A disposable PostgreSQL 18.4 cluster on loopback port 55440 was migrated using
  the repository migrations. The repository bootstrap created the limited
  `forge_runtime` role; no production database was written.
- At the assessment baseline, the Gateway continuation integration passed but
  portable import failed with SQLSTATE 42501 on `forge.projects`. Follow-up
  validation passes all four native Gateway tests with the original limited
  role, including concurrent imports, decision ancestry and rollback/retry.
  The exact runtime privilege contract and native MCP continuation also pass.
- The native MCP stdio continuation integration passed with that limited role:
  create/assign/task/start, memory and decision writes, vectors, context package,
  process replacement, stable-key recovery, idempotent replays and finish/audit.
- Two independent MCP stdio processes proved concurrent task-create replay
  returns one identity, one of two same-version updates loses with
  `OPTIMISTIC_LOCK`, a task lookup in another project returns `NOT_FOUND`, and
  stable-key execution lookup survives replacing a client/server process.
- The same two clients, using the same assigned `agentId` but distinct execution
  and idempotency keys, both started a running execution for one task. Two running
  executions were observed. Idempotency protects a repeated operation key; it
  does not claim task ownership across different operation keys.
- All four PR CI jobs passed at `f0206b2`: Linux Node 20, Windows Node 22,
  PostgreSQL 14/pgvector and clean Windows bootstrap.
- The disposable cluster stopped and its directory was removed. Sanitized local
  evidence is in `.run/agentic-probes-result.json` and `.run/agentic-readiness.log`.
  Follow-up import evidence is in `.run/import-final-native.log`.

The original MCP probes use deterministic synthetic tool calls, not autonomous LLM planning.
No throughput, long-running unattended operation or hostile-agent acceptance was
performed. Linux CI does not verify the unavailable Linux/Obsidian machine.

## Real-agent and external-effect acceptance

The opt-in coordinator host calls an existing local Qwen3.5-9B Q8 model through
LM Studio. It sends only the bounded task title/objective, rejects tool calls
and malformed output, and exposes no execution authority to the model. The
trusted host publishes a report into a fixed local directory; see ADR-011.

Windows acceptance with Node 22.23.4 and disposable PostgreSQL 18.4 passes all
20 native tests: three model-backed logical agents compete through six worker
processes, with actual process death after inference, file publication, receipt
commit and Core completion. Saved inference and existing report bytes are reused.
One deliberately injected HTTP 503 is retried before the output checkpoint;
11 successful real model calls produce nine confirmed effects. A tenth,
conflicting receiver file is rejected and remains unchanged. Every successful
task retains one Core execution, result memory and continuation package.

Recovery-guard follow-up, 2026-11-07 (local worktree based on `91cd11d`):
Windows portable Node 22.23.4 compiles the current source and passes all 18 normal
coordinator tests, including all eight recovery regressions; `npm.cmd run check`
passes. This replaces the earlier WSL source-only/absent-tsc validation limit.
The two new native cases now pass: retained receipt with lost artifact following
real worker death after receipt commit, and ready task without Core execution.
A distinct diagnosis run used the documented invocation once, without LiveAgent:

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1
```

With process-only PATH selecting portable Node 22.23.4, Windows PowerShell
5.1.26100.9818 completed disposable PostgreSQL 18.4 acceptance: 22/22 native tests
(21 subtests plus parent), no skips/failures, and 1/1 exact runtime-role test.
The latter checks the exact per-table privilege allowlist, CONNECT/schema USAGE,
no database/schema CREATE, no elevated role attributes or memberships, connection
limit 20, and denied DDL/migration writes/event updates/project deletes.
Diagnostics: protocol-fixture, realCalls=0, totalCalls=13, reports=12,
completedConfirmedEffects=9, retainedReceiptsOnRejectedJobs=2, conflictsRejected=1.
Retained receipts are rejected work, not completed effects. Both new cases verify
pre-admission rejection, unchanged Core snapshots and preserved receipt/report
bytes/inode/mtime. One HTTP 503 is deliberately injected before checkpoint.

The wrapper reached final PASS at 2026-11-07T01:09:26.9891577Z after stopping and
removing its cluster; no listener remained on 55441. Evidence belongs to worker
job `e516e0ce-492c-4021-ba29-7f3010a2a8ba`; its private worktree contains
`.agentic-tmp/native-legacy.stdout.log` and `native-legacy.stderr.log` (empty).
The process launcher returned 0; the child OS exit code was not captured before
it exited, so final PASS/logs are the success evidence rather than a measured
child exit code. No repeat was performed to recover that code.

The prior direct PowerShell 7.6.9 run stalled after startup before createdb;
manually stopping its owned cluster released the wait and caused createdb and
second-stop failure (exit 1). Windows PowerShell passed without wrapper changes.
This supports using the documented shell; output-handle inheritance remains an
unproven explanation, since shell and launch/redirection context differ. Wrapper,
guard, eight unit recovery regressions and native tests remain intact. No full
check repeat was needed for documentation-only closeout. Earlier live-model
acceptance above remains historical; this run made no real inference.
The guard still cannot detect loss of both artifact and receipt, certify backup
restore or arbitrary external effects; bounded retries and operator reconciliation
remain unchanged. Core schema/grants/dependencies and production services are unchanged.

The same suite runs in CI against a deterministic loopback protocol fixture and
real PostgreSQL/files; it does not require/download a model. Fast regressions
also cover timeout/cancellation, output limits, target replacement, linked roots,
concurrent publication and missing confirmed reports. The original Core runtime
privilege contract passes without new grants. Only coordinator-owned control
state gains effect columns; no production database, queue or service is changed.

Local Node 24.15 intermittently exits natively with `0xC0000409` in worker/CLI
processes. Node 22 remains the Windows acceptance/CI baseline. Native exits fail
acceptance and are not treated as retryable model errors. Similar Windows runtime
shutdown failures are tracked in [Node issue 56645](https://github.com/nodejs/node/issues/56645);
this observation does not establish an exact native stack or an upstream fix.

An inference can repeat after death before its output is durably saved. Effect
protection is specific to retained trusted local files with atomic hard links;
it does not establish exactly-once email, deployment or arbitrary HTTP effects,
power-loss durability, state-database recovery or general review quality.

## Limits established by code and probes

1. **Dispatch and crash recovery.** `startExecution` validates task scope and
   assignment and inserts a running execution. It provides no task claim, lease,
   worker heartbeat, automatic reassignment or fencing token. A trusted external
   dispatcher must prevent duplicate side effects and reconcile abandoned runs.
   The new external pilot supplies scoped leases and fenced publication for
   trusted workers, while leaving these Core contracts unchanged. Process death,
   lost replies and stale-worker recovery are tested with real worker processes;
   real review/report acceptance is described above. Other effect receivers,
   model quality and state-database loss are not certified.
2. **Caller identity.** The stdio process trusts its host and database credential.
   Tool arguments such as `projectId` and `agentId` identify records; they do not
   authenticate a caller. The limited role has table-wide privileges and Core
   exposes project discovery. Relational project scoping is not tenant ACLs.
   `capabilities` and `policyVersion` do not establish enforced tool permissions.
3. **Capacity.** Each Core MCP process allows a pool of up to ten connections;
   bootstrap limits the shared runtime role to twenty connections. Pools open
   lazily, so these numbers do not imply a fixed supported agent count. Bound
   concurrency and measure actual workloads before expanding deployment.
4. **Portable import locking contract (corrected).** The baseline used a project
   row lock requiring UPDATE privileges and subsequently updated decision
   supersession links. Both conflict with the limited role. Imports now take a
   transaction-scoped advisory lock per target key, including absent targets,
   and insert decisions in ancestry order with their links already set.
   Conflicting existing ancestry is rejected. Bootstrap grants and schema remain
   unchanged. PostgreSQL CI and clean-Windows acceptance now enforce limited-role
   privileges and the complete Gateway import regression suite.
5. **Host responsibility.** The host must treat retrieved content as untrusted
   data, enforce its tool allowlist and approvals, apply time/cost budgets and
   use stable idempotency keys on retries. FORGE persists knowledge and audit;
   successful persistence does not verify a model's conclusions or side effects.

## Smallest useful deployment

Use one trusted MCP host, one FORGE project per work scope, the limited runtime
role, Core stdio and the read-only semantic bridge. Keep Workbench on loopback.
The external dispatcher owns task allocation and cancellation. Preserve returned
UUIDs, use stable-key lookups after reconnect, reuse pagination cursors and retry
keys, and refresh records after optimistic-lock conflicts.

The existing native lifecycle test can be repeated using an isolated migrated
database and its limited runtime URL with `npm run test:integration -w
forge-mcp-server`. Run the full Gateway integration with
`FORGE_TEST_REQUIRE_LIMITED_ROLE=1` to enforce the no-UPDATE prerequisite as well
as import behavior. Never point these write tests at the production DB.

Before broader unattended deployment, plan control-state backup/recovery, accept
each additional external-effect receiver, measure sustained bounded
multi-process load and complete real Windows login acceptance.
Remote/untrusted deployment requires a separate authenticated authorization
design. Core schema and production configuration remain unchanged.

## Opt-in synthetic joint logical restore (2026-11-07)

Run from the checkout with the existing portable Node 22.23.4 directory first
in process PATH. Use Windows PowerShell 5.1; the wrapper rejects combining this
flag with `-LiveAgent`. Normal checks/CI do not enable restoration.

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1 -JointRestore
```

For hidden redirected acceptance, retain the process handle before waiting so
Windows PowerShell 5.1 exposes the actual child exit (or use `-Wait -PassThru`):

```powershell
$script = Join-Path $PWD 'scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1'
$child = Start-Process powershell.exe -WindowStyle Hidden -PassThru -WorkingDirectory $PWD -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $script + '"'), '-JointRestore') -RedirectStandardOutput (Join-Path $PWD 'joint.stdout.log') -RedirectStandardError (Join-Path $PWD 'joint.stderr.log')
$handle = $child.Handle
$child.WaitForExit()
$child.Refresh()
$child.ExitCode
```

Observed child OS exit **0**, stderr empty, final PASS at
2026-11-07T19:45:32.5538386Z: native **23/23**, no skips/failures, and exact Core
runtime-role contract **1/1**. Normal coordinator compile/tests **18/18**, exit 0; full `npm run check` exit 0.
Evidence logs are retained locally under .run/evidence/joint-restore-20261107/ (ignored).
No real model or production access. The existing protocol diagnostics (13
requests, 12 reports, 9 completed confirmed effects, 2 rejected retained receipts)
precede the extra restore fixture; that fixture makes one additional synthetic
request/report and zero provider calls during restore/resume.

The drill kills the existing worker after durable file publication and receipt
commit, before memory/context/completion writes. All fixture workers exit before
the backup; the source database and receiver are quiescent during a real custom
`pg_dump` of Core and coordinator schemas together and a report-byte backup.
`pg_restore --exit-on-error` restores into a generated empty `template0` database
in the same disposable loopback cluster. Database name and OID must differ.
Existing cluster roles/privileges are reused, including `forge_runtime` for Core
and the separate state owner. This does not test role/cluster reconstruction.

Restored state preserves the full job row and execution/task IDs. A copied
report in a relocated directory has a different target fingerprint: claim stays
idle and state is unchanged (no silent rebind). Removing the original confirmed
file yields `EFFECT_UNCONFIRMED`, no regenerated file, no memory/context, and no
done task. Restoring backed-up bytes into the **original retained receiver
directory**, with unchanged canonical path/device/directory inode, permits resume.
ADR-011 intentionally pins that directory; the restored report file itself may
have a new inode. Resume then preserves its bytes/inode/mtime and yields exactly
one succeeded execution, memory and continuation package. A second poll is idle;
the handler must never run. Source state remains unchanged. Generated restored
database, dump, byte backup, relocated receiver, reports and cluster are cleaned.

This is **logical database restore plus report-byte restore with retained receiver
directory**. Total disk/directory loss, mixed-generation backups, separate Core
and coordinator databases, production backup consistency, role loss, real model
inference and simultaneous receipt+artifact loss remain distinct untested gaps.
No runtime rebind, Core grants/schema/dependency change or backup product is added.
Production coordinator activation remains blocked on an operational recovery plan.
## Isolated full receiver loss acceptance (2026-11-07)

ADR-012 and [the operator procedure](CONFIRMED-REPORT-RECOVERY.md) add explicit
one-shot exact-task verification after replacing the complete report directory.
Normal worker/enqueue pinning and persisted effect_target/receipt are unchanged.

Windows Node 22.23.4 / disposable PostgreSQL 18.4 JointRestore: 23/23 native
checks plus exact runtime-role 1/1; hidden redirected Windows PowerShell 5.1
OS exit 0 with Process.Handle retained, stderr empty, 2026-11-07T20:01:33Z.
The initial fixture run failed EISDIR while inventorying a shared test receiver;
the corrected drill owns its own mkdtemp receiver. Both runs stopped/removed their
clusters. Evidence: .run/evidence/full-receiver-loss/{native,isolated}.stdout.log,
final.stdout.log, final.stderr.log and final-process.json in the authorized worktree.

The drill holds the emptied moved-original inode until creating a fresh receiver,
then removes the entire old directory and asserts its absence. Original and fresh
identities differ. Wrong old proof/path, absent and wrong report bytes cannot
complete Core or regenerate/publish. Restored bytes reconcile through two real
CLI callers with exactly one completion; replay is idle. One pending same-agent
job remains byte-for-byte unchanged. Original receipt/target/artifact, execution
identity, report inode/mtime and audit cardinality are asserted. No provider replay.

Full npm run check passed; focused verifier regressions cover linked reports,
wrong checkpoint/receipt, pinned replacement drift and missing original execution.
This is a quiescent trusted-filesystem synthetic logical drill with retained
checkpoints/pre-loss metadata. It does not certify production backup generations,
hostile filesystem races, physical disk/power loss or real inference.

### Proof-file / attempt preservation follow-up (2026-11-07)

Recovery now accepts a UTF-8 proof FILE, with or without BOM, instead of JSON
argv. Capture can write an exclusive UTF-8 file without database configuration.
The exact project/task checkpoint is read internally, verified with the existing
verification-only publisher before claiming, and verified again inside the existing
lease fence. Status exposes neither prepared output nor the raw receipt. Invalid
backup data and missing output/receipt refuse before changing any row field;
normal claim budgets, schemas, grants and post-claim failure handling stay intact.

Hidden redirected Windows PowerShell 5.1 -JointRestore passed native 23/23 and
runtime-role 1/1, real OS exit 0 with Process.Handle retained at
2026-11-07T20:06:58.6390618Z; stderr empty, disposable cluster stopped/removed.
Full npm run check exited 0. Evidence in the authorized worktree:
.run/evidence/report-review-followup/{process.json,joint.stdout.log,joint.stderr.log,check.log}.
Native capture+recover uses the documented proof-file contract with spaces,
non-ASCII paths and an optional UTF-8 BOM; exclusive capture refuses overwrite.
Negative checks compare the entire row, including attempts and epoch, after
wrong proof/path, malformed JSON, absent/corrupt report and missing checkpoints.
A maxAttempts=3 job survives these refusals after its crash, completes on attempt 2
with one concurrent completion, and replays idle with its original receipt.
No real model, production, downloads or publication; prior synthetic-drill limits
still apply. This exercises native argv/file semantics under the PS5.1 acceptance
host; it does not separately automate the guide's interactive shell commands.
