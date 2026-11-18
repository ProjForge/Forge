# Sealed audit after a two-database restore

This opt-in Windows acceptance uses PR83 main `a965663b28826e118ed8ca3a330c48e6b6c819c0` with PostgreSQL 18.4 and Node.js 22.23.4. The wrapper supplies a generated loopback port, an owned disposable PostgreSQL cluster and a private scratch directory. The report receiver and its proof stay on the original NTFS storage until wrapper cleanup.

1. Before fixture writes, both admin connections must match the owned PostgreSQL 18.4 data directory and exact loopback endpoint. The limited Core and state URLs derive from those endpoints with generated passwords. Read-only login, role, database, address and port checks precede writes by the limited roles. The separate IPC publisher validates its inputs and checks the cluster and limited roles again.
2. The real coordinator and immutable publisher complete one synthetic task before the cut. With the writer connections closed, `pg_dump` captures separate Core and state custom archives under the existing fixture backup role. Read-only snapshots bracket the two dumps.
3. A new task and job are created after both archives finish. A separate coordinator process writes the report and commits its receipt. The parent verifies the committed receipt before killing that process and waits for its OS exit. The closed source gate retains the stranded ticket.
4. The wrapper's owned cluster hosts two freshly recreated databases under the original names. Both archives restore with transactional `pg_restore`, preserving object ACLs. The fixture reapplies its original Core database-level `CONNECT` ACL for `forge_runtime`. The restored state matches the cut and retains the sibling receipt. The new task, job and receipt are absent while the physical report file, hash and receiver proof are unchanged.
5. A new drained `OperationalGate` and `sealCoherentDatabases` hold the restored databases closed to writers. Two real `audit-reports` calls use `FORGE_COORDINATOR_AUDIT_ROLE=operational_backup`. The PR83 observer attests the actual roles and read-only transaction on the connection reading jobs. Both calls must return OS exit 1, one exact orphan finding and one confirmed report. Database rows, roles and grants, report files, proof, both gate directories and tickets must match the pre-audit snapshots.

## Reproduce

Use Windows PowerShell 5.1, local NTFS, installed workspace dependencies and native PostgreSQL 18.4 with pgvector. The wrapper needs write access to the repository's `.run` directory and to the current Windows account's local C: temporary directory. From the repository root, set `$nodeBin` to the Node.js 22.23.4 directory. Launch from PowerShell using a retained process handle and redirected streams. Review only the sanitized summary after OS exit.

```powershell
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$start.Arguments = '-NoLogo -NoProfile -NonInteractive -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1 -SealedOrphanRestore'
$start.WorkingDirectory = (Get-Location).Path
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WindowStyle = 'Hidden'
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
foreach ($key in @($start.EnvironmentVariables.Keys)) {
    if ($key -match '^(PG|FORGE|NODE_OPTIONS$)') { $start.EnvironmentVariables.Remove($key) }
}
$start.EnvironmentVariables['PATH'] = "$nodeBin;$env:PATH"
$child = [Diagnostics.Process]::Start($start)
$null = $child.Handle
$stdout = $child.StandardOutput.ReadToEndAsync()
$stderr = $child.StandardError.ReadToEndAsync()
if (-not $child.WaitForExit(720000)) {
    throw 'Launcher observation timed out. Leave the wrapper running so it can finish its owned-cluster cleanup.'
}
$code = $child.ExitCode
if ($code -ne 0 -or $stdout.Result -notmatch 'PASS sealed orphan restore' -or $stderr.Result.Trim()) {
    throw "Sealed orphan fixture failed its launcher checks (OS exit $code)"
}
```

The wrapper limits Core migrations and runtime role setup to 60 seconds each, the build to 5 minutes, and the Node fixture to 135 seconds. On timeout it targets the foreground child tree and allows up to 15 seconds to confirm termination. PostgreSQL starts separately and is stopped by the wrapper's cleanup. The launcher's 12-minute observation window includes startup and cleanup.

After a workspace build, run `node --test scripts/acceptance/sealed-orphan-restore.test.mjs` with inherited PostgreSQL environment variables cleared. The tests check the canonical Core endpoint, reject mismatched DSNs without network connections, and reject direct publisher invocation.

Each run writes sanitized `result.json`, `wrapper-result.json` and `cleanup.json` under its own `.run/evidence/sealed-orphan-restore/` subdirectory.

## Observed result

The final hidden PowerShell 5.1 launcher exited 0 in 22.814 seconds with empty stderr. The three scope tests and the PowerShell parser check passed. Both dumps and both restores exited 0. The source publisher exited on `SIGKILL` and the closed source gate retained one ticket. Both audit processes exited 1 with identical `review_required` results, one orphan and one confirmed sibling. The observer recorded login role `forge_pilot`, effective role `operational_backup` and a read-only transaction on each jobs read. Writers remained `NOLOGIN` through shutdown with zero resume attempts and zero Core, agent or provider calls from the audit. The wrapper stopped the cluster, removed both owned roots and verified that the generated loopback port refused connections. [Sanitized run record](result.json)

Two additional runs loaded a synthetic Node preloader from a relative path under .run and kept the event loop alive only in the selected provisioning script. Core migrations and runtime role setup independently reached their 60-second deadlines. The launchers exited 1 after 68.649 and 68.637 seconds respectively, including PostgreSQL startup and shutdown. Both runs confirmed foreground process tree termination, stopped the owned PostgreSQL cluster, removed both scratch roots and verified that the allocated loopback port refused connections.

The fixture recreates both databases within one disposable local PostgreSQL instance. It checks the sealed audit only. Remote restoration remains pending.
