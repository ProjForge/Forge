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
  once before its output is saved. The opt-in local review agent can publish an
  immutable report using a pinned target, stable key, verified bytes and durable
  receipt. Other external effects require their own receiver contract; a lease
  is not an exactly-once execution guarantee.
- Agents are trusted. Do not give worker handlers direct Core/state credentials
  or let them bypass this host's publication API. This pilot does not add remote
  authentication, tenant ACLs, sandboxing or reassignment to a different logical
  agent. A replacement process serves the existing assignment.
- Terminal queue failures need operator review. The corresponding Core execution
  may remain running after a failure or outage; no success is fabricated.

See [ADR-010](../../docs/decisions/ADR-010-external-pilot-coordinator.md).
The real-agent/effect contract is in [ADR-011](../../docs/decisions/ADR-011-local-review-agent-and-confirmed-effects.md).

## Reproduce the isolated acceptance on Windows

After `npm ci`, with PostgreSQL 18 and pgvector installed:

Use Node 22 for Windows acceptance, matching CI. This host intermittently showed
native worker/CLI exits (`0xC0000409`) with Node 24.15; those exits fail acceptance
and are not classified as model errors. No global runtime change is required.

```powershell
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1
```

It creates a disposable loopback cluster, migrates Core, creates its limited
runtime role, provisions a separate coordinator-state owner, and runs native
acceptance. It then stops and removes the cluster. It does not read production
credentials or register a scheduled task. The default uses a loopback model
protocol fixture; `-LiveAgent` makes actual local model calls. Sanitized RUNNING/FAIL
status replaces prior results in `.run/coordinator-pilot-result.json`; PASS is
written only after successful cleanup.

Acceptance uses three registered logical agents and six competing worker
processes on twelve tasks. It kills additional workers after start, after the
memory write and after execution completion; reopens state from replacement
processes; resumes a stale worker; exercises heartbeat renewal, retry exhaustion,
project/agent filtering, CLI operation and separation of database privileges.
Each successful task must have one execution, one result memory, one context
package and no stale sources. Additional cases exercise the real-agent adapter,
three model-backed logical agents, file publication, unknown acknowledgements,
saved receipts, lost ownership, target drift and conflicting external data.
Default CI runs those cases with a deterministic model protocol fixture; it is
not autonomous LLM-quality or throughput acceptance.

### Opt-in real local model acceptance

Load the already installed Qwen model in LM Studio with bounded context and
parallelism. This command does not start a coordinator worker:

```powershell
lms load qwen/qwen3.5-9b --identifier forge-agent-pilot-qwen35 --context-length 4096 --parallel 1 --gpu max --ttl 900 --yes
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/acceptance/Test-FORGE-CoordinatorPilot.ps1 -LiveAgent
```

The LM Studio server must already listen on loopback port 1234. Override
`-AgentBaseUrl`/`-AgentModel` for another explicitly selected local model. The
switch keeps Core/state in a disposable cluster and reports in a temporary
directory. It validates real inference, then kills processes after model output,
after file creation, after receipt commit and after Core completion. Recovery
must preserve one execution/memory/context and avoid re-running saved inference.
Before a checkpoint, repeated inference is expected after death. No production
queue, Windows task or persistent worker is enabled.

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
Apply `sql/setup.sql` as the state owner when upgrading: the new effect columns
belong only to control state. Existing jobs remain `none` and cannot be silently
upgraded to effectful work.

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

For the real review/report mode, use isolated pilot Core/state connections and
an existing protected local output directory:

```powershell
$env:FORGE_COORDINATOR_AGENT_MODE = 'local-report'
$env:FORGE_COORDINATOR_AGENT_BASE_URL = 'http://127.0.0.1:1234/v1'
$env:FORGE_COORDINATOR_AGENT_MODEL = 'forge-agent-pilot-qwen35'
$env:FORGE_COORDINATOR_REPORT_ROOT = '<absolute-existing-local-directory>'
node packages/coordinator/dist/cli.js enqueue <projectKey> <newTaskKey>
node packages/coordinator/dist/cli.js worker
node packages/coordinator/dist/cli.js status <projectKey> <newTaskKey>
```

The report target is fixed on enqueue; workers configured for another target or
mode leave the job untouched. Inspect `effect_state` (`unconfirmed`/`confirmed`)
and the target fingerprint instead of interpreting `idle` as a drained queue.
Status also exposes the confirmed relative report filename and SHA-256, without
the artifact body or absolute output path.
Only the host chooses destinations. Model output cannot select paths, commands
or URLs. Reports are untrusted data and are never executed.

The receiver never overwrites a conflicting file and does not recreate a
missing previously confirmed report. Such states require operator review. Its
guarantee assumes retained local files/control state and atomic hard links;
there is no copy-with-overwrite fallback for unsupported filesystems.

Status omits the artifact and credentials. Failed work returns a nonzero exit
code. No Windows startup task or production service is enabled by this change.

An actual agent host imports `Coordinator`, `PostgresJobStore` and the existing
Gateway. Call `runOnce({projectId, agentId, workerId}, handler)`; the handler gets
`{task, signal}` and returns `{title, content}`. Keep `workerId` unique per process.
The coordinator alone performs Core writes. Model, tool and process policy stay
in that host. Coordinate backups of control state with Core before relying on
recovery from data loss; this acceptance covers process failures, not loss of
the state database or a production restore.

`LocalReportAgent.run` is a bounded handler for the opt-in mode.
`ImmutableReportPublisher` is supplied through `new Coordinator(store, core,
{publisher})`. Its immutable effect policy must also be supplied when enqueuing
through the library. A model transport failure can retry within the job's
attempt budget before output is prepared; confirmed output/effects are reused.
