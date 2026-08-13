# FORGE Core Complete gate

Date: 2026-08-14
Status: in progress

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
| Installation | A new Windows user can install/configure schema, least-privilege roles, clients and optional recovery coherently | BLOCKED ON ACCEPTANCE | Generic bootstrap, plan/resume/data-safe rollback and tests pass; run one isolated fresh-Windows execution |
| Clean release | Clean install, CI, audit, manifests, licenses, release notes and rollback are reproducible | PASS FOR SOURCE | Signed Windows publication remains a later distribution gate |

## Release decision

Do not describe FORGE as Core Complete or publish a signed general-user binary
until every row above is PASS or PASS WITH an explicitly accepted limitation.
The next implementation order is:

1. run the guided bootstrap on an isolated fresh Windows environment;
2. correct any native finding and repeat from empty state;
3. run the complete release checklist and only then sign/package.

## Rollback triggers

- any cross-project read or write;
- migration checksum mismatch or persistence loss after restart;
- successful execution completion without immutable continuation context;
- recovery status reported healthy without authenticated replica evidence;
- Workbench binding outside loopback or any credential in browser/process output.
