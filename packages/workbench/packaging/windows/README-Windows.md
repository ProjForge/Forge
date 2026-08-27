# FORGE Workbench 0.2.0-rc.5 — Windows x64

This is a FORGE technical release candidate. PostgreSQL with the compatible
FORGE schema must already be available. LM Studio is optional for catalog and
write operations, and required for semantic search. Check `RELEASE.json` and
the release notes for this package's signing status.

## Install

Open PowerShell in this folder and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-FORGE-Workbench.ps1
```

The installer asks for the PostgreSQL runtime password without echoing it,
encrypts it with Windows CurrentUser DPAPI, installs under `%LOCALAPPDATA%`,
and creates a per-user Start Menu shortcut. No administrator permission is
required.

The package verifies its complete internal SHA-256 manifest before changing
the installation. Running a newer package performs a transactional update and
preserves the existing JSON configuration and DPAPI credential without asking
for the database password again. Accidental downgrades are rejected.

To deliberately change the database identity or Workbench port during an
update, pass `-Reconfigure` together with the new values. This requires the
runtime password and atomically replaces the encrypted credential.

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
