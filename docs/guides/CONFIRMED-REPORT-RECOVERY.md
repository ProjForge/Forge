# Confirmed report recovery (isolated opt-in pilot)

Keep all writers stopped. Use only the intended isolated Core/control databases,
with their existing limited runtime/state roles. Do not activate a service.

Before loss, with FORGE_COORDINATOR_REPORT_ROOT set to the existing receiver,
run the built CLI and save a UTF-8 proof file outside that receiver. This works
in Windows PowerShell 5.1 and PowerShell 7; capture requires no database:

~~~powershell
$proofFile = Join-Path $PWD 'report target.json'
node packages/coordinator/dist/cli.js capture-report-target $proofFile
if ($LASTEXITCODE -ne 0) { throw 'Report target capture failed' }
~~~

The JSON contains canonicalPath, dev and ino as captured by Node, using exactly
the fingerprint inputs of the original publisher (Windows path is lowercased
when hashed). Keep this trusted metadata with the consistent Core/control and
report-byte backup. A pre-loss manifest with exactly these fields is also valid.
Do not invent metadata after loss or derive it from the replacement directory.

Restore the consistent database checkpoints and report bytes separately. Create
a trusted, quiescent replacement at the same canonical local path. It must have
a distinct physical identity, contain the exact original report file and have no
symlink/junction receiver or symlink report. The command performs verification
only; it does not create directories or restore files.

With FORGE_DATABASE_URL and FORGE_COORDINATOR_DATABASE_URL already supplied by
the isolated launcher and the report root set, invoke exactly one task from
Windows PowerShell 5.1 or PowerShell 7 using the proof FILE path:

~~~powershell
node packages/coordinator/dist/cli.js recover-report project-key task-key $proofFile
if ($LASTEXITCODE -ne 0) { throw 'Report recovery failed; inspect the backup and checkpoint' }
~~~

The capture command creates the proof file exclusively (wx), never overwrites it,
and writes UTF-8 without BOM. Recovery also accepts UTF-8 with BOM (including
PowerShell 5.1 Set-Content -Encoding UTF8 output). Do not pass raw JSON as argv
or use PowerShell 5.1 > redirection, which writes UTF-16.

No model configuration is required. The command accepts no watch mode. Inspect
status for the same project/task afterward. completed means reconciliation passed;
idle means nothing eligible was claimed (including completed replay or an active
lease), not proof that recovery succeeded. failed exits 1; missing receipts, wrong proof/path or incompatible configuration
also exit 1. Missing prepared output or receipt refuses explicitly. Invalid proof,
missing/corrupt report or invalid prepared bytes fail before claim, leaving the
entire row (including attempts and epoch) unchanged. Verification repeats inside
the existing lease fence; failures after claim retain normal bounded retry rules.
An ineligible row (for example exhausted attempts) can return idle without changing
anything. The original receipt and target remain immutable. Do not reset retries
or edit SQL checkpoints. Normal enqueue/worker entry points retain physical
target pinning and cannot claim this old task on the replacement.

If a report survives in its original receiver and the job has neither prepared
output nor a receipt, the normal report worker detects the expected filename
before Core admission. The job becomes terminal with `EFFECT_UNCONFIRMED` in
`status <projectKey> <taskKey>`. Preserve the file and reconcile the task using
independent evidence. A retained prepared output still allows an exact matching
report to reconcile when the worker stopped before the receipt commit.

The native -JointRestore acceptance uses only disposable PostgreSQL and synthetic
provider output. It removes the full original receiver, holds its emptied inode
until replacement creation to prevent reuse, removes the old directory, restores
saved bytes and exercises real one-shot CLI recovery, concurrent callers and replay.
See ADR-012 for scope and assumptions.


## Fresh-cluster generation rehearsal (Windows, synthetic only)

Decision: extend the existing assertions behind `-FreshClusterRestore`, separate
from `-JointRestore`. Reusing the original cluster is cheaper but cannot establish
fresh catalog/role provisioning; a general backup service is outside this pilot.
No runtime, grants, schema or dependency changes are required. Both Core and
control schemas remain in **one database**; separate databases are untested.

