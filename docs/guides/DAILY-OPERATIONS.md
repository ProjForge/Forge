# Daily operation and acceptance

## Windows startup

The existing `FORGE Embedding Worker` scheduled task runs at user login and every
minute, using a limited interactive principal, hidden VBS launcher and
`MultipleInstances=IgnoreNew`. Its launcher now ensures the installed LM Studio
service is awake, loads the configured embedding model only if needed, starts
the HTTP server on `127.0.0.1:1234` and probes the configured vector dimensions
before indexing the configured project. No models are downloaded. Reranking
remains optional per query. The shared JSON and CurrentUser DPAPI remain in use.

Register from the repository root with
`packages/embedding-worker/scripts/register-windows-task.ps1`. Export the existing
task XML first. To roll back, stop this task and restore its previous XML and
enabled/disabled state. Do not restore or replace any recovery task implicitly.

An actual logout/login remains an operator acceptance step. Confirm one worker
instance, a fresh PASS status and a real semantic query after login. Workbench
reads worker status with a three-minute freshness window and polls health every
30 seconds. Provider catalog availability does not certify inference quality.

Windows acceptance on 2026-11-06 verified the registered enabled user-logon
trigger, limited interactive principal, hidden action and IgnoreNew policy.
With the HTTP server stopped and Qwen unloaded, starting the registered task
restored service, indexing and a real 1024d embedding in about four seconds.
A following periodic cycle completed with exit zero. The LM Studio application
itself remained running; this evidence does not replace a real Windows login.

Fresh MCP clients must be launched with the environment configured for each
server; SDK test transports do not inherit arbitrary custom environment values
automatically. Both updated launchers passed status/search acceptance with that
environment. Existing Codex connections require a reload to adopt changed paths.

## WAL queue and activation

The uploader excludes receipted files before limiting a batch. Its additive
`pendingCount` and `oldestPendingAt` fields describe the queue after processing,
including on transport failure. Receipts already written remain progress for
the next invocation. `PackageOnly` does not authenticate remote copies.

Workbench reports a nonempty queue as degraded and legacy uploader output as
coverage unknown. The PITR monitor remains authoritative for the existing
75-minute WAL authentication window. A successful uploader cycle alone never
proves PITR recoverability.

Before activating a corrected uploader, review its destination, current queued
bytes and Object Lock retention, then obtain action-time upload authorization.
Export the original task definitions before changing actions. Switch only after
tests pass; preserve policy and credential files. After authorization, drain
bounded batches, observe an automatic cycle and authenticate an isolated
production-chain restore before claiming PITR recovery.

For a production chain without creating a new administrative restore point,
run `packages/resilience/scripts/test-production-recovery-windows.ps1` with
`-LatestAvailable -BaseLabel <retained-base-label>`. It fetches and authenticates
the retained base and WAL from its starting segment onward, validates cluster
and timeline, runs `pg_verifybackup`, recovers on a separate loopback port and
compares project/memory counts and migration checksums to a source read snapshot.
It proves archive-end recovery only. It does not prove a named target or include
writes still in an unarchived WAL segment. The original named-target mode remains
available using an existing matching recovery point.

## Checks

Run `npm run check`, `npm run audit:production`, the PowerShell uploader and
monitor tests, syntax validation and `Test-Diagnostics.ps1`. The uploader test
uses synthetic WAL and fake transport to cover starvation, batch progression,
partial failure and receipt-preserving resume without AWS.

After compiling tests, `scripts/acceptance/Test-FORGE-IsolatedRecovery.ps1`
creates a disposable loopback PostgreSQL cluster, runs the native logical
backup/authentication/restore test and stops/removes the cluster. It needs no
production credential. Its synthetic evidence is separate from real-chain PITR.

## Linux / Obsidian: pending access

Keep the Linux database independent. When available, begin with read-only
`systemctl show forge-embeddings.service forge-obsidian-sync.service` restricted
to LoadState, ActiveState, SubState, Result and ExecMainStatus. Check the local
`/v1/models` endpoint on port 8080. Inspect the actual `watcher.py` and
`sync_obsidian.py` before designing a patch; do not print credentials, note
contents or unredacted journal output.

The historical duplicate-path error is not a verified current failure. Once
access is available, isolate one writer and reproduce it. Reuse the existing
document identity for idempotent writes; protect service/manual overlap with a
shared lock. Test YAML dates, repeated notes, updates and concurrent triggers.
Acceptance requires exit zero for a controlled run and a clean automatic cycle.
No Linux source or service has been changed in this Windows session.
