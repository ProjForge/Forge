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
