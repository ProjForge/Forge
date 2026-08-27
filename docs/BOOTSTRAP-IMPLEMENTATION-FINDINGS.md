# Windows bootstrap implementation findings

Date: 2026-08-21

| Finding | Result |
| --- | --- |
| BOOT-01 — MCP launcher embedded one local database and credential filename | Fixed: shared validated configuration, BOM support and bounded credential filename |
| BOOT-02 — embedding launcher embedded a database and project UUID | Fixed: project/database/provider values are loaded from shared configuration; missing project scope fails closed |
| BOOT-03 — Workbench installer replaced existing embedding configuration | Fixed: installer preserves the optional embedding block and shares the selected DPAPI credential |
| BOOT-04 — PowerShell 5.1 UTF-8 BOM could invalidate Workbench JSON | Fixed with regression coverage |
| BOOT-05 — active MCP/worker registrations still targeted old output copies | Migrated to the canonical repository launchers; MCP reports 27 tools and worker exits zero |
| BOOT-06 — new-user setup was fragmented and non-resumable | Fixed in source with atomic phase status, plan mode, resume and data-preserving rollback |
| BOOT-07 — clean-machine acceptance had not run against a fresh Windows installation | Fixed: the shared acceptance body passed on an ephemeral Windows Server 2022 runner with PostgreSQL 14.23 and pgvector 0.8.2 ([CI evidence](https://github.com/ProjForge/Forge/actions/runs/31833285751)) |
| BOOT-08 — logical recovery scheduling assumed a pre-existing backup role | Fixed: bootstrap configures the dedicated read-only role first and keeps the admin secret out of arguments |
| BOOT-09 — PostgreSQL 14 could not infer the polymorphic `format()` parameter types used to set the runtime-role password | Fixed with explicit `text` casts and regression coverage |
| BOOT-10 — Sandbox plan mode required installed pgvector binaries despite promising a non-mutating preview | Fixed: runtime inputs are validated only when acceptance executes; plan mode is side-effect free even when those paths are absent |
| BOOT-11 — Workbench packaging looked for package-local tools that npm workspaces hoists to the repository root | Fixed: clean workspace tools and an absolute bundle entrypoint are used; the executable and ZIP build passed locally and in ephemeral CI |
| BOOT-12 — a bootstrap regression check encoded deployment-specific sentinel literals | Fixed: generic secret and UUID detection replaces literal values |
| BOOT-13 — automated clean-machine acceptance did not leave an interactive disposable UI for rapid product testing | Fixed: a pinned-release Windows Sandbox lab now provisions fresh PostgreSQL, installs the verified public Workbench and remains open until the tester closes it |
| BOOT-14 — the local Windows Sandbox component can close before executing any guest command | Mitigated: a verified local fallback isolates PostgreSQL data, application files and `%APPDATA%` on non-production ports, then erases them after the session; Sandbox/VM remains required for OS and SmartScreen acceptance |

No plaintext credential was written to source, JSON, status output or process
arguments. PostgreSQL data and recovery artifacts are outside rollback scope by
design.
