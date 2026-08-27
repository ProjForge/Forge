# FORGE Workbench 0.2.0-rc.5

The local human-facing client for FORGE. It runs locally, exposes an operational
task board, assigned-agent catalog and execution history, lists memories and
decisions, supports idempotent creation plus optimistic task assignment/status
transitions, inspects immutable continuation packages, and offers fast or
optional precision semantic search. Assigned tasks can now complete the human
execution lifecycle: start, compile a durable continuation snapshot, then
finish with version-checked status. The recovery panel presents sanitized,
read-only freshness for authenticated logical replicas, WAL transport, physical
base backups and the PITR monitor without exposing filesystem paths or secrets.
The interface groups these capabilities into Resumen, Operación,
Conocimiento and Continuidad views and derives project health metrics from the
same project-scoped Gateway data.

Workbench can also onboard an existing repository from a bounded documentation
allowlist and export/import checksummed `.forge-project` bundles. Portable state
includes agents, tasks, memories with provenance and decisions. It deliberately
excludes embeddings and immutable operational history; see
[`docs/PROJECT-PORTABILITY.md`](../../docs/PROJECT-PORTABILITY.md).

## Install on Windows

The Windows x64 release candidate contains an executable with its own Node.js
runtime, a CurrentUser DPAPI configuration assistant, a hidden launcher and an
uninstaller. The installer verifies the package, performs transactional
updates, preserves existing credentials and rejects accidental downgrades.
Extract the release ZIP and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-FORGE-Workbench.ps1
```

Installed releases also include `Export-FORGE-Diagnostics.ps1`, which creates
an allowlist-redacted support ZIP without copying raw configuration, secrets,
database content or logs.

No administrator permission is required. PostgreSQL and the FORGE schema remain
prerequisites. General-user publication additionally requires a Windows
code-signing identity.

## Run from source on Windows

Prerequisites: PostgreSQL/pgvector and LM Studio configured as documented by
FORGE Core. The launcher reuses the existing CurrentUser DPAPI credential.

```powershell
npm run start:windows
```

Open `http://127.0.0.1:7334`. Override the port with
`FORGE_WORKBENCH_PORT`; only `127.0.0.1` and `::1` are accepted bind hosts.

Fast search requires the Qwen embedding model. Precision mode also requires:

```powershell
lms load qwen/qwen3.5-9b --identifier forge-reranker-qwen35-9b --context-length 4096 --parallel 1 --gpu max
```

## Security boundary

- Loopback-only HTTP server.
- Random per-process API token and same-origin enforcement.
- CSP, frame denial, no-store and MIME-sniffing protection.
- 64 KiB ordinary JSON limit, a 4 MiB package limit and bounded text inputs.
- Repository onboarding rejects source trees, traversal and likely secret paths.
- Portable imports verify their SHA-256 envelope and commit atomically.
- No raw SQL or browser-held database credentials.
- Writes flow through Gateway idempotency contracts.
- Agent, task and continuation reads remain project-scoped in PostgreSQL.
- PostgreSQL password is decrypted from DPAPI only in the Node launcher.
- Recovery status readers accept only bounded regular JSON files discovered by
  the launcher; paths, policy contents and worker errors never reach the browser.

The Workbench is a local operator tool, not a remotely exposed multi-user
service. Remote deployment requires an authenticated HTTPS boundary and is out
of scope for 0.1.x.

## Validate

```powershell
npm run build
npm test
npm audit --omit=dev
```

Native PostgreSQL 18 portability acceptance uses an isolated loopback cluster
that is erased after the run:

```powershell
.\scripts\acceptance\Test-FORGE-ProjectPortability.ps1
```

See `docs/ARCHITECTURE.md`, `docs/VALIDATION.md` and
`docs/IMPLEMENTATION_FINDINGS.md`.
