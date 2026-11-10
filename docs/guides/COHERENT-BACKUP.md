# Coherent backup: disposable Windows preproduction

This is an opt-in logical backup/restore path, not production activation. It builds
on PR #68's split-database rehearsal. Core's existing backup format is unchanged.

## Reusable API

`forge-resilience` exports `createCoherentGeneration` and
`withVerifiedCoherentGeneration`. `captureCoherentPostgresArchive` uses existing
safe connection/process primitives, exclusive file creation and a bounded pg_dump
process to create each actual archive without overwriting an earlier capture.
Capture supplies exactly four stable private
files: `core` and `coordinator` (actual custom-format PostgreSQL archives), `report`
(the selected confirmed report bytes), and `identity` (JSON containing source
cluster/database identities, receiver proof, selected report names and inventory).
The caller must validate that identity against the intended recovery scope in the
verified callback, before any database mutation or receiver reconciliation.

Creation requires an explicit held/drained maintenance lease (`assertHeld`) and
a capture callback. The supervisor must stop admissions and drain every writer:
Core clients, coordinator, publisher, receiver and external effects. Assertions
are checked before capture, after sealing and immediately before publication.
This is a caller contract, not a production guard or discovery of unknown writers.
Capture files must remain immutable until creation returns.

The new `forge-coherent` version 1 generation uses existing resilience AES-256-GCM,
scrypt, streaming crypto, SHA-256 and canonical manifest primitives. Each component
is bound to generation/keyId/role by authenticated data. An encrypted authenticated
inventory contains exact roles, sizes, digests, cutoff and encryption envelopes.
The public `ready.json` contains only format/version/generation/keyId and the
inventory encryption envelope. No key is included. A hidden staging directory is
self-verified and renamed to a unique final generation directory on the same
filesystem. Consumers must enumerate final UUID directories only; a staging
`ready.json` never authorizes restore. Failures remove staging and preserve all
prior generations. Atomic visibility does not certify power-loss durability.

Verification pins expected generation and keyId, authenticates the inventory and
all four components, checks exact roles/digests/lengths, then calls the restore
callback with private materializations. Altered, wrong-key, mixed, missing or
wrong-generation input never reaches that callback. Partial plaintext is removed
on failure. No unauthenticated bundle paths are reread for restore. The callback
must complete before returning; materializations are removed afterwards. Use a
protected local account/volume for source files, temporary plaintext and bundles.

Supply 32 cryptographically random bytes and an external keyId. Length validation
cannot prove entropy. Key management, rotation, escrow, protected scratch storage
and cross-writer supervisor integration remain operator requirements before
production. Generation ID must come from a trusted external selection, not merely
the bundle itself. A malicious holder of the key can forge a generation.

## Executable isolated acceptance