Use portable Node 22.23.4 on the process PATH and PostgreSQL 18.4 installed locally:

~~~powershell
powershell.exe -NoProfile -NonInteractive -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1 -FreshClusterRestore
~~~

For unattended evidence, launch that command with `Start-Process -WindowStyle
Hidden`, stdout/stderr redirected and `-PassThru`. Retain `$process.Handle` before
`WaitForExit()`, then record its actual `ExitCode`. The wrapper generates two
loopback ports and owned cluster paths, refuses live-agent/JointRestore mixing,
and stops both clusters before removing only its fixture tree. A busy port fails
closed; it does not retry jobs. The existing `-JointRestore` mode remains available.

Reproducible operations plan (acceptance only):

1. Stop writers across Core, control and the report filesystem. Wait for every
   fixture worker to exit, including the worker killed after report/receipt commit
   and before Core success. Preserve an unrelated pending job. Keep writers stopped
   throughout report/proof capture and the logical database dump.
2. Retain a generation ID, controlled cutoff, actual report bytes, pre-loss directory
   proof, exact expected component inventory and SHA-256 digests outside the
   receiver. Authenticate the manifest with HMAC-SHA256. This fixture's ephemeral
   random key lives only in the harness process, outside both generations/receiver;
   it is never logged or retained. A real operations procedure would need separate
   protected key retention and retention of the complete authenticated generation.
3. Use an isolated empty destination. The fixture checks different PostgreSQL
   system identifiers/ports and absent runtime roles. Before pg_restore or any
   replacement-report writes, reject a dump from a second actual generation
   containing a known later task, a missing component, an altered manifest, a wrong
   key and the second authenticated generation. Each refusal checks no Core/control
   schema exists in the target, no runtime work occurred and the source job is intact.
4. Only after authentication, create the two existing fixture roles in the fresh
   catalog, restore the actual pg_dump archive with pg_restore, and run unchanged
   Core role provisioning with a fresh secret and the exact runtime-role acceptance.
   No new Core privileges are introduced. Restore the report at the original
   canonical path in a replacement inode; use the retained proof and exact recovery
   CLI under the limited target roles. Keep the original receipt and target immutable.
5. Accept only one task/run/memory/context/report, one completion, idle replay,
   zero handler/provider replay, unchanged unrelated pending row and original source
   checkpoint, and exclusion of the known post-cutoff marker. Verify both clusters
   stopped/removed and retain sanitized logs plus the real shell exit code.

The diagnostic reports capture milliseconds from report-byte staging through proof,
logical dump and authenticated manifest creation. Restore-to-reconciled milliseconds
start after authentication, before fresh role provisioning/pg_restore, and end after
CLI reconciliation, replay and all postconditions. Negative experiments and the
second capture are outside those intervals. The cutoff is a controlled quiescent
fixture boundary; these timings are neither production RTO nor production RPO.
The later marker deliberately models a write outside the retained generation.

No production data, service activation, uploads, external egress or real inference
are exercised. This is logical synthetic recovery, not physical disk recovery,
hostile-filesystem protection or evidence of real workload capacity. Revisit key
custody, cross-store writer fencing, independent retention and separate-database
consistency before designing any production recovery procedure.

Prior candidate evidence (before SCRAM hardening), 2026-11-08
(Node 22.23.4 / PostgreSQL 18.4): final hidden PS5.1 OS exit 0
with retained Handle, native 23/23, exact runtime role 1/1 on both source and target,
empty stderr, both clusters stopped/removed. Capture 535 ms; restore-to-reconciled
2668 ms; cutoff 2026-11-08T15:50:33.614263Z. Existing JointRestore regression also
passed 23/23 + role 1/1 with OS exit 0. Full `npm run check` exited 0. Evidence:
`.run/evidence/fresh-cluster-final/`, `.run/evidence/joint-regression/` and
`.run/evidence/fresh-cluster-fixed/check-final.log`. The first attempt's CWD failure
and exit 1 remain in `.run/evidence/fresh-cluster/`; fixed by module-relative schema
script paths before the successful runs. No worker job was automatically retried.

