# Validation

Validated on 2026-08-14 with Node.js 24, PostgreSQL 18.4, Schema 0.1.3,
pgvector 0.8.2, LM Studio and Qwen3 Embedding 0.6B Q8.

- TypeScript strict production build: PASS
- Unit/HTTP/configuration tests: 9/9 PASS
- Gateway native continuation integration: PASS
- Assigned-agent catalog and registration/assignment: PASS
- Optimistic task reassignment and stale-version rejection: PASS
- Continuation package catalog/load and cross-project rejection: PASS
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

Live data showed 52 projects, 14 FORGE Core memories and 10 decisions. The UI
now selects `forge-core` by default and offers client-side project filtering so
integration fixtures do not obscure the product project.
