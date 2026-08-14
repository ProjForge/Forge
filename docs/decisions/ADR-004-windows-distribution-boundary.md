# ADR-004: Windows distribution boundary

Status: Accepted
Date: 2026-08-11
Amended: 2026-08-14

## Context

Workbench needs a usable Windows distribution without requiring Node.js or
administrator privileges. Its PostgreSQL password must not be embedded in the
executable, installer arguments, configuration JSON or browser state. Public
publication also introduces licensing, provenance and executable-signing
obligations.

## Decision

Distribute FORGE Workbench as a self-contained Windows x64 executable plus a
per-user PowerShell installer. Non-secret connection/provider settings live in
validated `%APPDATA%\FORGE\workbench.json`; the password lives in a separate
CurrentUser DPAPI blob. Installation, Start Menu shortcut and uninstallation
remain user-scoped and require no elevation. Unsigned packages may be published
only as explicitly labeled technical prereleases. General-user promotion
requires valid timestamped Authenticode, verified manifests and installation
acceptance.

## Consequences

Users can install and run Workbench without a Node.js prerequisite, while the
existing loopback and secret boundaries remain intact. PostgreSQL/schema setup
and optional LM Studio models remain prerequisites. The release pipeline binds
artifacts to a clean annotated tag, verifies internal and external SHA-256
coverage, and records build provenance without automatically publishing.
SmartScreen warnings remain expected for explicitly unsigned prereleases.
