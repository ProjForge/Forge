# Resilience 0.3 validation

Date: 2026-08-11

## Environment

- Windows 11
- PostgreSQL server and client tools 18.4
- pgvector 0.8.2
- Node.js 20+
- two physical NVMe devices for the installed logical package replica

## Automated results

| Gate | Result |
|---|---|
| Resilience default tests | 16/16 passed (15 unit + 1 S3 SDK) |
| S3 SDK loopback integration | 1/1 passed and included in default CI gate |
| Complete monorepo tests | 64/64 passed |
| Production dependency audit | 0 vulnerabilities |
| PowerShell syntax | all Resilience scripts passed Windows PowerShell parsing |
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

No real cloud bucket or credential was available during this validation. A
provider-backed upload and restore drill remains required before FORGE claims
operational off-site recovery for this installation.

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

## Remaining deployment limits

- The installed replica is on an independent disk in the same computer. It
  protects against primary-disk loss, not theft, fire or total machine loss.
- The S3-compatible implementation is validated through the real SDK boundary,
  but no off-site bucket is configured yet.
- Production WAL archiving is not silently enabled. It needs explicit capacity,
  retention, replication credentials and monitoring for the actual cluster.
- Exact PostgreSQL 14 binary execution remains a compatibility-matrix gap; all
  used commands and options are documented in PostgreSQL 14.
