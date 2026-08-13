# Resilience 0.3 validation

Date: 2026-08-13

## Environment

- Windows 11
- PostgreSQL server and client tools 18.4
- pgvector 0.8.2
- Node.js 20+
- two physical NVMe devices for the installed logical package replica

## Automated results

| Gate | Result |
|---|---|
| Resilience default tests | 22/22 passed (21 unit + 1 S3 SDK) |
| S3 SDK loopback integration | 1/1 passed and included in default CI gate |
| Complete monorepo tests | 70/70 passed |
| Production dependency audit | 0 vulnerabilities |
| PowerShell scripts | all 27 parsed; module-independent WAL SHA-256 regression passed |
| Git diff whitespace | passed |

## Logical recovery drill

The native PostgreSQL drill passed with random temporary databases and a random
temporary backup role. It proved:

- the backup role can read but cannot write;
- source and replica packages authenticate independently;
- restore refuses a non-empty target and preserves its blocker relation;
- empty-target restore is transactional;
- migration checksums, all FORGE table counts and a sentinel project match;
- temporary databases, role and package directories are removed.

## Installed scheduled policy

`FORGE Verified Recovery Backup` runs at logon and every six hours under the
limited interactive CurrentUser principal with `IgnoreNew`, three retries and
`StartWhenAvailable`. Database and package secrets are separate CurrentUser
DPAPI blobs; task arguments and JSON files contain no secret.

The real scheduled smoke test returned `LastTaskResult = 0`. It created and
authenticated a logical package on the primary backup volume, copied it to a
different physical NVMe, authenticated that replica and wrote atomic `ok`
health. Retention is 14 newest packages plus packages younger than 720 hours and
only runs after every configured copy verifies.

After upgrading the module to 0.3, a compatibility smoke run completed at
2026-08-11 21:51 Europe/Madrid with `LastTaskResult = 0`. The installed untyped
version-1 filesystem policy was normalized, and status reported independently
verified D: source and E: replica locations.

## S3-compatible adapter

The automated SDK integration used a real signed S3 client against an isolated
loopback HTTP endpoint. It proved payload-before-manifest ordering, explicit
SHA-256 algorithm and checksum headers, Object Lock mode and retention headers,
remote download, exact manifest comparison and complete AES-GCM authentication.
It then fetched the published package through the recovery API and byte-compared
both local files. Unit coverage separately proves corrupted remote payloads fail
closed and unsafe manifest names never reach the client.

The AWS reference stack was then provisioned in `eu-west-1` with 30-day
COMPLIANCE Object Lock. The installed limited task created a 1,253,458-byte
encrypted package from the active FORGE database, authenticated independent D:
and E:\ copies, uploaded payload then manifest under `logical/`, downloaded both
through the provider API and completed with `LastTaskResult = 0` and policy
status `ok`.

The recovery path fetched that named manifest and payload into a new directory,
matched SHA-256 and AES-GCM authentication, created a random isolated PostgreSQL
18.4 database and restored it transactionally. All seven migration checksums and
all 20 FORGE table counts matched. The database was retained for post-drill
inspection. A limited-role follow-up confirmed the portable `--no-privileges`
contract: destination operational grants must be recreated separately.

## Physical WAL/PITR drill

The isolated drill passed without changing the installed FORGE cluster:

1. initialized a disposable PostgreSQL cluster with checksums and WAL archive;
2. created safe application state;
3. took `pg_basebackup -X stream` with SHA-256 manifest;
4. passed `pg_verifybackup`;
5. created a named restore point and committed later destructive mutations;
6. archived the required WAL through verified collision-safe copies;
7. recovered a second cluster to the named target and waited for promotion;
8. proved the safe row remained and both later mutations disappeared;
9. removed both clusters and their WAL archive.

## Production AWS physical-recovery acceptance

The final production-chain gate passed without stopping or modifying the active
PostgreSQL service:

1. created named target `forge_production_acceptance_20260813_215539`;
2. archived and authenticated target WAL `000000010000000000000009` under
   30-day S3 Object Lock COMPLIANCE;
3. fetched the immutable production base plus WAL 8 and WAL 9 from AWS;
4. authenticated AES-256-GCM metadata/ciphertext and restored plaintext through
   atomic no-overwrite publication;
5. passed `pg_verifybackup` on the downloaded base;
6. started PostgreSQL 18.4 on isolated port 63805 and promoted at the target;
7. matched the target state: 53 projects and 100 memories;
8. stopped the isolated server, removed plaintext staging and confirmed
   production remained on port 5432.

The first replay exposed RES-024: PostgreSQL's recovery process could not
auto-load `Get-FileHash`. WAL verification now uses the module-independent .NET
SHA-256 API, with a regression that runs under an empty `PSModulePath`.

## Remaining deployment limits

- The local replica remains on an independent disk in the same computer, while
  the validated immutable AWS replica covers total-machine loss.
- Recovery identity rotation and periodic provider-backed restore drills remain
  ongoing operational responsibilities.
- Exact PostgreSQL 14 binary execution remains a compatibility-matrix gap; all
  used commands and options are documented in PostgreSQL 14.
