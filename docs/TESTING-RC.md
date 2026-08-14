# Testing a FORGE release candidate

Release candidates are for technical evaluation on non-critical data. They are
not signed general-user releases.

## Before installing

- Use Windows 10/11 x64 with PostgreSQL 14+ and Node.js 20+/npm 10+.
- Keep production databases and irreplaceable project data out of the test.
- Download `SHA256SUMS.txt` with the archives and verify the selected file:

```powershell
Get-FileHash .\FORGE-Workbench-0.2.0-rc.2-Windows-x64.zip -Algorithm SHA256
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

## Smoke test

1. Launch FORGE Workbench and confirm it opens only on `127.0.0.1`.
2. Create or select a disposable project.
3. Create a task, assign an agent and change its status.
4. Add a memory and a decision; verify both remain project-scoped.
5. Restart PostgreSQL and Workbench; confirm the project data persists.
6. Inspect Continuidad. Missing recovery configuration must appear unavailable,
   never falsely healthy.
7. Resize the window and check that navigation and actions remain usable.

Semantic search and recovery are optional; test them only when deliberately
configured.

## Report feedback

Use the GitHub bug-report template. Include the rc version, Windows and
PostgreSQL versions, exact steps, expected/actual behavior and sanitized logs.
Never attach passwords, connection URLs, DPAPI files, database dumps, backup
packages, access keys or recovery manifests.

To remove the Workbench while preserving durable database data:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\FORGE Workbench\Uninstall-FORGE-Workbench.ps1"
```
