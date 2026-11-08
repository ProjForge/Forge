# ADR-012: Explicit confirmed-report recovery after receiver loss

Status: Accepted
Date: 2026-11-07

## Context

ADR-011 binds normal work to a physical receiver. Restoring report bytes into a
replacement directory must not silently change that binding or regenerate output.

## Decision

An opt-in one-shot recover-report command selects only the exact project/task,
assigned agent and persisted confirmed receipt. It uses existing attempt budgets,
leases and publication fences, requires prepared output and the original existing
Core execution, and never admits an execution or calls an agent.

The operator supplies pre-loss canonical path/device/inode metadata as a UTF-8
proof file (optional BOM); capture writes exclusively without needing a database. Its fingerprint
must match the original effect target. The trusted replacement must occupy that
same canonical path with a different physical identity. A verification-only adapter
pins it for this invocation, validates the original receipt against prepared bytes,
then supplies a receipt with replacement identity only to the existing publisher's
expected-receipt verification branch. Missing, conflicting or linked reports fail;
no file is created. The adapter returns the original receipt unchanged. Neither
effect_target nor receipt is rebound. Completed replay claims nothing.

## Consequences

An internal exact-project/task checkpoint read supplies prepared output and receipt
for verification before claim; status exposes neither artifact nor raw receipt.
Invalid or missing backup data leaves the entire row/attempt/epoch untouched.
Verification repeats under the existing lease fence. No schema, grants, aliases,
retry resets or checkpoint edits are needed. Once claimed, failures still consume
the existing bounded attempt budget. Exhausted or incompatible
jobs require separate operator reconciliation. This assumes a quiescent trusted
filesystem and a consistent Core/control backup; it is not hostile-filesystem,
power-loss, arbitrary backup or production recovery certification.

Operator procedure: ../guides/CONFIRMED-REPORT-RECOVERY.md.
