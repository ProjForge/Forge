# Post-cut report survives a worker crash

2026-11-17: **PASS**, using Windows PowerShell 5.1, Node 22.23.4 and disposable
PostgreSQL 18.4. The provider was a loopback protocol fixture. No production
database, worker, service or recovery destination was used.

## Rehearsal

The regression creates two jobs for one isolated project and agent. A real child
publishes the confirmed job's report and stores its prepared output and receipt
before being killed. With writers stopped, the test takes real custom-format
dumps of the separate Core and coordinator databases.

Only after **both** dumps finish does another child process claim the survivor
job, call the fixture provider, publish its report and persist its real receipt.
The test waits for the post-receipt signal, kills the child and waits for exit.
It restores both archives with `pg_restore --exit-on-error --single-transaction`
into two new databases on the disposable source cluster, preserving the original
physical receiver. The four database OIDs are distinct.

| Observation | UTC on 2026-11-17 |
| --- | --- |
| Core dump completed | 20:14:00.852 |
| Coordinator dump completed | 20:14:01.082 |
| Survivor execution started | 20:14:01.448 |
| Receipt observed in the source database | 20:14:01.519 |

`receiptRowUpdatedAt` is the row's update timestamp, not a commit timestamp.
`receiptObservedAt` bounds when the receipt was already visible. Archive and
report hashes are recorded in [summary.json](summary.json). No SQL checkpoint
deletion or manually constructed receipt substitutes for the restore.

## Assertions

- The restored survivor task and entire queue row match the cut: `ready/queued`,
  no execution, prepared output or receipt.
- Its first claim ends in `failed / EFFECT_UNCONFIRMED` on attempt 1. The only Core
  port call is `assertReady`; the Core snapshot remains unchanged.
- `list-blocked` runs without a Core DSN and finds that job. Immediate snapshots
  preserve both restored queue rows and Core in both source and destination.
- The confirmed sibling then completes with its original receipt and prepared
  output: one execution, memory and context, with one entry per expected audit
  action. Recovery makes zero handler/provider calls. The sole publisher call
  verifies the existing confirmed report.
- Another run is `idle`; the blocked row, attempts and completed result stay
  unchanged. Both report paths, device/inode identities, modification times and
  bytes remain exact; no new report appears.
- The existing Core limited-role contract passes against the newly restored
  Core database without skips. The restored coordinator connection has no
  elevated role attributes or memberships.

## Validation and reproduction

`npm run check` passed all 134 tests. The hidden native process exited 0 with
29/29 native tests, no skips, empty stderr and the source role contract 1/1.
The restored-Core role contract also ran within the new subtest. Both disposable
clusters stopped and no fixture root remained. `git diff --check` passed.

Final independent review `564a5e5c-5138-428e-a8e1-5e459b2fa1d7` approved the exact
candidate. After application, the source hash remained identical and the checkout
passed all 134 check tests again, exit 0. See [checkout validation](checkout-validation.json)
for the applied source, candidate and review identities and log hash.
Published JSON uses LF for stable hashes across checkouts. The original Windows
summary hash remains recorded as `testedSummarySha256` in checkout validation.

With Node 22.23.4 on PATH and PostgreSQL 18.4 installed:

~~~powershell
powershell.exe -NoProfile -NonInteractive -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1 -SplitDatabaseRestore
~~~

Implementation: [native.test.ts](../../../../packages/coordinator/tests/native.test.ts).
Local raw logs and their manifest are retained under
`.run/evidence/post-cut-survivor/`.

| Artifact | SHA-256 |
| --- | --- |
| Tested source file | `79003d7dcd15c41c98242cb63e105768287ddac84d19c83173ea7b90b2fd5d7f` |
| Tested patch | `4baaf9af8be8a5e5e086f86c84631031acf74752877dda890680cb1adda91474` |
| Published summary | `2be0c93c0a7de79d44c84f9256391a892e5fb96cad7aeac789615f6beb956093` |

This proves local logical rollback with a retained receiver and a worker-process
crash. An unconfirmed survivor still needs independent operator evidence; the
worker does not manufacture a receipt or repeat its effect. Remote restoration,
independent-host acceptance and remote RPO/RTO remain pending.
