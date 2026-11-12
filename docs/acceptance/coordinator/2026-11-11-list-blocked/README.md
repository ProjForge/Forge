# Blocked coordinator jobs

The Windows rehearsal on 2026-11-11 used PowerShell 5.1, Node 22.23.4 and
PostgreSQL 18.4. `Test-FORGE-CoordinatorPilot.ps1 -JointRestore` created a
disposable loopback cluster and used synthetic tasks and a local provider fixture.

The native regression killed a worker on its final attempt and let its lease
expire. Before another claim, the listing found the job with its persisted
`running` state and an `ATTEMPTS_EXHAUSTED` reason. The read left the row intact.

The CLI regression found terminal failures, including `EFFECT_UNCONFIRMED`, and
exhausted jobs. It excluded active leases, retryable jobs, completed jobs and
rows from another project. It checked both pages of a 54-result fixture, cursor
validation and the exact output fields. The CLI ran without a Core connection
string and with invalid report and agent settings. The coordinator rows,
including prepared output and receipts, matched their pre-query snapshot.

The fixture exited 0 with 25 native tests and one Core limited-role contract
passing. The listener closed and the fixture left no new directories.
`npm run check` and `git diff --check` also exited 0 on the applied code.
The [sanitized run summary](native-summary.json) records the test output and
cleanup observations. Remote restoration remains pending.

To reproduce from the repository root with Node 22 on `PATH` and PostgreSQL 18
with pgvector installed, select an unused local port and run the pilot.

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1 -JointRestore -Port 60157
npm.cmd run check
```
