# Agentic integration readiness

Assessment baseline: 2026-11-06, source `f0206b2`, PR #66.
Follow-up: limited-role import corrected and validated on 2026-11-06.
Pilot follow-up: `forge-coordinator` now provides external leases, epochs,
heartbeat and recovery; see [its guide](../../packages/coordinator/README.md).
Real-agent follow-up: opt-in local Qwen review and immutable report publication
are implemented and accepted on disposable PostgreSQL; production workers remain off.

## Verdict

FORGE can serve as a durable memory and execution-record layer for a controlled,
trusted agent runtime over local MCP stdio. An external host must plan and run
the agents, enforce permissions, dispatch work and recover stalled workers.
This assessment does not certify an autonomous distributed orchestrator or an
authenticated remote multi-tenant service.

| Deployment | Assessment |
| --- | --- |
| Local trusted agent with an MCP host | Ready for a supervised pilot |
| Trusted agents with an external dispatcher and bounded concurrency | Conditional pilot; task ownership belongs to the dispatcher |
| External coordinator pilot in this repository | Local real-model review and immutable-report crash/retry acceptance passed |
| Unattended workers relying on FORGE to claim/reclaim tasks exclusively | Missing native claim, lease and heartbeat semantics |
| Mutually untrusted agents or remote tenants sharing one runtime credential | No per-caller authorization boundary established |
| Project onboarding through portable import with the generated limited role | Validated after the follow-up fix; original permissions retained |

## Evidence collected

- Live `forge_status` returned PostgreSQL 18.4, schema 0.1.3 and pgvector 0.8.2.
- Live semantic MCP search returned three current results, all in the requested
  `forge-core` project and the configured Qwen 1024d profile. This is availability
  evidence, not a retrieval-quality benchmark.
- A disposable PostgreSQL 18.4 cluster on loopback port 55440 was migrated using
  the repository migrations. The repository bootstrap created the limited
  `forge_runtime` role; no production database was written.
- At the assessment baseline, the Gateway continuation integration passed but
  portable import failed with SQLSTATE 42501 on `forge.projects`. Follow-up
  validation passes all four native Gateway tests with the original limited
  role, including concurrent imports, decision ancestry and rollback/retry.
  The exact runtime privilege contract and native MCP continuation also pass.
- The native MCP stdio continuation integration passed with that limited role:
  create/assign/task/start, memory and decision writes, vectors, context package,
  process replacement, stable-key recovery, idempotent replays and finish/audit.
- Two independent MCP stdio processes proved concurrent task-create replay
  returns one identity, one of two same-version updates loses with
  `OPTIMISTIC_LOCK`, a task lookup in another project returns `NOT_FOUND`, and
  stable-key execution lookup survives replacing a client/server process.
- The same two clients, using the same assigned `agentId` but distinct execution
  and idempotency keys, both started a running execution for one task. Two running
  executions were observed. Idempotency protects a repeated operation key; it
  does not claim task ownership across different operation keys.
- All four PR CI jobs passed at `f0206b2`: Linux Node 20, Windows Node 22,
  PostgreSQL 14/pgvector and clean Windows bootstrap.
- The disposable cluster stopped and its directory was removed. Sanitized local
  evidence is in `.run/agentic-probes-result.json` and `.run/agentic-readiness.log`.
  Follow-up import evidence is in `.run/import-final-native.log`.

The original MCP probes use deterministic synthetic tool calls, not autonomous LLM planning.
No throughput, long-running unattended operation or hostile-agent acceptance was
performed. Linux CI does not verify the unavailable Linux/Obsidian machine.

## Real-agent and external-effect acceptance

The opt-in coordinator host calls an existing local Qwen3.5-9B Q8 model through
LM Studio. It sends only the bounded task title/objective, rejects tool calls
and malformed output, and exposes no execution authority to the model. The
trusted host publishes a report into a fixed local directory; see ADR-011.

Windows acceptance with Node 22.23.4 and disposable PostgreSQL 18.4 passes all
20 native tests: three model-backed logical agents compete through six worker
processes, with actual process death after inference, file publication, receipt
commit and Core completion. Saved inference and existing report bytes are reused.
One deliberately injected HTTP 503 is retried before the output checkpoint;
11 successful real model calls produce nine confirmed effects. A tenth,
conflicting receiver file is rejected and remains unchanged. Every successful
task retains one Core execution, result memory and continuation package.