Fresh-target authentication hardening: the generated target uses SCRAM-SHA-256
for local and host connections. A synthetic admin password is supplied through
an owner-only file under the owned fixture root, removed immediately after
initdb. Only the decoded target admin password is passed to pg_restore, which
uses --single-transaction and --exit-on-error in fresh mode. The two original
source role passwords must each fail at the target with SQLSTATE 28P01; fresh
passwords drive the real recovery CLI and exact runtime-role contract. Metrics
include targetAuthentication, oldPasswordsRejected and oldPasswordSqlstate.
Cleanup attempts both owned cluster stops independently; any unconfirmed stop
retains all fixture files. Recursive cleanup is restricted to the generated root.

Hardening verification 2026-11-08T15:55:19Z: hidden Windows PowerShell 5.1,
retained process Handle, actual OS exit 0, empty stderr; native 23/23 and source
runtime contract 1/1, with target contract 1/1 asserted inside the native test.
SCRAM rejected both old passwords with 28P01; five rejection cases rejected, source
checkpoint intact, post-cutoff marker excluded, zero handler/provider replay.
Capture 656 ms; restore-to-reconciled 2563 ms; cutoff
2026-11-08 16:55:13.697698+01. Both stop confirmations and no remaining owned
cluster directories verified. Full npm run check and git diff --check exit 0.
Evidence: .run/evidence/fresh-hardening/{process.json,native.stdout.log,
native.stderr.log,check.log}. JointRestore's restore arguments and role paths
remain unchanged; prior validated evidence above was compared, not rerun.
Cleanup failure behavior was reviewed statically, without injected stop failure.

Exact-review correction: fresh mode restores the single intended report from the
authenticated on-disk report.bytes component returned by preflight, checked against
the signed digest. Original bytes are only the oracle and wrong-content fixture.
Core runtime host, database and role are checked before any Core calls.

Exact-review P2 verified 2026-11-08T16:03:10Z: hidden PS5.1, retained Handle,
OS exit 0, empty stderr; native 23/23, source role 1/1 and target role 1/1.
Authenticated report.bytes supplied the restored report; exact single-report
inventory, five rejection cases, SCRAM old-password rejection (2 x 28P01),
cutoff exclusion and zero handler/provider replay passed. Capture 633 ms;
restore-to-reconciled 2629 ms. Both clusters stopped and owned directories removed.
Final npm run check exit 0; git diff --check exit 0. Evidence:
.run/evidence/exact-review/{final.process.json,final.stdout.log,final.stderr.log,check-final.log}.
Legacy JointRestore was preserved by inspection, not rerun in this follow-up.


## Opt-in isolated split-database restore drill

Run with the installed portable Node directory prepended **only to this process's
PATH**, from this worktree, using native Windows PowerShell 5.1:

```powershell
$env:PATH='C:\Users\alber\Desktop\IA Project\Proj Forge\.run\node-v22.23.4-win-x64;'+$env:PATH
powershell.exe -NoProfile -NonInteractive -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1 -SplitDatabaseRestore
```

For retained evidence use the hidden `Start-Process -PassThru` pattern above,
redirect both output streams and retain `.Handle` before waiting; inspect the
child's actual `.ExitCode`. `-SplitDatabaseRestore` rejects combinations with
FreshClusterRestore, JointRestore or LiveAgent. It creates only generated owned
loopback clusters; it neither reads production connection settings nor invokes
live workers. The filtered child environment includes PATHEXT/ComSpec so native
PowerShell recognizes PostgreSQL executables.

Decision: reuse the existing native lifecycle, authenticated-generation checks,
limited-role provisioning and confirmed-receipt CLI. Keep Core and coordinator
in genuinely separate databases on one disposable source instance and restore
into two new databases on a second, newly initialized SCRAM instance. Keeping one
database (the earlier Fresh drill) cannot test independent restores. Separate
instances for each component would add provisioning cost without improving this
logical cross-database consistency test. No runtime, schema, grants or dependency
changes are required; revisit instance-level failure domains separately.

Invariants and snapshot contract:

1. Before fixture mutations, require disposable mode, loopback host and expected
   source database/runtime identity. State has a different database name and OID.
   Destination has a different port/system identifier, generated database names
   and different Core/control OIDs; neither restored database contains the other's
   schema. Real CLI/Core calls use the existing limited roles.
