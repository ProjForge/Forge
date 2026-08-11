# Implementation Findings

Date: 2026-08-11

## WORKER-ARCH-01 — A durable job table is unnecessary for the first slice

Status: simplified and regression-tested

Schema 0.1.3 already makes current indexed versions disappear from candidate
pages and makes writes idempotent. A restarted worker can safely rescan from the
beginning; an opaque cursor remains available for bounded continuation. Adding a
queue, lease table or migration now would duplicate existing persistence truth.

## WORKER-SEC-02 — Provider errors could leak upstream response bodies

Status: prevented and tested

HTTP failures return status/classification only. Raw provider bodies, API keys
and database URLs never enter worker results or stderr. Remote plain HTTP is
rejected; only loopback development servers may use it.

## WORKER-ENV-03 — No live provider runtime was available

Status: resolved by local runtime validation

LM Studio was already installed with Nomic Embed Text v1.5. Its loopback
OpenAI-compatible endpoint returned finite 768-dimensional vectors and accepted
the worker's explicit dimensions parameter. No remote credential or paid call
was needed.

## WORKER-CORRECTNESS-04 — Model task prefixes are part of vector identity

Status: corrected and regression-tested

Nomic Embed Text v1.5 requires `search_document:` for indexed passages and
`search_query:` for queries. Sending raw text succeeds but weakens retrieval
quality. Worker 0.1.1 adds the optional `FORGE_EMBEDDING_INPUT_PREFIX`, applies
it before provider calls and binds it to immutable profile and record metadata.
FORGE Core remains provider-agnostic.

## WORKER-CORRECTNESS-05 — Query transforms must also be profile-bound

Status: corrected and regression-tested

Worker 0.1.1 recorded the document-side prefix but only applied the query-side
prefix in the smoke utility. That allowed callers to change query instructions
without changing profile identity. Worker 0.1.2 adds
`FORGE_EMBEDDING_QUERY_PREFIX` to immutable profile metadata while keeping it
out of document inputs. A different query protocol now requires a new profile
key.

## WORKER-PACKAGE-06 — The published smoke command omitted its script

Status: corrected and clean-install-tested

The package declared `smoke:live-query`, but the npm `files` allowlist omitted
`scripts/live-query-smoke.mjs`. Source-tree validation passed while an installed
TGZ would fail that command. Worker 0.1.2 includes the script explicitly and the
clean-package check verifies its presence.
# FINDING-WORKER-07 — Windows battery policy terminates continuous tasks

The default scheduled-task settings disallow battery start and stop a running
task when the machine switches to battery. Live validation produced
`0xC000013A` after a successful indexing cycle. The registration script now
explicitly permits battery operation; otherwise a laptop cannot provide a
reliable continuous indexer.

## PACKAGING-08 — Operational launchers were excluded from the tarball

The package allowlist named only the previous live-query smoke script. The new
continuous launcher and scheduled-task registrar therefore passed source-tree
tests but were absent from the first 0.1.3 pack preview. The allowlist now ships
the complete `scripts` directory and the final tarball contents are verified.

## FINDING-WORKER-09 — Managed desktop sessions can terminate long-running tasks

The worker completed repeated cycles correctly but the host later delivered
`0xC000013A` to the long-lived scheduled process. Windows deployment now runs a
bounded idempotent cycle every minute instead. This makes normal exit observable
and lets Task Scheduler provide recovery without weakening the reusable
continuous mode.

## FINDING-EVAL-10 — Qwen 0.6B misses the production top-1 gate

The 30-fact/60-query bilingual suite measured top-1 83.33%, top-3 98.33% and
MRR 0.9028 with zero project leaks and zero stale results. The accepted gates
are 90%, 98% and 0.94. A more specific Qwen instruction reduced quality, so it
is rejected. Production acceptance now requires measured reranking or a larger
embedding profile; the benchmark is not weakened.

## FINDING-EVAL-11 — Larger embeddings do not automatically fix fine ranking

Qwen3 Embedding 4B Q4_K_M reached top-1 86.67% and MRR 0.9167 but regressed
top-3 to 96.67%. Its larger 2560-dimensional vectors and 2.50 GB model do not
justify replacing the operational 0.6B profile.

## FINDING-EVAL-12 — Optional top-5 reranking meets the gate

Qwen3.5 9B with reasoning disabled reranked the 0.6B top five to exactly 90%
top-1 with 98.33% candidate recall, zero parse errors, mean 622 ms and p95 675
ms. The first run exposed that reasoning tokens can consume the entire output;
`reasoning_effort: none` is required for deterministic classification. Adoption
requires a project-scoped candidate-text hydration contract outside Core.

## FINDING-WORKER-13 — Interactive scheduled tasks can flash a console window

The minute trigger used an interactive PowerShell action. `-WindowStyle Hidden`
applies after process creation, so Windows could briefly show a console on every
cycle; the task setting named `Hidden` only hides the task in Task Scheduler.
Worker 0.1.6 launches the existing PowerShell runner through `wscript.exe` with
window style `0`. A manual run and the following automatic cycle both completed
with task result `0`, while least privilege, DPAPI and periodic execution remain
unchanged.
