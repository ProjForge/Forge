# Read-only orphan report reconciliation

2026-11-17: **PASS** in disposable local PostgreSQL 18.4, Windows PowerShell
5.1 and Node 22.23.4. The provider was a loopback fixture. Production and the
independent-host remote restore were outside this rehearsal.

## Behavior and scope

`node packages/coordinator/dist/cli.js audit-reports <proof-file>` compares the
configured original receiver with coordinator checkpoints across all projects.
It needs only `FORGE_COORDINATOR_DATABASE_URL`,
`FORGE_COORDINATOR_REPORT_ROOT` and a trusted pre-loss receiver proof. An orphan
is identified by its hashed filename and classification, never by invented
project/task IDs. No Core/provider configuration is needed.

Keep writers stopped and use the proof captured before the loss or retained in
an authenticated record. Keep it outside the receiver. Missing, malformed or
mismatched proof makes the audit incomplete before querying jobs. A proof
captured from a replacement after the incident cannot establish the old identity.
This command checks the original physical receiver; replacement recovery remains
a separate procedure.

| Outcome | Exit | Meaning |
| --- | --- | --- |
| `complete` | 0 | The bounded comparison finished without findings. |
| `review_required` | 1 | Orphan, unconfirmed, missing, changed or invalid entries/checkpoints need review. |
| `incomplete` | 1 | Identity, stability, input, connection or resource limits prevented a complete comparison. |

The SQL transaction is repeatable-read and read-only. Two bounded directory
inventories and descriptor/metadata checks detect observed changes. The limits
are 1,024 jobs, 4,096 entries, 4,096 proof bytes and bounded checkpoint/report
reads. Root links are rejected; ancestor paths resolve through realpath and
must remain private and stable. SQL and the filesystem have no joint atomic
snapshot. The result does not certify a backup, Core completion or dispatch
readiness. It never repairs, claims, requeues, publishes or creates a receipt.

## Real rollback rehearsal

The regression extends the [post-cut survivor case](../2026-11-17-post-cut-survivor/README.md)
while retaining its prior assertions. Both archives precede creation of the new
task and queue row:

| Observation | UTC on 2026-11-17 |
| --- | --- |
| Core archive completed | 21:37:24.135 |
| Coordinator archive completed | 21:37:24.266 |
| New task created | 21:37:24.273 |
| New queue row created | 21:37:24.274 |
| Genuine publisher receipt observed in source | 21:37:24.501 |

A real child called the fixture provider, published the immutable report and
persisted its receipt. The test killed it after the receipt signal and waited
for exit. Real pg_restore calls recovered both earlier dumps into new databases,
without recreating the receiver or deleting SQL checkpoints to simulate loss.
The new task and queue row were absent after restoration; the original file,
bytes, device/inode and modification time survived.

The CLI ran twice against restored state under a SELECT-only account, with the
operational gate closed and no Core/provider DSN. Both calls returned the exact
same JSON and exit 1:

- Three known jobs and three report files were inspected.
- One report was confirmed; one job was pending without a file.
- One file was an `orphan` and one known report was `unconfirmed`.
- Core, queue/checkpoints, files and gate/tickets snapshots stayed unchanged.
- The confirmed sibling later completed once with its original receipt;
  replay was idle, with zero handler/provider calls during recovery.

Oversized checkpoint negatives used malformed data only in a sacrificial pending
fixture row and restored its original NULL values. Both artifact and receipt
budgets produced `incomplete`. No valid substitute receipt was generated or
adopted for the orphan.

## Regression validation

`npm run check` passed 140 tests, including 36 coordinator tests. The hidden
native acceptance exited 0: 29/29 coordinator tests, 1/1 source Core role test,
restored limited-role checks, empty stderr, both clusters stopped and zero
fixture roots remaining.

Independent filesystem probes reproduced the old false completion after a late
file addition, then confirmed `incomplete` in the correction. A replaced empty
receiver was rejected without querying jobs. Unit regressions also cover late
deletion/modification, proof identity/format, links, bounds and invalid data.

The [worker summary](summary.json) preserves measured times, hashes, exits and
the failed fixture/collector/environment attempts rather than presenting them
as successes. Original local logs are retained in
`.run/evidence/orphan-report-audit/`. Published JSON uses LF; its original
Windows-byte hash and the exact reviewed backend candidate are recorded in
[checkout validation](checkout-validation.json).

Functional and security reviews approved the final candidate. All seven applied
files matched the tested Windows bytes. The applied checkout passed all 140
check tests and the independent drift/replacement probe. The summary's
`canonicalPatchSha256` identifies its input candidate; checkout validation
records the final reviewed backend patch separately.

Reproduce with Node 22.23.4 on PATH and PostgreSQL 18.4 installed:

~~~powershell
powershell.exe -NoProfile -NonInteractive -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1 -SplitDatabaseRestore
~~~

Remote restoration, independent-host custody acceptance and remote RPO/RTO
remain pending. No production workers or services were activated.