2. Join every fixture child, including the worker killed after confirmed receipt;
   finish all seed writes, close/drain the synthetic HTTP receiver, and record one
   common cut. No fixture writer runs while the report/proof and **two actual
   custom-format pg_dump archives** are captured. This application-wide quiescence
   is the consistency contract, not an atomic transaction spanning databases.
3. Pin generation, cut, source system/database identities and receiver path/dev/inode,
   exact inventory and SHA-256 byte digests under an ephemeral in-memory HMAC key.
   Before either restore or replacement-report writes, authenticate the entire
   generation. A real later coordinator dump substituted under the first manifest
   fails closed; so do missing bytes, changed manifest, wrong key and a valid but
   unpinned later generation. Both target schemas remain absent. Restore exclusive
   materializations of the authenticated archive buffers, and use authenticated
   proof/report bytes. The originals are test oracles, not restore inputs.
4. Use new target secrets; both source role passwords fail SCRAM with 28P01.
   Preserve task/run IDs, artifact and original receipt, reconcile exactly once,
   then require concurrent completed/idle and subsequent idle replay, one memory,
   one context and one audit entry per action. No handler/provider replay or extra
   report; unrelated pending work and source checkpoints remain unchanged.

Historical candidate split run (before final isolation), 2026-11-08T16:17:55Z, Node 22.23.4 / PostgreSQL
18.4 / hidden PowerShell 5.1: actual child exit **0**, retained Handle, empty
stderr, native **23/23**, exact Core role contract **1/1** on source and target.
Evidence: `.run/evidence/split/{process.json,result.json,stdout.log,stderr.log}`.
The first attempt exited 1 because PATHEXT was absent in the filtered child;
its source was stopped, its destination never created, and its retained generated
root was removed only after pg_ctl status confirmed no server (exit 3).
`attempt1.*` preserves that failure.

The documented historical reference was 59 projects/108 memories. No live data
was read. The fixture adds 58 projects, 174 observation memories with user
provenance and 58 linked jobs (20 completed through Coordinator/Core, 19 failed
at their one-attempt limit, 19 queued). Together with existing process/death,
retry, report, task/run and memory fixtures, the common-cut inventory is:

| Component | Retained cut / restored before reconciliation | Origin at declared outage | Actual lost rows |
|---|---:|---:|---:|
| Core projects | 60 | 60 | 0 |
| Core memories | 222 | 222 | 0 |
| Core tasks | 95 | 108 | 13 |
| Core executions | 54 | 54 | 0 |
| Coordinator jobs | 95 | 107 | 12 |

The target inventory is compared by exact IDs/states, not just counts. Twelve
successful post-cut write pairs run at a 75 ms minimum cadence, each committing
a Core task and a coordinator job with the same task ID before the next tick.
Every pair is present at origin and absent at destination; one additional Core
marker is also excluded. A second actual capture of both databases supplies the
mixed-generation negative. After recovery there are 223 target memories and
95 jobs: 49 completed, 23 failed, 23 queued (the cut also retained one interrupted
running job). Exactly one synthetic report effect belongs to the recovered task.
The suite creates 12 other report artifacts in its earlier receiver; this bundle
backs up one selected recovery receiver/report, not every unrelated receiver.

Observed **RPO 1985.137 ms** is monotonic common cut -> declared simulated outage
(`2026-11-08 17:17:15.270634+01` -> `2026-11-08T16:17:17.254Z`). It includes
post-cut successful writes and the later-generation capture. It is not the
522 ms capture latency. Observed **RTO 34191.374 ms** is monotonic declared outage
**before provisioning/initdb/start** -> complete authentication, independent
restores, roles and successful functional reconciliation/replay probes on both
DBs. Source writes cease at declared outage; source services are left available
only as read-only test oracles, not physically failed.

| Measured phase | ms |
|---|---:|
| Cut-generation capture (before outage; outside RTO) | 522 |
| Provision/start fresh instance and two databases | 30492.833 |
| Full authentication, including rejection experiments | 105.562 |
| Two transactional pg_restore commands | 423.874 |
| Fresh roles, old-password rejection, exact Core privilege probe | 592.480 |
| Reconciliation, negatives, concurrent CLI/replay and final probes | 2479.979 |

