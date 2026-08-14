# TencentDB compatibility implementation findings

Date: 2026-08-15  
Scope: TencentDB for PostgreSQL Core certification

| Finding | Result |
| --- | --- |
| TCDB-001 — PostgreSQL protocol compatibility was being mistaken for provider validation | Fixed: the gate detects TencentDB roles and records provider-specific evidence. |
| TCDB-002 — A remote compatibility test could destroy a reused database | Fixed: unique ephemeral database/role names are mandatory and pre-existing targets cause a hard stop. |
| TCDB-003 — Managed PostgreSQL could be tested over an encrypted but unauthenticated channel | Fixed: connection URLs require `sslmode=verify-full`, and the live session must appear in `pg_stat_ssl`. |
| TCDB-004 — A managed service cannot be restarted by the database test runner | Clarified: the gate proves connection-recycle persistence and does not mislabel it as provider restart/failover evidence. |
| TCDB-005 — A GitHub-hosted runner would require broad public database ingress | Fixed: the manual workflow requires a labeled self-hosted runner inside the Tencent VPC and a protected environment. |
| TCDB-006 — TencentDB cannot expose the local Windows service/filesystem boundary required by FORGE physical PITR | Accepted: Core certification excludes physical recovery; TencentDB control-plane recovery requires a separate provider adapter/gate. |
| TCDB-007 — Job-level database secrets would also reach checkout, tool setup and dependency installation | Fixed: TencentDB credentials exist only in the isolated gate step environment after `npm ci`. |