Use Node **22.23.4 portable**, PostgreSQL **18.4**, Windows PowerShell **5.1**:

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1 -CoherentBackup
```

`-CoherentBackup` selects the existing isolated split harness (also used by
`-SplitDatabaseRestore`). It generates loopback ports and owned disposable source
and target clusters; inherited PG environment settings are cleared/restored.
No live Forge DB, scheduler, production path, upload or S3 operation is used.
The wrapper creates an owner-only ACL random key input outside the generation.
Restore re-reads that input independently; key bytes are never logged.

The fixture supervisor closes receiver admissions and joins all worker processes
before capture. It holds EXCLUSIVE table locks in both schemas after draining,
allowing pg_dump reads while bounded concurrent UPDATE and SELECT FOR UPDATE
attempts reject with 55P03. These locks supplement the supervisor; database locks
alone do not drain receiver/publisher effects. Capture seals the two real dumps,
report and identity under that lease, then releases locks before later writes.

The same native test uses the reusable API, rejects wrong key, report corruption,
missing report, an actual later-generation coordinator archive and wrong generation
before destination schema changes. It verifies the report and identity bytes before
restoring either archive. Existing fresh-cluster role/SCRAM, inventory, lost-write,
exact receipt recovery, concurrent CLI and idle replay assertions remain in place.
Both restores use single-database transactions, but there is no distributed atomic
transaction across the two databases. Keep fresh targets isolated until both
restores and reconciliation succeed; discard failed targets.

RPO covers the monotonic common cut to declared simulated outage. RTO covers
outage before target provisioning through both DB probes, role setup and completed
CLI reconciliation/replay checks. Phase timings distinguish provisioning,
authentication and database restore. They are synthetic local measurements, not
production SLAs; generation capture cost is separately reported.

Verified 2026-11-09: retained-handle Windows PowerShell 5.1 OS exit **0**, Node
22.23.4, PostgreSQL 18.4; native **23/23**, source and target Core role **1/1**,
five encrypted-generation rejection cases and zero handler/provider replay.
One confirmed selected effect/receipt survives with one reconciliation. Retained
inventory: 60 projects, 222 memories, 95 tasks, 54 runs and 95 jobs. Observed
RPO **2640.114 ms**, RTO **10173.5527 ms**; capture 1347 ms, provisioning
4624.6364 ms, authentication/negative checks 2267.1867 ms, DB restores
372.2393 ms, roles 601.8685 ms, reconciliation/probes 2231.694 ms. Both clusters
stopped and removed; stderr empty. Full `npm run check` and `git diff --check`
exit 0. Evidence: `.run/evidence/coherent/{verified-process.json,verified-stdout.log,
check-process.json,metrics.json,candidate.json}`. Timings include the negative
verification exercises, not only a successful restore's authentication cost.

## Retention and remaining gates

Safe policy here is **no automatic deletion**. The unit fixture copies a generation
to an independent local directory and authenticates that copy before considering
it usable; it does not model a separate failure domain. Production retention may
run only after a verified independent copy and a reviewed destination/key custody
policy. No product scheduling is added.

Only one selected confirmed report is recovered. Survivor reports without a
matching receipt stay held for manual reconciliation: do not infer a receipt,
requeue them or replay their handler automatically. Unknown writers, full-volume
loss, production recovery permissions and cross-host key custody are not certified.

## Operational gate acceptance (2026-11-10)

The separately opt-in `-OperationalCoherent` mode reuses the split wrapper's
generated ports, source setup, pinned provisioner and cleanup. It does not change
the older `-CoherentBackup`, split, fresh or joint modes:

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1 -OperationalCoherent
```

Use the installed portable Node 22.23.4 on the process PATH, PG 18.4 and PS 5.1.
No production configuration, service, scheduled task, backup, disk or cloud target
is used. Evidence is `.run/evidence/operational-coherent/`.

### Actual admission boundaries

`OperationalGate` is a reusable, shared private-directory admission/drain barrier
exported by Gateway. `FORGE_OPERATIONAL_GATE_ROOT` explicitly opts a managed
topology into an already initialized gate. An unset variable preserves existing
deployments; an empty, missing, malformed or unavailable configured gate rejects.
All managed processes must receive the same absolute path. Configuration and the
directory are trusted operator inputs, not caller-controlled request parameters.
Do not activate this variable in an existing production launcher from this guide.

| Writer family / actual entrypoint | Admission lifetime | Executed acceptance |
| --- | --- | --- |
| `ForgePersistenceGateway.connect` | Common public port, including each transaction and idempotency resolution | Late `registerProject` rejects; no late project rows |
| MCP `server.ts:invoke` | Whole tool invocation; nested Gateway calls reuse admission | Real SDK linked-client `forge_register_project` rejects |
| Workbench `ForgeWorkbenchService` | Whole service operation, including multi-call agent assignment | Real loopback HTTP POST `/api/projects` rejects |
| `runEmbeddingWorker` | Entire bounded batch: provider request through vector persistence | Paused fixture provider holds drain; late batch rejects before provider |
| `Coordinator.runOnce` | Claim, heartbeat, handler, prepared output, report publication, receipt, fenced Core completion/failure | Drain waits while actual report exists without committed receipt; then waits for embeddings |
| `PostgresJobStore` public port | Enqueue/claim/heartbeat/fenced/fail/checkpoint operation | Every late operation rejects before touching its input or SQL |
| `ImmutableReportPublisher`, `RestoredReportVerifier` | Whole publication/verification; nested in coordinator admission | Direct late publication rejects; independent restored receipt reconciles once |
| SQL/migration/maintenance credentials | Durable cluster role backstop, both declared databases | Existing DDL sessions evicted; all three writer logins reject on both DBs; backup DML and DDL deny |

