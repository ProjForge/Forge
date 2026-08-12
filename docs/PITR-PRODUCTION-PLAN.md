# Production PITR activation plan

Status: designed, not activated

Environment: Windows 11, PostgreSQL 18.4

Decision: [ADR-008](decisions/ADR-008-production-pitr-on-windows.md)

## Recovery objectives

| Layer | RPO target | Retention | Purpose |
|---|---:|---:|---|
| Logical D:/E:/AWS | 6 hours | 30 days remote | Portable FORGE recovery |
| Physical E: + AWS | 60 minutes | 14 days local / 30 days remote | Whole-cluster PITR |

RTO remains measured evidence, not an estimate. Activation is complete only
after an isolated restore reaches a named point and validates FORGE rows.

## Capacity basis

The 2026-08-12 sample measured 1.19 MB/hour of WAL over 74.89 hours. With
16 MB segments and `archive_timeout=1h`, the conservative forced-switch floor is
384 MB/day or 5.25 GiB over 14 days. Daily physical backups of the current
38.4 MB cluster remain small. A 20 GiB minimum free-space gate covers forced
segments, base backups, temporary publication and growth; E: currently exceeds
that requirement by more than two orders of magnitude.

Recalculate these figures after significant ingestion, large migrations or a
tenfold database-size increase. Retention must be capacity-based, not assumed.

## Security boundary

- PostgreSQL runs as `NT AUTHORITY\NetworkService` and writes only to the local
  WAL spool through `archive-wal.ps1`.
- The service receives no AWS key and no encryption passphrase.
- A limited interactive task reads the spool, uses a separate CurrentUser-DPAPI
  physical passphrase and recovery credential, and publishes immutable objects.
- Raw WAL and base-backup staging require BitLocker on C: and E: plus ACLs for
  NetworkService, the task user and administrators only.
- Remote objects are encrypted before transport and verified after download.
- No component receives cloud delete or retention-bypass permission.

## Activation gates

1. Run `preflight-pitr-windows.ps1` elevated and obtain `READY`.
2. Back up PostgreSQL configuration and current service metadata.
3. Create the E: spool/staging/receipt layout with explicit ACLs and 20 GiB gate.
4. Create a dedicated `LOGIN REPLICATION` role; protect its password with DPAPI.
5. Implement and test encrypted physical manifests and S3 `physical/` policy.
6. Install daily base-backup, five-minute uploader and five-minute health tasks.
7. Set `archive_mode=on`, `archive_timeout=1h` and the quoted archive command.
8. Restart PostgreSQL once and verify normal FORGE reads/writes.
9. Force `pg_switch_wal()`, require a verified local segment and authenticated
   remote receipt, then take and verify the first SHA-256 base backup.
10. Restore into an isolated cluster to a named target and validate FORGE state.

## Monitoring and fail-closed rules

- Alert on `pg_stat_archiver.failed_count` growth or failed archive timestamp.
- Alert when writes occurred but no WAL receipt is newer than 75 minutes.
- Alert below 20 GiB or 10% free on C: or E:, whichever is stricter.
- Never prune the last usable base backup or any WAL required by retained bases.
- Never prune local physical data before remote authentication receipts exist.
- Stop retention after any checksum, encryption, upload or re-download failure.
- PostgreSQL archive success means only verified local publication, never queued
  or attempted cloud transport.

## Rollback

If activation harms availability, set `archive_command=''` first so PostgreSQL
stops invoking the script without discarding pending WAL. After preserving the
spool and collecting status, set `archive_mode=off` and restart during the
approved maintenance window. Do not delete archived WAL or base backups during
rollback; validate logical D:/E:/AWS recovery remains healthy.

## Current blockers

- The elevated non-mutating preflight passes seven readiness checks and leaves
  PostgreSQL running, but fails closed because BitLocker protection is `Off` on
  both C: and E:. Encryption and recovery-key custody require an explicit
  operator decision before activation.
- Encrypted physical manifests/uploader are not implemented yet.
- The AWS reference identity currently targets `logical/`, not `physical/`.
- No production replication role or physical DPAPI passphrase exists yet.
