# ADR-003: Local Workbench boundary

Status: Accepted
Date: 2026-08-11

## Context

FORGE has a validated database, Gateway, MCP adapter and semantic bridge but no
human-facing product surface. A UI must not duplicate domain SQL, expose the
database password or silently become an unauthenticated remote service.

## Decision

Build Workbench 0.1 as a loopback-only Node web application. It composes the
existing Gateway and Semantic Bridge, decrypts the runtime password through the
existing CurrentUser DPAPI envelope, and protects its local JSON API with a
random process token, origin checks and a strict CSP. Remote binding is rejected.

## Consequences

FORGE gains an immediately usable visual surface with no new schema or provider
coupling. It remains a single-user local operator tool. Multi-user or remote use
requires a later authenticated HTTPS service boundary rather than relaxing this
one.
