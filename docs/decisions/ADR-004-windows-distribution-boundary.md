# ADR-004: Windows distribution boundary

Status: Accepted
Date: 2026-08-11

## Context

Workbench needs a usable Windows distribution without requiring Node.js or
administrator privileges. Its PostgreSQL password must not be embedded in the
executable, installer arguments, configuration JSON or browser state. Public
publication also introduces licensing and executable-signing obligations that
are not yet decided.

## Decision

Distribute Workbench 0.1.1 as a self-contained Windows x64 executable plus a
per-user PowerShell installer. Non-secret connection/provider settings live in
validated `%APPDATA%\FORGE\workbench.json`; the password lives in a separate
CurrentUser DPAPI blob. Installation, Start Menu shortcut and uninstallation
remain user-scoped and require no elevation. Treat the unsigned ZIP as a local
release candidate, not a public release.

## Consequences

Users can install and run Workbench without a Node.js prerequisite, while the
existing loopback and secret boundaries remain intact. PostgreSQL/schema setup
and optional LM Studio models remain prerequisites. Public publication is
blocked only by product-level choices: repository/license ownership and a
Windows code-signing identity; SmartScreen warnings are expected until signing.
