# Windows bootstrap implementation findings

Date: 2026-08-14

| Finding | Result |
| --- | --- |
| BOOT-01 — MCP launcher embedded one local database and credential filename | Fixed: shared validated configuration, BOM support and bounded credential filename |
| BOOT-02 — embedding launcher embedded a database and project UUID | Fixed: project/database/provider values are loaded from shared configuration; missing project scope fails closed |
| BOOT-03 — Workbench installer replaced existing embedding configuration | Fixed: installer preserves the optional embedding block and shares the selected DPAPI credential |
| BOOT-04 — PowerShell 5.1 UTF-8 BOM could invalidate Workbench JSON | Fixed with regression coverage |
| BOOT-05 — active MCP/worker registrations still targeted old output copies | Migrated to the canonical repository launchers; MCP reports 27 tools and worker exits zero |
| BOOT-06 — new-user setup was fragmented and non-resumable | Fixed in source with atomic phase status, plan mode, resume and data-preserving rollback |
| BOOT-07 — clean-machine acceptance has not run against a fresh Windows installation | Open; Core Complete installation gate remains blocked |
| BOOT-08 — logical recovery scheduling assumed a pre-existing backup role | Fixed: bootstrap configures the dedicated read-only role first and keeps the admin secret out of arguments |

No plaintext credential was written to source, JSON, status output or process
arguments. PostgreSQL data and recovery artifacts are outside rollback scope by
design.
