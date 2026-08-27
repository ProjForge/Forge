# Raspberry Pi 5 ARM64 acceptance

Raspberry Pi 5 is an optional FORGE test platform, not a user requirement and
not a substitute for the Linux x64 and Windows release gates. Its purpose is to
prove that Core, PostgreSQL continuity and the local Workbench remain portable
on a constrained 64-bit ARM machine.

## Validated scope

The acceptance runner covers:

- Node/npm build and the complete monorepo check;
- disposable PostgreSQL 14 with pgvector 0.8.2;
- migration, restart, reconnect and persistence invariants;
- Persistence Gateway and MCP continuity;
- Workbench repository onboarding, checksummed export, tamper rejection and
  destination import over loopback HTTP;
- automatic container and volume removal, including failure paths.

LM Studio, local embedding throughput, Windows packaging, DPAPI, SmartScreen and
physical recovery are deliberately outside this ARM64 gate. Semantic providers
remain external to Core.

## Prerequisites

- Raspberry Pi 5 with 8 GB RAM;
- 64-bit Raspberry Pi OS, Debian or Ubuntu;
- Node.js 20+ and npm 10+;
- Git, Docker Engine and the Docker Compose plugin;
- at least 8 GB free disk space;
- port `55432` unused.

The pinned pgvector Docker image is built upstream for both `linux/amd64` and
`linux/arm64`. FORGE still verifies the running extension version before any
test data is written.

## Run

From a clean FORGE checkout on the Pi:

```bash
chmod +x scripts/acceptance/test-forge-pi5.sh
scripts/acceptance/test-forge-pi5.sh
```

The runner executes `npm ci` for a clean dependency tree. During local
iteration, use `--skip-install` only after a successful clean run:

```bash
scripts/acceptance/test-forge-pi5.sh --skip-install
```

Use `--plan-only` for a non-mutating description. A bounded, secret-free result
is written to `forge-pi5-acceptance-result.json`; the file is ignored by Git and
is suitable for attaching to a release review. Never attach Docker environment
files, database URLs or project packages.

The database listens only on loopback with a known test-only credential. The
Compose project receives a unique name, and its container and volume are
removed by the exit trap whether the suite passes or fails. An occupied port or
non-ARM64 host fails before mutation.

## Interpretation

A PASS certifies this exact Pi hardware/OS/runtime combination for technical
testing. It does not make every ARM64 distribution certified. Record the JSON
result with the RC evidence before advertising Raspberry Pi support.

Upstream references:

- <https://github.com/pgvector/pgvector#docker>
- <https://github.com/pgvector/pgvector/blob/master/Makefile>
