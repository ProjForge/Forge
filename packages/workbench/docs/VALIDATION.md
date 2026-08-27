# Validation

Validated on 2026-08-21 with Node.js 24, PostgreSQL 18.4, Schema 0.1.3,
pgvector 0.8.2, LM Studio and Qwen3 Embedding 0.6B Q8.

- TypeScript strict production build: PASS
- Unit/HTTP/configuration/recovery-health/portability tests: 24/24 PASS
- Native PostgreSQL 18.4 project portability: PASS
- Repository onboarding to provenance-bound memories: PASS
- Checksummed export, tamper rejection and destination import over HTTP: PASS
- Create replay and merge idempotency: PASS
- Incompatible stable-key merge rejection with full transaction rollback: PASS
- Portable decision supersession and agent/task references: PASS
- Ephemeral portability cluster shutdown and deletion: PASS
- Gateway native continuation integration: PASS
- Assigned-agent catalog and registration/assignment: PASS
- Optimistic task reassignment and stale-version rejection: PASS
- Continuation package catalog/load and cross-project rejection: PASS
- Human start/compile/finish execution lifecycle: PASS
- Wrong-agent and completed-task execution start rejection: PASS
- Loopback token enforcement: PASS
- Cross-origin rejection: PASS
- Invalid project scope rejected before service invocation: PASS
- Live DPAPI launch on `127.0.0.1:7334`: PASS
- Live status/projects/catalog endpoints: PASS
- Live fast semantic search: PASS, 10 current results
- Desktop visual and interactive search review: PASS
- Responsive 390×844 review: PASS after fixing intrinsic-width overflow
- Browser console errors: none
- Self-contained tarball clean install/import: PASS
- Clean-installed DPAPI launch on port 7335: PASS
- Clean-installed PostgreSQL status and loopback bind: PASS
- Production dependency audit: 0 vulnerabilities
- Windows x64 executable and per-user installer: PASS
- Isolated installer + DPAPI round-trip: PASS
- Packaged executable live launch on port 7335: PASS
- Packaged status/catalog against PostgreSQL 18.4: PASS
- Recovery health fail-closed parsing, freshness and path redaction: PASS
- Live installed recovery panel: PASS; logical, PITR, WAL and base status healthy
- Responsive recovery panel at 390×844: PASS; no horizontal overflow
- Installed Windows PowerShell 5.1 UTF-8 BOM status/config compatibility: PASS
- Four-area workspace navigation and project metric asset contract: PASS
- Human-oriented Inicio/Trabajo/Memoria/Recuperación navigation: PASS
- Catalog-derived next-action guidance and contextual creation actions: PASS
- Global operation errors remain visible outside the search view: PASS
- Responsive 2x2 mobile navigation at 390×844: PASS; no horizontal overflow
- Updated small-text contrast against raised surfaces: 5.04:1 minimum

Live data showed 52 projects, 14 FORGE Core memories and 10 decisions. The UI
now selects `forge-core` by default and offers client-side project filtering so
integration fixtures do not obscure the product project.
