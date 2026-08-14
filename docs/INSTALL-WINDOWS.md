# Windows bootstrap

Status: validated implementation

The source bootstrap installs a generic FORGE environment on Windows without
binding it to a particular project, agent or model provider. It creates the
database when needed, applies checksum-aware migrations, configures a dedicated
least-privilege runtime role, writes one shared non-secret configuration and
stores the runtime password with CurrentUser DPAPI.
The database phase is accepted only after the native runtime-role permission
suite proves the configured identity cannot create schema objects or mutate
append-only/system tables.

## Prerequisites

- Windows 10/11
- PostgreSQL 14 or newer reachable by an administrative login
- Node.js 20 or newer and npm 10 or newer
- PowerShell 5.1 or newer
- optional: Codex CLI, LM Studio and pgvector for their corresponding features

Run a non-mutating preview first:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-forge-windows.ps1 -PlanOnly
```

Install the schema, runtime configuration and Workbench:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-forge-windows.ps1
```

The script asks for the PostgreSQL administrator password and a new runtime
password without echoing either one. Secrets are not placed in command
arguments, JSON or bootstrap status.

Useful opt-in features:

```powershell
# Register the 27-tool FORGE MCP in Codex.
.\scripts\install-forge-windows.ps1 -RegisterCodexMcp

# Add the local embedding worker for an existing FORGE project.
.\scripts\install-forge-windows.ps1 -ConfigureEmbedding -ProjectId '<project-uuid>'

# Add verified encrypted filesystem recovery.
.\scripts\install-forge-windows.ps1 -ConfigureLogicalRecovery `
  -RecoveryOutputDirectory 'D:\FORGE Recovery\packages' `
  -RecoveryReplicaDirectory 'E:\FORGE Recovery\replica' `
  -PostgresBin 'C:\Program Files\PostgreSQL\18\bin'
```

Embedding and recovery remain optional. PostgreSQL relational truth, Gateway,
MCP and Workbench do not require LM Studio or AWS.

## Resume and safe rollback

Progress is atomically recorded in `%APPDATA%\FORGE\bootstrap-status.json`.
After correcting a failed prerequisite, rerun the same command with `-Resume`.
Completed phases are skipped and administrative credentials are requested only
when a remaining phase needs them.

```powershell
.\scripts\install-forge-windows.ps1 -Resume
```

`-Rollback` unregisters the Codex MCP and embedding task and removes the
Workbench application when installed. It deliberately preserves PostgreSQL
data, encrypted credentials, recovery material and user configuration.

```powershell
.\scripts\install-forge-windows.ps1 -Rollback
```

## Validation status

The plan, resume state machine, rollback boundary, configuration parsing,
schema invariants and every package suite are automated. The complete workflow
passed on an ephemeral Windows Server 2022 environment with Node.js 22,
PostgreSQL 14.23 and pgvector 0.8.2, including installation, DPAPI clients,
restart continuity, resume and data-preserving rollback. See
[CI run 31833285751](https://github.com/ProjForge/Forge/actions/runs/31833285751).

## Isolated acceptance

The authoritative clean-Windows gate runs automatically on an ephemeral
GitHub-hosted Windows Server 2022 runner. It builds pgvector 0.8.2 for the
preinstalled PostgreSQL 14, creates an empty cluster and executes the same
acceptance body used locally. The runner is destroyed after the job.

Maintainers can also run that acceptance in Windows Sandbox. The repository,
Node.js and PostgreSQL/pgvector binaries are mounted read-only; the guest creates
its own empty PostgreSQL cluster and never connects to the host database.

```powershell
# Non-mutating host preflight.
.\scripts\acceptance\windows-sandbox\Start-FORGE-WindowsSandbox.ps1 -PlanOnly

# Enable once from an elevated shell, then restart if requested.
.\scripts\acceptance\windows-sandbox\Enable-FORGE-WindowsSandbox.ps1

# Start the isolated acceptance and wait for its sanitized JSON result.
.\scripts\acceptance\windows-sandbox\Start-FORGE-WindowsSandbox.ps1
```

Both executors validate the complete build/test suite, schema and runtime-role
setup, DPAPI MCP launcher, MCP process replacement, installed Workbench over
loopback, PostgreSQL restart persistence, resumability and data-preserving
rollback. Only a bounded, credential-free JSON result is retained.

Windows 11 24H2 and later service the newer Sandbox client through Microsoft
Store. If the client closes before the result file exists, update or repair that
Windows component; the CI gate remains independent of the local client.