RTO includes native child-process completion overhead and experiments; phase
figures are diagnostics, not production SLAs. Cleanup is outside RTO: both owned
servers stopped and generated cluster directories removed. Environment variables
are restored in finally; absent unprovisioned destinations are skipped, while an
unconfirmed stop of an existing cluster retains files and fails the command.

Limits: one source instance and one destination instance, synthetic shaped data,
logical dumps, one selected report receiver, no embeddings/model inference,
production traffic, hardware loss, PITR or hostile-filesystem simulation. The
key is intentionally ephemeral; production needs independent protected key/backup
retention and a real cross-store writer-fencing protocol. The observed loss window
is constructed, not a production recovery commitment.


Shared-harness regressions after the split change: hidden PS5.1
`-FreshClusterRestore` exited 0 at 2026-11-08T16:19:24Z and `-JointRestore`
exited 0 at 16:20:22Z. Each passed native 23/23 and source role 1/1; Fresh also
asserted target role 1/1. Both had empty stderr and confirmed owned-cluster cleanup.
Logs/retained-handle exits: `.run/evidence/{FreshClusterRestore,JointRestore}/`.
Final `npm run check` exited 0 at 16:19:59Z
(`.run/evidence/split/check-final-process.json`, `check-final.log`);
`git diff --check` exited 0. Only the four authorized files changed relative to
the inherited staged baseline; no commit, deployment or production contact.


### Split fixture isolation decision (2026-11-08)

Keep the existing acceptance harness and its fixtures. Explicit `-h` alone is
insufficient: libpq `PGHOSTADDR` can override it and `PGSERVICE` can supply defaults.
Instead of changing shared runtime clients or introducing another harness, split
mode snapshots/removes every inherited `PG*` variable before any PostgreSQL command
and restores it after owned-cluster cleanup in `finally`. Node subprocesses retain
the existing environment allowlist. This changes acceptance code only.

Before createdb/migrations, sanitized `psql -X -w` reads source data_directory,
server address/port, database and user. Before native catalog writes, Core/state
admin identities are checked against the same generated source data directory;
target identity is checked against that generation's target-data directory before
CREATE DATABASE/ROLE. Windows paths are normalized and case-insensitive. All DSNs
must be the exact loopback fixture database/user identities without URL options.
Split requires a fresh target, restore mode and synthetic provider; incomplete
configuration fails at module entry even when the usual test would be skipped.
The only provisioner accepted is provision-target.ps1 in the generated
.run/coordinator-pilot-<32 hex> directory, with the wrapper-pinned SHA-256.

Invariant: no inherited connection defaults may route fixture writes, and no
catalog may be mutated before its owned generation/path and identity are verified.
A 60-second bounded provisioner timeout (formerly 30 seconds against a measured
30.49-second setup) and 120-second split restore subtest preserve headroom without
changing the 60-second legacy restore subtest. Fresh/Joint fixture and restore
bodies are retained from the exact candidate; their passes above are historical,
not reruns of this final isolation delta. The version check moved into the protected
try so split sanitization precedes it. This is trusted local acceptance isolation,
not a defense against an attacker controlling the filesystem and environment.


Final isolation run: **2026-11-08T16:35:07.8769526Z**, hidden PowerShell
**5.1.26100.9818**, Node **22.23.4**, PostgreSQL **18.4**, retained Handle and
actual OS exit **0**, empty stderr. Native **23/23**; source and target exact
Core role contracts **1/1**. Poisoned PGHOSTADDR=127.0.0.2 and a bogus PGSERVICE
were ignored throughout and restored to their original values afterward
(`PG_SENTINELS_RESTORED`). Both owned server stops are in stdout; generated source
and target directories are absent and the captured source port 50507 has no
listener. No coordinator-pilot generation directories remain.

