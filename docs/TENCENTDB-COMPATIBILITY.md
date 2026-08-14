# TencentDB for PostgreSQL compatibility gate

Status: implemented; live provider execution pending an isolated TencentDB
instance and private runner.

This gate certifies FORGE Core against TencentDB without treating generic
PostgreSQL compatibility as provider evidence. It is deliberately manual and
creates only ephemeral test identities.

## Certified scope

The gate requires and verifies:

- TencentDB for PostgreSQL 14 or newer on a writable primary;
- a hostname-verified TLS connection (`sslmode=verify-full`);
- a TencentDB administrative account with `CREATEDB` and `CREATEROLE`;
- provider role detection through `pg_tencentdb_superuser` or its legacy name;
- available `vector` extension version 0.8.2 or newer;
- all schema migrations and relational/vector invariants;
- connection-recycle persistence without claiming a provider restart;
- a generated least-privilege runtime role and its negative permission tests;
- native Gateway continuity and real MCP stdio continuity;
- removal of the ephemeral database and role after success or failure.

It does not certify Workbench cloud TLS configuration, TencentDB control-plane
failover, provider backups, physical WAL/PITR access or performance limits.

## Safety boundary

The gate derives a unique database and role from `FORGE_TENCENTDB_RUN_ID` and
refuses to continue if either already exists. It never accepts a target FORGE
database, drops no pre-existing identity and redacts PostgreSQL URLs from its
own errors. Failed resources are cleaned by default. Set
`FORGE_TENCENTDB_KEEP_FAILED=1` only for deliberate administrator diagnosis.

The administrative URL and generated runtime password are environment secrets,
never command arguments. The URL must point to a control database such as
`postgres` and include `sslmode=verify-full`. Add `sslrootcert` when TencentDB's
certificate chain is not already trusted by the runner.

## Private runner

Use a disposable or tightly controlled Linux x64 GitHub runner in the same VPC
as TencentDB and label it `forge-tencentdb`. Do not expose the database to all
GitHub-hosted runner addresses.

Create the protected GitHub environment `tencentdb-compatibility` with required
reviewers and these environment secrets:

- `TENCENTDB_ADMIN_URL`
- `TENCENTDB_RUNTIME_PASSWORD` (12 or more characters)

Then manually run `.github/workflows/tencentdb-compatibility.yml` from the
protected `main` branch. A passing run is the provider evidence required before
TencentDB can be listed as a supported FORGE Core environment.

## Local invocation

From a trusted machine with private network access:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\compatibility\test-tencentdb.ps1
```

The wrapper prompts without echoing for the complete administrative URL and an
ephemeral runtime password, passes them only through the child-process
environment and removes them on exit. Prefer the protected workflow for
repeatable certification evidence.

## Result interpretation

A successful run emits a sanitized JSON result containing server/vector/TLS
versions and boolean evidence for invariants, least privilege, reconnect,
Gateway, MCP and cleanup. Any failure means TencentDB remains uncertified; do
not weaken the gate or reuse partially created identities to force a pass.
