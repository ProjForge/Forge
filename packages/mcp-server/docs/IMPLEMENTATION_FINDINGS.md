# FORGE MCP Server 0.1 — Implementation Findings

Date: 2026-08-10

## MCP-DEP-01 — The next major SDK line is not the production baseline

Status: resolved by version pin

The official TypeScript SDK is developing its next major line while continuing
to recommend v1 for production. The server therefore pins
`@modelcontextprotocol/sdk` 1.30.0 and Zod 4.4.3 instead of accepting a moving
major/beta range.

## MCP-SEC-02 — Protocol stdout must remain uncontaminated

Status: enforced and tested through a spawned client/server process

Any banner or diagnostic written to stdout can corrupt stdio JSON-RPC. The
entrypoint reserves stdout for the SDK transport and sends its readiness/error
messages to stderr.

## MCP-ERR-03 — Raw database failures should not become model-visible

Status: fixed by boundary translation

Gateway domain errors retain their stable code and useful message. Unexpected
driver/programming errors are logged locally and returned as a generic
`INTERNAL_ERROR`, preventing SQL details from leaking through tool results.

## MCP-TEST-04 — In-memory tests do not prove process replacement

Status: covered by native integration

The unit suite uses linked in-memory transports for speed, but the continuity
test launches the compiled stdio server as a real child process, closes it,
launches another process and verifies PostgreSQL-backed recovery.

## MCP-SQL-05 — No schema or Gateway correction required

Status: confirmed

The original thirteen tools completed their native workflow through the limited role.
No migration or additional database privilege was required.

## MCP-PKG-06 — Nested file dependency broke standalone tarball installation

Status: fixed and clean-install tested

The first package referenced the local Gateway tarball through a nested
`file:vendor/...` dependency. npm attempted to resolve that file before the
outer package was fully installed and failed with `ENOENT`.

Minimal correction: resolve the local tarball through the development lockfile,
declare the exact Gateway version in the package manifest and mark it as a
bundled dependency. npm embeds the installed Gateway under the MCP tarball's
`node_modules`, while the Gateway remains a separate source/package boundary.

## MCP-WIN-07 — App-resolved PowerShell could not load the security module

Status: fixed with an explicit native runtime

The first interactive credential setup resolved `powershell.exe` through the
app environment. That runtime located `Microsoft.PowerShell.Security` but
failed to load it, so no credential was written.

The setup now runs under the native Windows PowerShell 5.1 runtime and calls
.NET `ProtectedData` directly with `CurrentUser` scope, avoiding the module
autoload path entirely. A non-secret DPAPI probe passed before retrying
credential setup.

## MCP-STDIO-08 — A PowerShell wrapper interfered with the MCP process boundary

Status: fixed with a direct Node entrypoint

The first Codex launcher wrapped the stdio server inside PowerShell. DPAPI and
ACL setup worked, but the wrapper made initialization unreliable at the host
boundary.

Minimal correction: Codex launches Node directly through `dist/codex.js`. That
entrypoint captures a short native PowerShell DPAPI-decryption child before it
opens the MCP transport, constructs the connection string only in process
memory, and then gives the protocol streams directly to the Node MCP server.
The exact registered launcher passed tool discovery and `forge_status`.

## MCP-READ-09 — Write replay was not sufficient for host-session recovery

Status: fixed with four read-only tools

The first thirteen-tool contract could persist complete workflows, but a fresh
host session still needed previously returned UUIDs. Replaying a create request
is not an appropriate general-purpose read contract.

MCP Server 0.1.1 adds `forge_get_project`, `forge_get_agent`,
`forge_get_task` and `forge_get_execution`. Strict schemas reject unknown
fields; scoped reads require `projectId`; all four advertise read-only,
idempotent annotations. Native stdio replacement tests recovered the same four
entities through the limited PostgreSQL role with no schema or grant changes.

## MCP-CATALOG-10 — Recovery needed operational enumeration, not only known keys

Status: fixed and native restart-tested

Stable-key reads still required the caller to know an entity key. MCP Server
0.1.2 exposes five read-only catalog tools over the Gateway's typed methods.
Strict schemas bound pages to 100 rows, validate explicit `(createdAt, id)`
cursors and reject unknown fields. Task, execution, memory and decision
catalogs require project scope. Native stdio replacement tests discovered and
called all 22 tools, exercised filters and confirmed that memory/decision
catalogs do not expose full body fields. No transport SQL, schema migration or
additional database grant was introduced.

## MCP-PKG-11 — Published file dependency was installable but invalid

Status: fixed and clean-install tested

The first 0.1.2 tarball imported successfully, but `npm ls` marked its bundled
Gateway invalid because the published manifest still required
`file:vendor/forge-persistence-gateway-0.1.2.tgz`; that checkout-only path is
not present after installation.

Minimal correction: the manifest now requires exact semantic version `0.1.2`,
while `package-lock.json` continues to resolve and integrity-check the local
tarball during development. A fresh `npm ci`, final pack, empty-directory
install, `npm ls` and public import all pass.

## MCP-VECTOR-12 — Provider integration does not belong at the transport boundary

Status: implemented and native restart-tested

MCP Server 0.1.3 adds three strict tools for profile registration, precomputed
vector persistence and semantic search. The contract names provider/model as
metadata but never embeds external credentials or calls an embedding service.
Vectors are bounded to 4096 finite values, writes require source versions and
idempotency keys, and searches remain read-only and project-scoped.

The native spawned-process test registered and replayed a profile, rejected an
invalid vector at the MCP boundary, persisted ranked memory/decision vectors,
replaced the server process and recovered the same ordered results through the
limited database role. Schema 0.1.2 was required to preserve dimension locking
without granting that role profile `UPDATE`.

## MCP-INDEX-13 — External embedding needed a resumable work contract

Status: implemented and native restart-tested

The three vector tools could store and search embeddings but did not let a
fresh worker discover which supported sources were missing or stale. MCP Server
0.1.4 adds the read-only `forge_list_embedding_candidates` tool with strict
project/profile scope, a maximum 50-item page, bounded source text and an opaque
deterministic cursor.

The provider remains outside MCP. A worker pages candidates, computes vectors
and calls the existing idempotent write tool. Native spawned-process tests
prove cursor-safe discovery, candidate disappearance after indexing, restart
recovery and cross-project isolation against Schema 0.1.3.

## MCP-RERANK-14 — Full candidate text must remain an explicit bounded read

Status: implemented and native-tested

MCP Server 0.1.5 exposes `forge_get_semantic_candidate_texts` as the 27th tool.
Its strict input requires one project and 1–50 versioned candidate references;
`maxTextChars` is capped at 32,000. The transport delegates directly to Gateway
0.1.5, marks the tool read-only/idempotent and preserves safe `NOT_FOUND`
behavior for changed or cross-project references. The MCP layer still contains
no reranker, model endpoint or raw SQL.
