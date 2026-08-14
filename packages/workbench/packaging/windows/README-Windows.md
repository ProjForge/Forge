# FORGE Workbench 0.2.0-rc.1 — Windows x64

This is an unsigned local release candidate. PostgreSQL with the compatible
FORGE schema must already be available. LM Studio is optional for catalog and
write operations, and required for semantic search.

## Install

Open PowerShell in this folder and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-FORGE-Workbench.ps1
```

The installer asks for the PostgreSQL runtime password without echoing it,
encrypts it with Windows CurrentUser DPAPI, installs under `%LOCALAPPDATA%`,
and creates a per-user Start Menu shortcut. No administrator permission is
required.

Configuration lives at `%APPDATA%\FORGE\workbench.json`. The password is kept
separately in `%APPDATA%\FORGE\workbench.dpapi` and can only be decrypted by
the same Windows user on the same machine.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\FORGE Workbench\Uninstall-FORGE-Workbench.ps1"
```

Add `-PurgeUserData` only when the encrypted credential and Workbench
configuration should also be removed.

## Release limitations

- The executable is not code-signed; Windows SmartScreen may warn.
- The FORGE database/schema bootstrap remains a separate prerequisite.
- A signing identity must be selected before a signed general-user release.
