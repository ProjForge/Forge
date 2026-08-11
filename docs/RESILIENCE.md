# FORGE resilience contract

Status: Resilience 0.2, recovery-package slice

## Guarantees in this slice

- `pg_dump` takes a consistent concurrent snapshot of the `forge` schema and
  its required extensions in PostgreSQL custom format.
- The dump is encrypted while streaming with AES-256-GCM; plaintext archives
  are never written to disk.
- Scrypt derives the encryption key from a passphrase supplied by file or
  environment, never as a command-line argument.
- Immutable source metadata is authenticated as GCM additional data. The
  encrypted payload also has a SHA-256 checksum and byte count.
- Verification authenticates the complete payload before any restore begins.
- Restore refuses non-empty targets, refuses older PostgreSQL majors, uses one
  transaction, omits source ownership/ACLs and verifies migration checksums and
  all FORGE table counts afterwards.
- Backup preflight enumerates relations from PostgreSQL catalogs and fails if
  the dedicated read-only role cannot select any current table or sequence.

PostgreSQL documents custom archives as portable and flexible, and confirms
that `pg_dump` creates consistent exports while a database remains in use:
<https://www.postgresql.org/docs/18/app-pgdump.html>.

## Recovery objectives

For logical recovery packages:

- RPO equals the elapsed time since the latest successfully verified backup.
- RTO is measured by `verify + restore + post-restore validation` on recovery
  hardware; no untested estimate is considered a guarantee.

Scheduling and off-host replication must only advertise an RPO after repeated
restore drills demonstrate it.

## Not yet claimed

This slice is not point-in-time recovery. PITR requires a physical base backup,
continuous WAL archiving, separate retention and a cluster-level restore drill.
PostgreSQL describes that distinct mechanism here:
<https://www.postgresql.org/docs/18/continuous-archiving.html>.

High availability, automatic failover and off-host storage adapters also remain
future slices. They must not be represented as implemented by the logical
backup commands.

Implementation findings and native evidence are recorded in
[Resilience 0.2 implementation findings](RESILIENCE-IMPLEMENTATION-FINDINGS.md).

## Threat model

Recovery packages protect confidentiality and detect payload or manifest-core
tampering when the passphrase remains secret. They do not protect against a
compromised PostgreSQL superuser that deliberately places malicious executable
objects into a backup. Restore only trusted FORGE-produced packages into an
isolated empty database and rotate a passphrase if exposure is suspected.
