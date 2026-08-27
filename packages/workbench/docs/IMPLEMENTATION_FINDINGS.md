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

## FINDING-WORKBENCH-07 — Immutable packages still need a scoped discovery path

Core could compile and load continuation packages, but a human operator needed
an existing UUID to inspect one. A project-scoped Gateway catalog now exposes
only immutable package summaries; full contents still load through the existing
version-aware continuation contract and report stale sources.

## FINDING-WORKBENCH-08 — Assignment is part of optimistic task state

Creating tasks with an agent was supported, but reassignment was not. Workbench
now updates `assigned_agent_id` through a project-scoped, version-checked
Gateway operation. The database foreign key still requires that the selected
agent is actively associated with the same project.

## FINDING-WORKBENCH-09 — Four workspace actions exceeded the mobile width

Adding the agent action exposed an intrinsic-width overflow at 390 px, and the
intercepted form submit made cancel controls unreliable in the live browser.
Mobile actions and task controls now wrap, while cancel submissions use native
`method="dialog"` behavior before application form handling.

## FINDING-WORKBENCH-10 — Execution start trusted an independently assigned agent

Tasks and executions were each project-scoped, but the Gateway did not verify
that the execution agent matched `tasks.assigned_agent_id`. A caller could
therefore start work under another project agent. `startExecution` now checks
the task assignment and rejects completed tasks inside the idempotent
transaction before creating any execution, event or audit row.

## FINDING-WORKBENCH-11 — Successful completion needs a visible durability gate

Workbench now exposes the complete human execution lifecycle. The successful
final state remains disabled until the execution has a continuation package;
failed and cancelled outcomes remain available. Core stays generic and does
not force every non-human execution to compile a package.
# Finding 12 — Recovery evidence was operationally durable but invisible

The logical policy, physical uploader, base-backup worker and PITR monitor each
wrote atomic non-secret status, but a human had to locate and interpret those
files manually. Database health alone could therefore look green while recovery
was stale or failed.

Resolution: the Windows launcher discovers status paths from local non-secret
configuration. Workbench reads only bounded regular JSON files, rejects links,
missing/malformed/stale/failing state, and exposes a sanitized summary. No path,
policy, credential or raw worker error crosses the HTTP boundary.

## FINDING-WORKBENCH-13 — Equal-weight catalogs obscured the operating model

Agents, packages, tasks, executions, memories and decisions appeared as six
equally prominent panels in one continuous page. The interface exposed all
capabilities but did not explain their relationship. Workbench now groups them
into Resumen, Operación, Conocimiento and Continuidad without changing any Core
contract or hiding data behind a server-side state.

## FINDING-WORKBENCH-14 — Project health required manual counting

The operator could inspect each catalog but could not answer the first-screen
questions: how much work is active, whether an agent is running, how much
knowledge exists, and whether recovery is healthy. A compact live summary now
derives those signals from the already project-scoped catalog and sanitized
recovery response; no extra endpoint or duplicated persistent state was added.

## FINDING-WORKBENCH-15 — Responsive did not imply mobile hierarchy

The previous breakpoint prevented overflow but kept every section in one long
mobile document. The new navigation is horizontally safe, actions form a 2x2
touch-target grid, metrics remain scannable, and only the selected operational
area is rendered in the reading flow. Keyboard focus is explicit throughout.

## FINDING-WORKBENCH-16 — Architecture labels did not explain the user's next action

Resumen, Operación, Conocimiento and Continuidad described FORGE accurately but
required the operator to translate internal domains into a workflow. The
navigation now uses Inicio, Trabajo, Memoria and Recuperación, adds one-line
intent labels, orders the operating panels as tasks, executions and agents, and
derives one recommended next action from the existing project catalog. No new
persistent state or Core contract was introduced.

## FINDING-WORKBENCH-17 — Global operation failures were hidden by view routing

Task, assignment and execution handlers wrote failures into the semantic-search
message element. Once the workspace gained routed views, that element was hidden
outside Inicio and Memoria, so a failed mutation could appear to do nothing. A
view-independent live region now reports operational failures while search keeps
its own local progress and result status.

## FINDING-WORKBENCH-18 — Portable state must not forge operational history

A selective project export cannot safely replay executions, immutable context
packages, events or audit rows into another installation. The version 1 format
therefore carries domain state only and explicitly declares those omissions.
The destination records one truthful local import event and audit entry.

## FINDING-WORKBENCH-19 — Idempotent create was blocked before idempotency lookup

The first implementation rejected an already-created project before reaching
the import idempotency record. Replaying a successful `create` request therefore
failed. A create replay now accepts only the same bundle/source metadata and
then resolves through the transactional idempotency contract.

## FINDING-WORKBENCH-20 — Merge cannot equate a stable key with equal content

An `ON CONFLICT DO NOTHING` merge initially reused agent, task and decision keys
without checking their domain fields. Imports now compare existing identities
and fail the complete transaction on incompatible data instead of silently
combining unrelated state.

## FINDING-WORKBENCH-21 — A transaction client is a sequential query boundary

Portable export launched four reads concurrently on one `pg` client. Current
drivers queued them but warned that this behavior is removed in pg 9. The
repeatable-read snapshot now performs the bounded catalog queries sequentially.

## FINDING-WORKBENCH-22 — An export must fit its own import boundary

The first package writer could emit more data than the HTTP importer accepted.
Format v1 now refuses both creation and parsing above 4 MiB; the wrapping HTTP
request has a small separate allowance for its target and idempotency fields.

## FINDING-WORKBENCH-23 — A documentation prefix is not a file type

The initial root allowlist accepted any extension after names such as `README`,
including binary extensions. Root documentation now permits only extensionless
text or `.md`, `.mdx`, `.txt` and `.rst`; credential-like path segments are
also rejected. Content still requires human review because names cannot prove
that a valid document contains no secret.
