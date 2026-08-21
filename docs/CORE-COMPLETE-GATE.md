# FORGE Core Complete gate

Date: 2026-08-21
Status: Core Complete for source; unsigned rc.3 published for bounded testing

Core Complete means FORGE's principal local workflows are complete, recoverable
and operable by a new user. It does not mean high availability, automatic
failover, every model provider or unlimited-scale vector search.

## Gate

| Area | Requirement | Status | Evidence or next action |
| --- | --- | --- | --- |
| Relational truth | Migrations, project isolation, managed identity, optimistic locking and append-only history | PASS | Schema 0.1.3 invariant suite |
| Agent continuity | Register, assign, create task, execute, remember, decide, compile/load context and finish | PASS | Gateway/MCP native continuity and Workbench lifecycle tests |
| Human operation | The same principal workflow is available through the loopback-only Workbench | PASS | 11 HTTP/service tests plus desktop/mobile QA |
| Semantic retrieval | Provider-independent indexing, exact project-scoped search and optional reranking | PASS WITH LIMIT | Top-3 98.33%; optional reranker reaches the 90% top-1 gate. Fast top-1 remains 83.33% |
| PostgreSQL compatibility | Core schema and continuity run on the declared PostgreSQL 14+ floor and current 18 | PASS | PostgreSQL 18.4 passed locally; CI passes schema/restart/Gateway/MCP on PostgreSQL 14.23 + pgvector 0.8.2 |
| Logical recovery | Encrypted package, verified replicas, immutable off-site copy and safe empty-target restore | PASS | Native D:/E:/AWS restore drill |
| Physical recovery | Encrypted base/WAL chain and named-target recovery without modifying production | PASS | Production AWS chain restored 53 projects/100 memories |
| Recovery visibility | A human can see backup, replica and PITR freshness without reading task files or using PowerShell | PASS | Fail-closed reader and sanitized Workbench panel validated against installed logical, WAL, base-backup and PITR state on desktop/mobile |
| Installation | A new Windows user can install/configure schema, least-privilege roles, clients and optional recovery coherently | PASS | Ephemeral Windows Server 2022 acceptance passed bootstrap, DPAPI/MCP, installed Workbench, PostgreSQL restart, resume and data-safe rollback on PostgreSQL 14.23 + pgvector 0.8.2 ([run 31833285751](https://github.com/ProjForge/Forge/actions/runs/31833285751)) |
| Clean release | Clean install, CI, audit, manifests, licenses, release notes and rollback are reproducible | PASS WITH LIMIT | Unsigned `v0.2.0-rc.3` is published after a verified update from the exact public rc.2 archive. Signed general-user Windows publication remains a separate distribution gate. |

## Release decision

FORGE Core is complete. `v0.2.0-rc.3` is available as an explicitly unsigned
technical prerelease for bounded tester evaluation. This does not authorize a
general-user binary until the remaining distribution checklist is complete.
The next release order is:

1. obtain approval for the documented SignPath Foundation identity;
2. build from a clean annotated tag and sign only the verified executable;
3. rerun the fail-closed signed verifier, installer acceptance and rollback;
4. publish a distinct signed RC without replacing the unsigned evidence.

## Rollback triggers

- any cross-project read or write;
- migration checksum mismatch or persistence loss after restart;
- successful execution completion without immutable continuation context;
- recovery status reported healthy without authenticated replica evidence;
- Workbench binding outside loopback or any credential in browser/process output.
