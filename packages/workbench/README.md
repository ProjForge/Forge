# FORGE Workbench 0.2.0-rc.1

The local human-facing client for FORGE. It runs locally, exposes an operational
task board, assigned-agent catalog and execution history, lists memories and
decisions, supports idempotent creation plus optimistic task assignment/status
transitions, inspects immutable continuation packages, and offers fast or
optional precision semantic search. Assigned tasks can now complete the human
execution lifecycle: start, compile a durable continuation snapshot, then
finish with version-checked status. The recovery panel presents sanitized,
read-only freshness for authenticated logical replicas, WAL transport, physical
base backups and the PITR monitor without exposing filesystem paths or secrets.

## Install on Windows

The Windows x64 release candidate contains an executable with its own Node.js
runtime, a CurrentUser DPAPI configuration assistant, a hidden launcher and an
uninstaller. Extract the release ZIP and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-FORGE-Workbench.ps1
```

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
- 64 KiB JSON limit and bounded text inputs.
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

See `docs/ARCHITECTURE.md`, `docs/VALIDATION.md` and
`docs/IMPLEMENTATION_FINDINGS.md`.
