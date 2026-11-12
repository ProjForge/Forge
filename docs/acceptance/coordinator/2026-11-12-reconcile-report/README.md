# Reconcile a confirmed report after the final attempt

The Windows rehearsal ran on 2026-11-12 with PowerShell 5.1, Node 22.23.4 and
PostgreSQL 18.4. The `-SplitDatabaseRestore` fixture used separate Core and
coordinator databases, disposable loopback clusters and a synthetic provider.

The native tests killed a worker on its final attempt after `finishExecution`
committed in Core and before the coordinator transaction committed. The CLI
reconciled the expired row both before and after the worker sweep. Two concurrent
calls returned `completed` and `already_completed`; replay was a no-op.
Core task, execution, memories, contexts, events and audit matched their prior
snapshots. The report bytes, file identity, modification time, receipt and
provider call count were preserved across reconciliation.

An active lease, `EFFECT_UNCONFIRMED`, missing or invalid report evidence,
and unfinished Core were rejected with the selected row intact. With operational
admission configured, the closed barrier rejected the operation. Normal controller
resume admitted the same command while the other writers stayed stopped.

The fixture process exited 0. All 28 native tests and the Core limited-role
contract passed. Both clusters stopped and no new fixture directories remained.
`npm run check` and `git diff --check` also passed. The
[sanitized run summary](native-summary.json) records selected test output and
cleanup results. Remote restoration remains pending.

Reproduce from the repository root with Node 22 on `PATH` and local PostgreSQL
18.4 with pgvector installed.

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1 -SplitDatabaseRestore
npm.cmd run check
```