The barrier serializes admission and close under an exclusive filesystem mutex.
An admission remains until its awaited operation finishes, including external
effects and receipt commit. Async-local nesting allows already admitted work to
finish after close. Detached work is forbidden: a handler must await its effects.
A closed gate drains tickets with a bounded deadline. Tickets have no expiry;
process death, stale mutex, timeout, lost state or changed ownership cannot cause
an automatic reopen. Even after an admission holder dies, its ticket stays held
for operator reconciliation. Do not delete tickets merely because a PID is absent.
The file gate covers cooperative processes on this trusted Windows host; it is
not a distributed lease service or a hostile-process security boundary.

### SQL backstop and exact trust

After managed drain, `sealCoherentDatabases` validates loopback cluster directory,
both database identities, the complete login-role inventory and limited role
attributes. It rejects undeclared login roles and declared role memberships. It
checks backup-reader persistent DML/DDL/sequence-write authority in both DBs.
Writer `NOLOGIN` changes commit together, then existing non-operator
connections in both DBs are terminated and their rollback/session exit is bounded.
This includes direct SQL, schema migrations and maintenance using those roles.
SQL activity during the closing/drain phase is therefore before the common cut;
no capture starts until both managed and database drains validate. Existing Core
grants are preserved. No Core migration or broad writer grant is introduced.

The backup role is NOLOGIN with schema USAGE and SELECT on existing user
 tables/sequences. Only the synthetic SCRAM superuser operator can log in while
sealed. pg_dump authenticates as that operator and uses --role=operational_backup.
Permission probes use SET LOCAL ROLE in normal transactions with ROLLBACK on
admin fixture connections to each database; 42501 proves privilege denial.
No catalog privilege revocation is claimed: PUBLIC catalog functions remain,
but the backup role has no separately authenticable session. The same named
operator is explicitly trusted outside the barrier for provisioning, monitoring
and recovery. Direct superuser/admin misuse, privilege changes by that operator,
unknown external receivers, unawaited effects and processes deliberately omitting
the gate are excluded. Unknown SQL credentials cause rejection rather than an
assumption that a table lock covers them.

Creation revalidates ownership/database admission before and after capture/seal
and immediately before publication. Normal completion authenticates the generation
and replica before explicit DB LOGIN restoration, then managed resume. Failure
never restores LOGIN in `finally`. Connection loss leaves roles NOLOGIN; reconnect
or timer expiry cannot reopen them. Operator recovery must inspect both DBs,
effects, receipts and tickets, abandon incomplete staging, restore only the
recorded limited role states, then explicitly resume. The executable negative
uses the trusted disposable operator to perform this manual reconciliation after
a deliberately lost DB controller. No production recovery automation is supplied.

### Custody and replica-only recovery

`createWrappedCoherentKey` generates 32 random bytes and persists only an
RSA-OAEP-SHA256 wrapped record. The OAEP label binds the external key ID; generation
encryption also authenticates that ID. `readWrappedCoherentKey` requires the
expected ID and independent escrow key. The fixture generates a synthetic RSA
escrow key in a separate custody directory under an owner-only inherited Windows
ACL, with no key bytes in logs, environment variables or the generation. Windows
mode bits alone are not treated as ACL protection. Scratch materializations also
inherit that private root. The escrow private PEM is ACL-protected, not encrypted
at rest: this is trusted local fixture custody, not a hardware vault, separate
administrator, DPAPI identity guarantee or protection against the same account or
host compromise. JS/native crypto memory erasure is not certified; owned key
buffers are zeroed when no longer needed.

