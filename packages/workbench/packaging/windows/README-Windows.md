# FORGE Workbench 0.2.0-rc.6 — Windows x64

This is a FORGE technical release candidate. PostgreSQL with the compatible
FORGE schema must already be available. LM Studio is optional for catalog and
write operations, and required for semantic search. Check `RELEASE.json` and
the release notes for this package's signing status.

## Install

Extract the entire ZIP, then open `FORGE-Setup.exe` from the extracted folder.
Setup verifies the internal SHA-256 manifest and checks PostgreSQL credentials,
schema and runtime permissions before installing. It can test the connection
separately. The database check uses a read-only session.

Setup installs under `%LOCALAPPDATA%` for the current user and adds a Start Menu
shortcut. No administrator permission is required. **Actualizar** preserves the
saved settings and CurrentUser DPAPI credential byte for byte. **Cambiar
conexión** checks and saves the new connection independently of application
updates. Setup rejects accidental downgrades.

For console use, run `.\Install-FORGE-Workbench.ps1` from a Windows PowerShell
session where script execution is permitted. Pass `-Reconfigure` to change the
connection or Workbench port, or `-CheckOnly` to test without installing.
The console prompts for the password securely when needed.

Configuration lives at `%APPDATA%\FORGE\workbench.json`. The password is kept
separately in `%APPDATA%\FORGE\workbench.dpapi` and can only be decrypted by
the same Windows user on the same machine.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\FORGE Workbench\Uninstall-FORGE-Workbench.ps1"
```

Add `-PurgeUserData` only when the encrypted credential and Workbench
configuration should also be removed.

## Safe diagnostics

Create a tester support bundle with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\FORGE Workbench\Export-FORGE-Diagnostics.ps1"
```

The ZIP is allowlist-only. It reports product/Windows versions, signature and
binary hash, boolean configuration health, bounded bootstrap state,
PostgreSQL service state and FORGE scheduled-task results. It never copies raw
logs, configuration, database content, DPAPI material, usernames or hostnames.

## Release limitations

- An unsigned technical prerelease may trigger Windows SmartScreen. A signed
  package must pass the timestamped Authenticode release gate.
- The FORGE database/schema bootstrap remains a separate prerequisite.
- General-user promotion remains blocked until signed-package acceptance and
  rollback are exercised.
