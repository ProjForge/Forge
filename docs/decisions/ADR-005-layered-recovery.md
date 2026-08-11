# ADR-005: Layer logical recovery before PITR

Status: Accepted
Date: 2026-08-11

## Context

FORGE must survive process, database and machine replacement without coupling
recovery to one operating system. A logical dump, a physical base backup and
continuous WAL/PITR solve different failure and recovery objectives. Treating
one as all three would create a false durability claim.

## Decision

Implement recovery in explicit layers:

1. Resilience 0.2 starts with an authenticated encrypted logical recovery
   package, portable restore and automated restore proof.
2. A following slice adds scheduled verification and off-host replication.
3. PITR is implemented separately through PostgreSQL physical base backups and
   continuous WAL archiving, with its own retention and disaster drill.

The logical package contains only the FORGE schema and its required extensions.
Restore is non-destructive: the target database must be empty and the operation
runs as one transaction.

## Consequences

- A machine can reconstruct FORGE without preserving the original data directory.
- Backup confidentiality and authenticity do not depend on Windows DPAPI.
- Current RPO is the age of the last verified logical package; arbitrary
  point-in-time recovery is not yet available.
- Cluster-wide roles, tablespaces and unrelated schemas are intentionally not
  part of a FORGE recovery package.
- Administrators must provide an empty database and compatible extension files.