| Final measured phase | ms |
|---|---:|
| Capture before outage | 593 |
| Provision/start fresh instance and both databases | 5098.4341 |
| Authentication and rejection experiments | 170.7470 |
| Both transactional restores | 304.7511 |
| Roles, SCRAM rejection and exact privilege probe | 465.4950 |
| Reconciliation, concurrency/replay and final probes | 1840.0294 |
| Observed RPO, common cut to declared outage | 1963.3600 |
| Observed RTO, declared outage before provisioning to full probes | 8048.9613 |

Cut: `2026-11-08 17:34:54.814256+01`; outage:
`2026-11-08T16:34:56.776Z`. The exact inventories/losses in the historical table
remain the same: 60 projects, 222 memories, 95 tasks, 54 runs, 95 jobs retained;
13 Core tasks and 12 coordinator jobs lost (12 matched pairs). Five negative
bundle cases reject; both old passwords reject with 28P01; source is intact;
handler/provider replay is zero. The final native suite took 56278.6114 ms.

Investigation retained a passing piped run whose provisioning took 60380.1363 ms.
A harmless local process reproduction showed exit 0 at 276.4644 ms but execFile's
callback at 1519.0103 ms (1500 ms timeout), versus spawn with ignored stdio exit
at 246.7522 ms. Background descendants can retain the output pipes. Split now
uses hidden spawn, ignored stdio and actual exit, with a 60-second timeout;
the final setup is comfortably within that bound. Shared legacy invocations
retain their existing behavior. The initial launcher-path and unavailable
Get-FileHash errors were corrected; .NET supplies PS5.1-compatible SHA-256.
A Node 24 attempt failed; its records are retained, and it is not counted as a pass.

Final `npm run check` on Node 22 exited **0** at 16:34:46.5638728Z;
`git diff --check` exited **0**. Direct native split with missing config and with
an arbitrary provisioner each exited **1** before connecting or writing. Those
negative proofs use only inert loopback DSNs/sentinels and execute no provisioner.
Evidence: `.run/evidence/split-final/` contains final stdout/stderr, retained-handle
process/result JSON, metrics, negative proofs, cleanup, full-check logs, patch
verification and the hardening-only diff against the exact applied candidate.
Only the four authorized files differ from inherited baseline tree
`462b441120e1b431c6c7ea317853ab85fcf1347c`; original dirty Fresh/Joint work is
preserved. This remains a synthetic logical recovery rehearsal, not production,
physical disk-loss, inference, or protected-backup certification.


## Exact directory identity and historical targets

Capture now writes JSON proof version 2, with `dev` and `ino` as canonical unsigned
64-bit decimal strings (no leading zeros). Filesystem identity checks use BigInt,
including the opened report versus its directory entry. Safe numeric identities
retain the original target hash; larger identities use a domain-separated v2
hash over the normalized canonical path and exact decimal IDs. Receipt format,
effect kind, stored targets and historical rows are unchanged.

Unversioned numeric proofs remain valid only for nonnegative safe integers.
Unsafe numbers are rejected, even when they happen to represent an exact integer:
the proof cannot establish whether precision was already lost. Version 2 never
coerces numbers to strings or accepts noncanonical decimal encodings.

An old queued or confirmed target created from an unsafe numeric inode cannot be
automatically mapped to the new exact target. Two different directories can have
the same rounded legacy ID. Even a new exact proof must not authorize that legacy
hash by rounding it. Such jobs remain blocked by the existing target/checkpoint
checks, without changing their receipts, rows or grants. Keep the old checkpoints
and backup for operator reconciliation; do not rewrite a confirmed receipt or
rerun its agent to bypass this boundary. A future migration needs independent,
trusted pre-loss exact identity evidence bound to that specific historical job
and receipt, plus an explicit audited reconciliation contract. A queued job with
no committed effect similarly needs an authorized migration/cancellation policy;
this patch does not infer one from the current directory. Capture version 2 before
new work and retain it with the coherent backup generation.

Decision: retain lossless legacy hashes and introduce exact hashes only where
needed. Keeping numeric IDs preserves rounding collisions; rehashing every target
would unnecessarily invalidate safe historical checkpoints. Automatic fallback to
a rounded hash would authorize ambiguous replacements and is intentionally absent.
Revisit migration only with independently authenticated historical identity data.
