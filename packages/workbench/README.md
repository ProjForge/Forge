# FORGE Workbench 0.1.1

The first user-facing client for FORGE. It runs locally, lists projects,
memories and decisions, supports idempotent creation, and exposes fast or
optional precision semantic search.

## Install on Windows

The Windows x64 release candidate contains an executable with its own Node.js
runtime, a CurrentUser DPAPI configuration assistant, a hidden launcher and an
uninstaller. Extract the release ZIP and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install-FORGE-Workbench.ps1
```

No administrator permission is required. PostgreSQL and the FORGE schema remain
prerequisites. Public publication additionally requires choosing the project
license and a Windows code-signing identity.

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
- PostgreSQL password is decrypted from DPAPI only in the Node launcher.

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
