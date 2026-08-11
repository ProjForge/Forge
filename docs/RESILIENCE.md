# FORGE resilience contract

Status: Resilience 0.3, filesystem and immutable S3 recovery targets

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
- Runtime, worker and backup-role grants are destination configuration and must
  be recreated after accepting a portable restore; source ACLs are not restored.
- Backup preflight enumerates relations from PostgreSQL catalogs and fails if
  the dedicated read-only role cannot select any current table or sequence.
- A policy run prevents overlap, verifies the source package, publishes complete
  package pairs to every configured filesystem or S3 replica and applies local
  retention only after all replicas verify successfully.
- S3 replication requires Object Lock, publishes payload before manifest,
  downloads both objects and authenticates the complete remote package. Cloud
  credentials are never accepted in policy JSON.
- S3 recovery fetches only a safe named manifest and its referenced payload,
  authenticates the package before local publication and refuses overwrites.
- Windows can run the policy periodically with database and package secrets
  protected by CurrentUser DPAPI and atomic non-secret health status.
- The native PITR drill verifies a SHA-256 `pg_basebackup`, continuous WAL
  archiving and recovery to a named restore point in an isolated cluster.

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

Logical packages are not point-in-time recovery. FORGE now includes a validated
isolated PITR drill and safe WAL archive/restore commands, but it does not
silently enable physical archiving on an installed production cluster.
PostgreSQL describes the distinct base-backup/WAL mechanism here:
<https://www.postgresql.org/docs/18/continuous-archiving.html>.

High availability and automatic failover remain future slices. A filesystem
replica is only truly off-host when the configured path resides on independent
storage, and an S3-compatible endpoint is only off-site when its deployment is.
Provider lifecycle must remove cloud objects only after Object Lock expires.

The optional [AWS reference deployment](../deploy/aws/README.md) makes the
first provider-backed validation reproducible while keeping Core and recovery
packages provider-neutral.

Implementation findings and native evidence are recorded in
[Resilience implementation findings](RESILIENCE-IMPLEMENTATION-FINDINGS.md)
and the [validation report](RESILIENCE-VALIDATION.md).

## Threat model

Recovery packages protect confidentiality and detect payload or manifest-core
tampering when the passphrase remains secret. They do not protect against a
compromised PostgreSQL superuser that deliberately places malicious executable
objects into a backup. Restore only trusted FORGE-produced packages into an
isolated empty database and rotate a passphrase if exposure is suspected.
