# ADR-011: Local review agent and confirmed report effects

Status: Accepted
Date: 2026-11-06

## Context

ADR-010 protects coordinator-mediated Core writes, while a real handler can die
after requesting inference or publishing an external effect. Repeating an
arbitrary HTTP operation with the same header does not establish idempotency.
The first real pilot needs a bounded, inspectable effect with receiver-side
deduplication and a way to resolve a missing acknowledgement.

## Decision

Use a local OpenAI-compatible review agent. It receives only the bounded task
title/objective, returns strict title/content JSON and has no tool authority.
Only loopback HTTP(S) is accepted; redirects, tool calls, extra fields,
truncation and excessive responses fail closed. Provider and handler budgets
remain explicit. No cloud provider or production worker is activated.

The approved effect is an immutable local report. Queue admission freezes its
kind and target fingerprint. The fingerprint binds canonical root, device and
directory identity; worker claims filter by project, logical agent, effect kind
and target. Restarting with a different target cannot silently redirect a job.

Persist the generated output before publishing. The host derives the effect
key from project/task identity and the filename from that key's SHA-256. Publish
via a flushed temporary file and atomic hard-link create-if-absent. Existing
output is verified byte-for-byte; it is never overwritten. Store the receiver
receipt in a separate fenced transaction before Core memory/context/completion.

If the worker dies after the report appears but before the receipt commits,
the next worker verifies the existing report and reconstructs the same receipt.
If a confirmed report is missing, its hash conflicts or the target changes,
stop for operator reconciliation rather than fabricate Core success.

The coordinator control schema gains effect policy/target/receipt columns;
Core schema and grants remain unchanged. Apply the idempotent control setup SQL
as its existing state owner before using the new host version.

## Consequences

- Recovery reuses committed model output. An inference whose output was not
  checkpointed may run again; model calls are not claimed to be exactly once.
- One visible report per effect key is established for the retained trusted
  local target on a filesystem supporting atomic hard links. Unknown first
  acknowledgements are resolved by comparing the receiver's actual bytes.
- This contract does not cover arbitrary email, payments, deployments, network
  filesystems, hostile local directory mutation, disk loss or power failure.
  Another receiver needs its own durable idempotency/reconciliation contract.
- Model text remains untrusted data. The host controls the only effect type,
  destination and publication timing; it never executes model-supplied code.
- Live model acceptance is opt-in and isolated. CI uses the same adapter/host
  against a deterministic loopback protocol fixture and real PostgreSQL/files.
