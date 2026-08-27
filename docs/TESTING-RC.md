# Testing a FORGE release candidate

Release candidates are for technical evaluation on non-critical data. They are
not signed general-user releases.

## Before installing

- Use Windows 10/11 x64 with PostgreSQL 14+ and Node.js 20+/npm 10+.
- Keep production databases and irreplaceable project data out of the test.
- Download `SHA256SUMS.txt` with the archives and verify the selected file:

```powershell
Get-FileHash .\FORGE-Workbench-0.2.0-rc.5-Windows-x64.zip -Algorithm SHA256
```

The result must equal the corresponding value in `SHA256SUMS.txt`. Stop if it
does not. An unsigned candidate may show an unknown-publisher warning.

## Install

For a complete new setup, extract the source archive and follow
[`INSTALL-WINDOWS.md`](INSTALL-WINDOWS.md), starting with `-PlanOnly`.

For an existing compatible FORGE database, extract the Workbench archive and
run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-FORGE-Workbench.ps1
```

## Update from rc.4

Before updating, record hashes of the shared configuration and encrypted
credential. Do not copy or publish either file:

```powershell
$forgeConfigRoot = Join-Path $env:APPDATA 'FORGE'
$forgeConfig = Get-Content -Raw -LiteralPath (Join-Path $forgeConfigRoot 'workbench.json') | ConvertFrom-Json
Get-FileHash (Join-Path $forgeConfigRoot 'workbench.json') -Algorithm SHA256
Get-FileHash (Join-Path $forgeConfigRoot ([string]$forgeConfig.database.credentialFile)) -Algorithm SHA256
```

Run the rc.5 installer normally, without database parameters. It must identify
the existing installation as an update, must not request the PostgreSQL
password, and both hashes must remain unchanged. `RELEASE.json` under the
installed application must report `0.2.0-rc.5`.

## Smoke test

1. Launch FORGE Workbench and confirm it opens only on `127.0.0.1`.
2. Create or select a disposable project.
3. From Inicio, follow the recommended next action; create a task, assign an
   agent and change its status under Trabajo.
4. Add a memory and a decision; verify both remain project-scoped.
5. Restart PostgreSQL and Workbench; confirm the project data persists.
6. Inspect Recuperación. Missing recovery configuration must appear unavailable,
   never falsely healthy.
7. Resize the window and check that navigation and actions remain usable.

Semantic search and recovery are optional; test them only when deliberately
configured.

## Repeatable clean local lab

Windows Sandbox can run the published candidate against a new disposable
PostgreSQL cluster without changing the host installation or database. From a
source checkout with dependencies already installed and built, run:

```powershell
npm ci
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\acceptance\windows-sandbox\Start-FORGE-WorkbenchTestLab.ps1
```

The launcher downloads the pinned public rc.5 Windows archive, verifies its
published SHA-256 before extraction, maps all inputs read-only, disables guest
networking and opens Workbench when the fresh schema is ready. The host receives
only a bounded, secret-free `lab-result.json` status file. Closing Windows
Sandbox deletes the database, configuration, credentials and application, so
the same command starts another clean test.

Use `-PlanOnly` for a non-mutating preflight. Use `-ReleaseArchive <path>` to
test an already downloaded archive; it is still checked against the pinned
digest. Clipboard sharing is disabled by default and can be enabled explicitly
with `-EnableClipboard` when copying test notes is useful.

This lab is the primary fast feedback loop for clean install and UI workflows.
External testers remain valuable for different hardware and usage patterns,
but are not required for each development iteration.

## Raspberry Pi 5 ARM64 acceptance

A Raspberry Pi 5 with 8 GB RAM provides optional Linux ARM64 evidence for Core,
native PostgreSQL continuity and project portability. The gate passed on a Pi 5
Model B Rev 1.1 running Debian 13. It does not test the Windows package or
require users to own ARM hardware. Follow
[`RASPBERRY-PI-5-ACCEPTANCE.md`](RASPBERRY-PI-5-ACCEPTANCE.md) for the exact
evidence and runner; its loopback Docker database and volume are disposable.

If the Windows Sandbox component itself does not start, use the local fallback:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\acceptance\Start-FORGE-WorkbenchLocalTestLab.ps1
```

It runs the same pinned public package against a fresh PostgreSQL data directory,
an isolated application directory and an isolated `%APPDATA%` profile on unused
non-production ports. Keep its PowerShell window open while testing; pressing
Enter stops both processes and erases the complete lab. This fallback shares
the host Windows/browser, so it validates application workflows but does not
replace Sandbox or VM acceptance for SmartScreen and machine-level installer
behavior.

## Report feedback

Use the GitHub bug-report template. Include the rc version, Windows and
PostgreSQL versions, exact steps and expected/actual behavior. Prefer the
allowlist-only bundle produced by installed `Export-FORGE-Diagnostics.ps1`
over manually copied logs.
Never attach passwords, connection URLs, DPAPI files, database dumps, backup
packages, access keys or recovery manifests.

To remove the Workbench while preserving durable database data:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\FORGE Workbench\Uninstall-FORGE-Workbench.ps1"
```
