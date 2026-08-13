# Production PITR activation plan

Status: active; final isolated recovery acceptance pending

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

## Current state and remaining gate

- The elevated non-mutating preflight is `READY`: nine checks pass with zero
  failures or blockers. C: and E: are fully encrypted with XTS-AES-256;
  recovery keys were checksum-verified on offline media and copied to separate
  custody. A real reboot proved TPM unlock for C: and automatic unlock for E:,
  followed by healthy PostgreSQL, FORGE reads and scheduled tasks.
- Encrypted physical manifests, CLI packaging, local authentication and S3
  upload/fetch are implemented in Resilience 0.4. Provider-backed acceptance
  and production scheduling pass.
- The AWS reference template now scopes the recovery identity and lifecycle to
  both `logical/` and `physical/`; the deployed stack is updated and validated.
- The production `forge_pitr_replication` identity exists with LOGIN,
  REPLICATION, NOINHERIT, no elevated database capabilities and connection
  limit 2. Its generated password is CurrentUser-DPAPI protected; both the
  isolated SCRAM drill and a real encrypted base backup passed.
- The distinct physical passphrase is generated, DPAPI-protected and
  checksum-verified against its offline recovery copy.
- The bounded WAL uploader passes isolated idempotency plus real local spool,
  immutable upload, provider re-download and authentication.
- The daily base-backup worker is implemented and passes a native disposable
  PostgreSQL 18 drill: streamed WAL, fast checkpoint, SHA-256 manifest
  verification, encrypted cluster binding, staging cleanup and idempotent
  offline replay. Production replication credentials and scheduling pass.
- The monitor passes deterministic preactivation, healthy and fail-closed
  capacity/archiver/receipt tests plus live activated operation.
- The limited hidden uploader, daily base-backup and monitor tasks are installed.
  Uploader and monitor returned zero through Task Scheduler; the real base
  package was authenticated under the cluster-scoped AWS Object Lock prefix and
  has a local receipt.
- Guarded activation completed on 2026-08-13 at 21:20:15Z. Effective settings
  are `archive_mode=on` and `archive_timeout=1h`; the service is running with
  zero archiver failures. FORGE retained 53 projects and 100 memories. Forced
  segment `000000010000000000000008` was verified locally, encrypted, uploaded,
  re-downloaded and authenticated under the cluster-scoped immutable prefix.
  A first attempt exposed RES-022 and proved automatic checksummed rollback.
- The remaining capability gate is a fresh isolated restore from the retained
  production base/WAL chain to a named target with FORGE row validation.

## Provider acceptance evidence

On 2026-08-12, stack `forge-recovery` reached `UPDATE_COMPLETE` without resource
replacement. The deployed identity retains only Get/Put/GetRetention/
PutRetention on `logical/*` and `physical/*`, with no delete or bypass action.
Both prefixes have 45-day lifecycle rules and the bucket remains under 30-day
COMPLIANCE Object Lock.

A 4 KiB synthetic WAL artifact bound to system identifier
`7671751305680226476`, timeline 1 and PostgreSQL 18.4 was encrypted with an
ephemeral physical passphrase, uploaded beneath the cluster-scoped `physical/`
prefix, re-downloaded and authenticated through the limited recovery identity.
Independent S3 reads confirmed SHA-256 checksums and COMPLIANCE retention on
both payload and manifest through 2026-09-11. No production data was used.
