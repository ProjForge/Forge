# Writer and report inventory in disposable PostgreSQL

The `-OperationalCoherent` rehearsal ran on Windows PowerShell 5.1, Node
22.23.4 and PostgreSQL 18.4. It used separate Core and coordinator databases
in one disposable loopback cluster, a synthetic handler and embedding provider,
and a same-host replica on a distinct volume. [Run summary](summary.json)

Thirteen managed entry-point probes rejected late admission, including direct
coordinator execution and reconciliation. The database role snapshots matched
the expected inventory before sealing, during the cut and after explicit resume.
Only the fixture operator could log in while sealed. PostgreSQL rejected six
writer logins (three roles across both databases), evicted existing migration
sessions and denied writes and DDL to the backup reader. An unlisted login role
prevented sealing without changing the declared roles or publishing a copy.

Three projects supplied three immutable reports and their receipts. Two jobs
were completed and one still awaited Core finalization. The sealed capture
matched the exact expected task set, coordinator rows and receiver files. After
removing the source cluster, primary generation and source reports, the restore
matched all three rows, complete receipts and report bytes from the replica.
The pending job reconciled once and completed jobs remained intact. Recovery
made zero new handler or provider calls.

The fixture rejected an authenticated bundle with a missing report before
provisioning. A malformed receipt also failed before the fixture accessed the
receiver. Both temporary clusters stopped and the fixture directories were
removed. The rehearsal and `npm run check` exited 0.

The multi-report payload is specific to this acceptance script. The deployed
writer inventory, full production report coverage and multi-report support in
the current single-report remote kit remain unverified. Remote restoration and
its RPO/RTO remain pending.

Reproduce from a Windows checkout on a distinct volume from the C: fixture
storage, using PostgreSQL 18.4 with pgvector and Node 22.23.4 on `PATH`.

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1 -OperationalCoherent
npm.cmd run check
```
