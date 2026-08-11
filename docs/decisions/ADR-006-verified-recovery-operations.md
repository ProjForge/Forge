# ADR-006: Require verified copies and recovery drills

**Status:** Accepted
**Date:** 2026-08-11
**Deciders:** FORGE maintainers

## Context

A successful backup command does not prove that its output is readable, copied
off the source machine, retained safely or recoverable. Logical packages and
physical WAL recovery also have different scopes and credentials.

## Decision

FORGE recovery operations use two explicit tracks:

1. A logical policy run acquires a single-run lock, creates and authenticates a
   package, verifies it, atomically publishes it to every configured filesystem
   replica, and only then applies retention to complete package pairs.
2. Cluster-level PITR uses PostgreSQL base-backup manifests plus continuous WAL
   archiving. A native drill must recover to a named restore point and validate
   application data before the capability is reported as tested.

Windows scheduling stores database and package secrets with CurrentUser DPAPI.
Policy and status JSON remain non-secret. A replica target must be independent
of the primary backup directory; an actual RPO is not advertised until the task
is installed, monitored and repeatedly drilled in its deployment environment.

## Consequences

- Retention cannot erase the previous recovery set after a failed copy.
- Unknown or malformed files are never deleted by automated retention.
- A filesystem target can be a removable disk, mounted volume or network share;
  ADR-007 adds a replaceable S3-compatible cloud target without changing the
  recovery package.
- PITR remains a cluster administration feature and is never silently enabled on
  a user's production PostgreSQL instance.
- Windows user-level scheduling requires an interactive user session for network
  credentials; unattended service deployments need a dedicated service identity.