`replicateCoherentGeneration` rejects same-device siblings, links and unexpected
component inventory. It authenticates source and complete copied staging before
renaming into a unique reserved generation directory. Only its final `bundle`
child is consumable; a crash can leave an empty reservation but never a usable
partial bundle. Existing replicas are never replaced. Windows device IDs prove
E: source versus C: replica in `metrics.json`; custody, replica and scratch use
separate generated directories. Both volumes share the Windows host. No separate
host, controller, independent power, ransomware or physical-failure guarantee is
claimed. No automatic retention or pruning is enabled.

Before independent restore the fixture stops and removes the owned source
cluster, deletes primary sealed generation and plaintext archives, removes the
source reports and zeroes its capture key buffer. A new Node process rereads
external wrapped custody and restores exclusively from the verified C: replica.
Restore accepts one parent fork IPC message, never a JSON configuration path or
command-line restore mode. No restore configuration containing synthetic secrets
is written to disk. The child pins the current worktree fixture root, exact
provision-target.ps1 path/hash and fixture port from the minimal session environment.
Before PowerShell or DB connections it requires postgresql://forge_pilot at
127.0.0.1, /postgres, no query/fragment, an absent source PGDATA and absent target
PGDATA. It builds its provisioner environment from the system allowlist plus two
synthetic fixture variables; it never accepts a provisioner environment via IPC.
Foreign-target and altered-provisioner-path children are rejected before the
provision-start IPC marker, as are all five custody/replica negatives. After
provisioning, SQL also checks actual role, database, host, port and PGDATA.
Wrong/missing custody, wrong key ID, corrupted ciphertext and missing replica
component reject before target initdb or either target database mutation. A fresh
target and new limited roles are provisioned only after full authentication.
Each pg_restore is transactional; the two DB restores are not one distributed
transaction. Targets stay isolated until both restores, exact Core role contract
and report reconciliation pass. Failed targets are disposable.

The retained report receipt is reconciled once using the existing exact NTFS
target proof/replacement-directory rules. The original #69 identity arithmetic,
publication, verification and retry contracts are preserved. No handler/provider
replay is allowed. A known post-cutoff project is absent after restore. Survivor
reports without receipts still require manual reconciliation; this gate does not
invent confirmations for unknown receivers.

RPO uses monotonic common drained cut through declared outage after one committed
post-cut write. RTO uses outage through source removal, independent custody and
replica negatives, target provisioning, both actual archive restores, receipt
reconciliation/repetition checks and the exact limited Core-role test. Negative
exercises are included in these synthetic measured durations. positiveRestoreMs
separately times the successful child from before fork through its actual exit;
it includes validation/authentication, provision, restore and reconciliation, and
excludes the seven negative child exercises and source removal. Neither is a
production SLA, power-loss test or physical WAL/PITR certification.

Current operational closure evidence is in
`.run/evidence/operational-coherent/{native-exit,check-exit,metrics,restore,cleanup}.json`.
PS5.1 retained-handle OS exit 0, Node 22.23.4/PG18.4. Authentication and
normal-transaction permission counters are in metrics.json; measured RPO/RTO
are synthetic and include the negative exercises described above. Original
receipt reconciled once with zero handler/provider replay. Both generated roots
were removed. Workbench's expected closed-gate HTTP rejection is logged on stderr.
Earlier coherent-mode native 23/23 and Core role 1/1 results remain historical;
they are not additional tests run by OperationalCoherent.

Historical context: supplied Windows-local vault note
`ec881df6-73db-4f09-a20e-422553898155` records the earlier joint restoration
rehearsal and its synthetic limits; those results are not counted as new evidence.
