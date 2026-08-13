# ADR-008: Separate PostgreSQL archiving from encrypted off-site transport

**Status:** Accepted
**Date:** 2026-08-12
**Deciders:** FORGE maintainers

## Context

FORGE already has six-hour encrypted logical recovery on two local volumes and
an immutable AWS target. The installed PostgreSQL 18.4 cluster is small and
lightly written, but logical packages cannot recover to the instant before an
operator error. Production PITR must not put cloud credentials or slow network
operations inside PostgreSQL's `archive_command`.

Measured on the installation before activation:

- active FORGE database: 13,670,079 bytes;
- all cluster databases: 38,361,852 bytes;
- WAL generated: 89,104,709 bytes over 74.89 hours (about 1.19 MB/hour);
- WAL segment size: 16 MB;
- E: free capacity: about 1.42 TiB;
- `wal_level=replica`, `full_page_writes=on`, `archive_mode=off`.

PostgreSQL executes `archive_command` as the database service identity, retries
failed files and can fill `pg_wal` if the destination remains unavailable. It
also warns that forced early switches still produce full-size segments.

## Decision

Use a two-stage physical recovery pipeline:

1. PostgreSQL synchronously publishes each completed WAL segment through the
   existing collision-safe SHA-256 `archive-wal.ps1` into a local E: spool.
   This path has no database password, cloud credential or network dependency.
2. A limited CurrentUser worker asynchronously encrypts archived WAL and daily
   SHA-256 `pg_basebackup` sets with a physical-recovery passphrase protected by
   DPAPI, uploads them beneath a cluster-identifier-scoped immutable S3 prefix,
   re-downloads and authenticates them, then writes a durable receipt.

Initial targets:

- local and off-site PITR RPO: at most 60 minutes;
- `archive_timeout=1h` to bound low-traffic WAL age;
- one full physical base backup per day;
- local retention: 14 days, only after a newer base plus complete WAL chain and
  authenticated off-site receipts exist;
- remote retention: 30-day COMPLIANCE Object Lock, provider lifecycle later;
- reserve at least 20 GiB on the WAL volume before activation.

The existing recovery IAM identity may receive access to a separate `physical/`
prefix but still receives no delete or Object Lock bypass capability. Physical
packages use a passphrase distinct from logical recovery packages.

Activation is blocked until an elevated preflight verifies BitLocker protection
for both the PostgreSQL and archive volumes, NetworkService/current-user ACLs,
the replication role, encrypted uploader, monitoring and a provider-backed
named-target restore drill.

## Options Considered

### Direct cloud upload from `archive_command`

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Database availability risk | High |
| Credential isolation | Poor |
| Provider coupling | High |

Rejected because PostgreSQL would own cloud credentials and network latency.

### Local verified spool plus asynchronous encrypted transport

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Database availability risk | Low |
| Credential isolation | Strong |
| Provider coupling | Low |

Selected. PostgreSQL only depends on a local verified write; provider work stays
outside the service boundary.

### Dedicated `pg_receivewal` service

| Dimension | Assessment |
|---|---|
| Complexity | High |
| Low-traffic storage efficiency | Strong |
| Credential/slot operations | High |
| Current need | Low |

Deferred until measured throughput or a standby requirement justifies another
long-running service and replication slot lifecycle.

## Consequences

- A failure of AWS does not directly stall PostgreSQL archiving.
- A full E: spool still causes WAL accumulation and can eventually stop the
  database, so capacity and archiver-lag monitoring are mandatory.
- Raw local WAL has the same confidentiality class as the database files;
  BitLocker and restrictive ACLs are required before production activation.
- Physical recovery restores the complete cluster and PostgreSQL configuration,
  while logical packages remain the portable selective recovery layer.
- High availability and automatic failover remain out of scope.

## Action Items

1. [x] Measure cluster size, WAL rate, segment size and disk capacity.
2. [x] Add a non-mutating Windows readiness preflight and prove the live service
   remains running after it.
3. [x] Enable and reboot-validate BitLocker on C: and E: with offline recovery
   key custody; create the least-privilege E: spool and distinct DPAPI/offline
   physical passphrase.
4. [x] Implement encrypted physical manifests, uploader and authenticated fetch.
5. [x] Create the production dedicated replication role with DPAPI custody and
   pass isolated SCRAM plus real-cluster base-backup acceptance.
6. [x] Install limited hidden uploader, daily base-backup and five-minute
   monitor tasks; prove scheduler exit zero before activation.
7. [ ] Restart once, force a WAL switch and pass an isolated named-target drill.

## References

- <https://www.postgresql.org/docs/18/continuous-archiving.html>
- <https://www.postgresql.org/docs/18/app-pgbasebackup.html>
- <https://www.postgresql.org/docs/18/app-pgverifybackup.html>
