# Resilience 0.2 implementation findings

Date: 2026-08-11
Environment: PostgreSQL 18.4 on Windows, Node.js 20+

## RES-001: the runtime role is not a backup role

The first live backup correctly failed because the least-privilege application
role could not read every FORGE relation. Elevating it would have expanded the
runtime attack surface.

Resolution: add a distinct read-only backup role and a catalog-based preflight
that lists every inaccessible table or sequence and fails closed. The setup
script must be rerun after a migration adds relations.

## RES-002: rejected restores leaked a client connection

The non-empty-target regression exposed that a failure during restore preflight
did not close its PostgreSQL client. This could delay administrative cleanup and
accumulate idle connections after repeated rejected restores.

Resolution: close the client on every preflight failure. The native test now
creates a blocker relation, proves restore rejects it, proves the relation still
exists, removes it and only then performs the real restore.

## RES-003: logical recovery is not PITR

`pg_dump` recovery packages reconstruct FORGE at the time of the latest verified
backup. They cannot replay changes to an arbitrary instant.

Resolution: document logical recovery and PostgreSQL physical/WAL recovery as
separate layers. No point-in-time recovery claim is made by Resilience 0.2.

## RES-004: both sides of the streaming pipeline must settle

An encryption error could reject before the concurrently running `pg_dump`
process had terminated. Cleanup must not return while a producer may still hold
the exported snapshot or write to its pipe.

Resolution: an encryption failure terminates the child, and backup waits for
both encryption and `pg_dump` to settle before rolling back and removing partial
files.

## Native validation result

The automated drill passed on PostgreSQL 18.4:

- temporary read-only role could read but not write;
- consistent custom-format dump was encrypted without a plaintext archive;
- payload and authenticated manifest verification passed;
- restore refused a non-empty target without deleting its relation;
- empty-target restore completed in one transaction;
- migration checksums, every FORGE table count and a sentinel project matched;
- both temporary databases and the temporary role were removed.

The administrative password was requested interactively, held for the process
lifetime and was not stored in the repository, status file or test log.
