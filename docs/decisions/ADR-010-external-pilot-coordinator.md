# ADR-010: External trusted-host pilot coordinator

Status: Accepted
Date: 2026-11-06

## Context

Core persists task executions and continuation packages but does not claim work
or identify the calling process. Distinct operation keys can legitimately start
distinct executions of one task. The trusted local pilot needs exclusive worker
ownership and restart recovery without changing Core schema or runtime grants.

## Decision

Add the independent `forge-coordinator` package. Its PostgreSQL control schema
belongs to a separate state owner, optionally in a separate database. Core
continues to use the existing limited runtime credential through Gateway.

Queue identities are unique per `(projectId, taskId)` and immutable in agent
assignment. Workers filter by both project and logical agent; several physical
processes can serve that logical agent. Database-clock leases, incrementing
epochs and heartbeats support bounded recovery. Claim and publication serialize
on the control row. Handlers compute outside the transaction and receive an
AbortSignal and a bounded deadline. Only the coordinator publishes into Core.

A prepared artifact is persisted before publication and reused after crashes.
Core execution and retry keys derive from the project/task identity, independent
of the physical worker or lease epoch. Partial writes are replayed using existing
idempotency and version contracts. A succeeded execution is reconciled rather
than finalized again. Reassignment across logical agents is deliberately outside
this first pilot: replacement processes retain the task's assigned agent.

## Consequences

- Multiple trusted workers can compete without creating multiple coordinated
  executions; process death and lost replies need no Core migration.
- Core and coordinator roles retain separate privileges. The state schema and
  artifact require their own protected backup/recovery plan before deployment.
- The guarantee covers coordinator-mediated Core writes. Direct Core clients,
  humans and independent coordinators with different state stores do not share
  its ownership fence. Existing manual runs are rejected on admission, but this
  is not a global Core task-lock contract.
- A handler can be retried if it dies before saving its output. It must avoid
  external mutations or protect them with its own idempotency/fencing mechanism.
  This does not provide exactly-once model calls, file writes or deployments.
- An ignored AbortSignal cannot terminate arbitrary computation or I/O. The host
  must isolate and kill uncooperative handlers. Exhausted jobs require operator
  reconciliation; Core may still show their unfinished execution.
- This is a trusted local pilot, not an authenticated multi-tenant service.
