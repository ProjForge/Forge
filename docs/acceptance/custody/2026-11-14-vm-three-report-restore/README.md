# Windows VM kit rehearsal with three reports

The reviewed kit was built from the source based on `f054f26` and exercised on
2026-11-14 in two sequential Windows Sandbox guests with networking disabled.
The source used `Start-Rehearsal.ps1 -Role Source`. The destination used
`Start-VmDestination.ps1` and `Submit-VmReplica.ps1` with the direct VM path.
A test-only relay rewrapped the synthetic encryption key in memory for the
destination custodian. The destination private key stayed in its guest.

Both `pg_restore` calls passed with PostgreSQL 18.4. All seven table hashes
matched before reconciliation, including the pgvector fixture. The destination
verified all three report byte hashes and complete receipts against the source.
Two completed jobs stayed unchanged. Only the pending job reconciled and a
second invocation returned idle. No handler or provider ran during recovery.

The custodian authenticated the four components before provisioning.
Wrong-key and ciphertext negatives were rejected before PostgreSQL started.
The build's offline smoke check additionally rejected 17 semantic cases,
including an authenticated collection missing one report. PostgreSQL started
only in the two native guests. The standard noncustodian account was denied
private-key access (Win32 5). Temporary accounts, plaintext, the owned task
and both clusters were removed. Both guests closed and the harness exited 0.

The successful package uses an offline-capable PostgreSQL 18.4 distribution
with its required Windows DLLs. An initial build using only the host's installed
PostgreSQL tree passed the offline format smoke but failed to load `postgres.exe`
in the source guest with `0xC0000135`. Rebuilding with the prior portable
runtime resolved the loader failure without changing the kit scripts.

The [sanitized summary](summary.json) records the archive hash, receipts and
per-report results. This rehearsal used one physical host. Independent-host
restoration and remote RPO/RTO remain pending. See the
[kit instructions](../../../../scripts/acceptance/remote-coherent-vm/README.md).
