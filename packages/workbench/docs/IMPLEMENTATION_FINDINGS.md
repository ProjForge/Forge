# Implementation findings

## FINDING-WORKBENCH-01 — Local HTTP is still a security boundary

Binding to loopback does not prevent a malicious webpage from submitting
requests to localhost. Workbench therefore requires a random per-process header
token, rejects foreign origins and serves a restrictive CSP. Remote binding is
rejected at configuration load.

## FINDING-WORKBENCH-02 — Test catalogs distort product discovery

The validated database contains many persistent integration projects. Selecting
the newest project made the first screen look like a test harness. The client
now prefers stable key `forge-core` and includes a project filter without
hard-coding project behavior into Core.

## FINDING-WORKBENCH-03 — Flex intrinsic width broke the mobile grid

At 390 px the horizontal project strip expanded its grid item to more than
16,000 px and displaced the main content. Explicit `min-width: 0`, bounded rail
width and a 170 px mobile card basis fixed the actual rendered breakpoint.

## FINDING-WORKBENCH-04 — Private dependency bundles need a public facade

Depending directly on Embedding Worker 0.1.6 exposed its historical Gateway
0.1.4 declaration and caused npm to query the public registry. Semantic Bridge
0.1.4 now exposes a lightweight `/workbench` facade that includes Gateway,
provider and search composition while avoiding unused MCP transport imports.
Workbench therefore bundles one self-contained private dependency.

## FINDING-WORKBENCH-05 — The test launcher was not distributable configuration

The first DPAPI launcher fixed the database name and runtime user to the local
validation environment. Workbench 0.1.1 moves non-secret settings to validated
per-user JSON and keeps only the password in a separate CurrentUser DPAPI blob.
Environment variables can still override settings for automation.

## FINDING-WORKBENCH-06 — EncodedCommand does not transport trailing arguments

The first packaged executable passed the credential path after PowerShell
`-EncodedCommand`; Windows PowerShell did not expose that value through
`$args`, so decryption failed despite a valid blob. The child process now
receives the non-secret path through a scoped environment variable. A clean
install and live executable test protects this packaging regression.