The same suite runs in CI against a deterministic loopback protocol fixture and
real PostgreSQL/files; it does not require/download a model. Fast regressions
also cover timeout/cancellation, output limits, target replacement, linked roots,
concurrent publication and missing confirmed reports. The original Core runtime
privilege contract passes without new grants. Only coordinator-owned control
state gains effect columns; no production database, queue or service is changed.

Local Node 24.15 intermittently exits natively with `0xC0000409` in worker/CLI
processes. Node 22 remains the Windows acceptance/CI baseline. Native exits fail
acceptance and are not treated as retryable model errors. Similar Windows runtime
shutdown failures are tracked in [Node issue 56645](https://github.com/nodejs/node/issues/56645);
this observation does not establish an exact native stack or an upstream fix.

An inference can repeat after death before its output is durably saved. Effect
protection is specific to retained trusted local files with atomic hard links;
it does not establish exactly-once email, deployment or arbitrary HTTP effects,
power-loss durability, state-database recovery or general review quality.

## Limits established by code and probes

1. **Dispatch and crash recovery.** `startExecution` validates task scope and
   assignment and inserts a running execution. It provides no task claim, lease,
   worker heartbeat, automatic reassignment or fencing token. A trusted external
   dispatcher must prevent duplicate side effects and reconcile abandoned runs.
   The new external pilot supplies scoped leases and fenced publication for
   trusted workers, while leaving these Core contracts unchanged. Process death,
   lost replies and stale-worker recovery are tested with real worker processes;
   real review/report acceptance is described above. Other effect receivers,
   model quality and state-database loss are not certified.
2. **Caller identity.** The stdio process trusts its host and database credential.
   Tool arguments such as `projectId` and `agentId` identify records; they do not
   authenticate a caller. The limited role has table-wide privileges and Core
   exposes project discovery. Relational project scoping is not tenant ACLs.
   `capabilities` and `policyVersion` do not establish enforced tool permissions.
3. **Capacity.** Each Core MCP process allows a pool of up to ten connections;
   bootstrap limits the shared runtime role to twenty connections. Pools open
   lazily, so these numbers do not imply a fixed supported agent count. Bound
   concurrency and measure actual workloads before expanding deployment.
4. **Portable import locking contract (corrected).** The baseline used a project
   row lock requiring UPDATE privileges and subsequently updated decision
   supersession links. Both conflict with the limited role. Imports now take a
   transaction-scoped advisory lock per target key, including absent targets,
   and insert decisions in ancestry order with their links already set.
   Conflicting existing ancestry is rejected. Bootstrap grants and schema remain
   unchanged. PostgreSQL CI and clean-Windows acceptance now enforce limited-role
   privileges and the complete Gateway import regression suite.
5. **Host responsibility.** The host must treat retrieved content as untrusted
   data, enforce its tool allowlist and approvals, apply time/cost budgets and
   use stable idempotency keys on retries. FORGE persists knowledge and audit;
   successful persistence does not verify a model's conclusions or side effects.

## Smallest useful deployment

Use one trusted MCP host, one FORGE project per work scope, the limited runtime
role, Core stdio and the read-only semantic bridge. Keep Workbench on loopback.
The external dispatcher owns task allocation and cancellation. Preserve returned
UUIDs, use stable-key lookups after reconnect, reuse pagination cursors and retry
keys, and refresh records after optimistic-lock conflicts.

The existing native lifecycle test can be repeated using an isolated migrated
database and its limited runtime URL with `npm run test:integration -w
forge-mcp-server`. Run the full Gateway integration with
`FORGE_TEST_REQUIRE_LIMITED_ROLE=1` to enforce the no-UPDATE prerequisite as well
as import behavior. Never point these write tests at the production DB.

Before broader unattended deployment, plan control-state backup/recovery, accept
each additional external-effect receiver, measure sustained bounded
multi-process load and complete real Windows login acceptance.
Remote/untrusted deployment requires a separate authenticated authorization
design. Core schema and production configuration remain unchanged.
