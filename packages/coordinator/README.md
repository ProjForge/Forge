# FORGE external coordinator pilot

This package coordinates trusted local agent runtimes around the existing Core
Gateway. It is separate from Core, Workbench and the embedding worker. It adds no
Core migration and does not expand `forge_runtime` privileges.

## Guarantees and limits

- One durable queue identity per project/task. A worker is scoped to both project
  and logical agent. Several OS processes can serve the same logical agent.
- Database-clock leases and epochs fence publication. A stale worker cannot
  checkpoint or publish after takeover. Active heartbeats preserve ownership.
- Core execution and write keys remain stable across workers and attempts.
  Prepared output is reused after a crash. Result, task, context and execution
  finalization reconcile after partial writes or a lost reply.
- A default 30-second lease, 120-second handler budget and three attempts bound
  the pilot. Expired final attempts and repeated failures enter `failed`.
- A handler must compute an artifact and honor AbortSignal. It may run more than
  once before its output is saved. External side effects require their own
  idempotency or fencing; a lease is not an exactly-once execution guarantee.
- Agents are trusted. Do not give worker handlers direct Core/state credentials
  or let them bypass this host's publication API. This pilot does not add remote
  authentication, tenant ACLs, sandboxing or reassignment to a different logical
  agent. A replacement process serves the existing assignment.
- Terminal queue failures need operator review. The corresponding Core execution
  may remain running after a failure or outage; no success is fabricated.

See [ADR-010](../../docs/decisions/ADR-010-external-pilot-coordinator.md).

## Reproduce the isolated acceptance on Windows

After `npm ci`, with PostgreSQL 18 and pgvector installed:

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1
```

It creates a disposable loopback cluster, migrates Core, creates its limited
runtime role, provisions a separate coordinator-state owner, and runs native
acceptance. It then stops and removes the cluster. It does not read production
credentials, call a model or register a scheduled task. Sanitized RUNNING/FAIL
status replaces prior results in `.run/coordinator-pilot-result.json`; PASS is
written only after successful cleanup.

Acceptance uses three registered logical agents and six competing worker
processes on twelve tasks. It kills additional workers after start, after the
memory write and after execution completion; reopens state from replacement
processes; resumes a stale worker; exercises heartbeat renewal, retry exhaustion,
project/agent filtering, CLI operation and separation of database privileges.
Each successful task must have one execution, one result memory, one context
package and no stale sources. These are deterministic agent-process tests, not
autonomous LLM-quality or throughput acceptance.

For an explicitly disposable PostgreSQL test installation, native tests require
`FORGE_DATABASE_URL` (limited Core role), `FORGE_COORDINATOR_TEST_ADMIN_URL`
(test provisioning only) and `FORGE_COORDINATOR_TEST_ALLOW_SETUP=1`. Run
`npm run test:integration -w forge-coordinator`. Tests refuse to replace an
existing `forge_coordinator` schema. PostgreSQL 14 CI and clean Windows
acceptance run this same suite.

## Prepare a persistent pilot

Provision a separate PostgreSQL state owner with only CONNECT and ownership of
the `forge_coordinator` schema in a protected state database. Apply
`sql/setup.sql` as that owner using the standard PostgreSQL client. The owner
needs CREATE inside its own schema; it does not need any `forge.*` grants.
Preserve Core's existing limited role. No provisioning is performed by workers.

Inject two secrets through the host's secret mechanism:

- `FORGE_DATABASE_URL`: existing Core runtime connection.
- `FORGE_COORDINATOR_DATABASE_URL`: coordinator-state connection.

Tasks must already be assigned and ready/in progress. The bundled CLI is a
deterministic demonstration handler that performs no external work:

```powershell
node packages/coordinator/dist/cli.js enqueue <projectKey> <taskKey>
node packages/coordinator/dist/cli.js status <projectKey> <taskKey>
# Set these non-secret stable keys for a worker:
$env:FORGE_COORDINATOR_PROJECT_KEY = '<projectKey>'
$env:FORGE_COORDINATOR_AGENT_KEY = '<agentKey>'
node packages/coordinator/dist/cli.js worker
# Explicitly run a polling worker:
node packages/coordinator/dist/cli.js worker --watch
```

Status omits the artifact and credentials. Failed work returns a nonzero exit
code. No Windows startup task or production service is enabled by this change.

An actual agent host imports `Coordinator`, `PostgresJobStore` and the existing
Gateway. Call `runOnce({projectId, agentId, workerId}, handler)`; the handler gets
`{task, signal}` and returns `{title, content}`. Keep `workerId` unique per process.
The coordinator alone performs Core writes. Model, tool and process policy stay
in that host. Coordinate backups of control state with Core before relying on
recovery from data loss; this acceptance covers process failures, not loss of
the state database or a production restore.
