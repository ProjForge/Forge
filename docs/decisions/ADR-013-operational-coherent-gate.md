# ADR-013: Shared admission and durable SQL sealing for coherent preproduction

Status: Accepted for disposable preproduction only
Date: 2026-11-10
Deciders: Trusted fixture operator; production activation remains unapproved

## Context

A coherent archive must not split an external report effect from its committed
receipt. SQL table locks alone cannot drain provider calls or report publication.
Gateway serves Core, MCP, Workbench and embedding clients; coordinator state lives
in another database. The current target is one trusted Windows host, with no new
service, production change, external receiver or dependency authorized.

## Decision

Use one private shared-directory admission/drain gate at existing common ports,
with whole coordinator jobs and embedding batches holding outer admissions.
Async-local nesting lets admitted work finish while new work rejects. Never expire
or steal crashed tickets. Explicit configuration opts a topology into the gate.

After drain, validate both disposable databases and all login credentials, commit
NOLOGIN for declared limited writers, evict old sessions and verify exclusion.
Only the synthetic SCRAM superuser operator remains LOGIN. The NOLOGIN backup
role is used through pg_dump --role, with SELECT on user objects; catalog PUBLIC
functions are not revoked, and no separate backup session can authenticate. Never
restore LOGIN or reopen managed admissions from a failure cleanup path.

Reuse authenticated coherent envelopes. Wrap a synthetic random key with
RSA-OAEP-SHA256 using an independent private-ACL escrow directory. Authenticate
the complete replica on a distinct filesystem device before publishing it.
Restore in a separate process after removing the disposable source and primary.

## Options considered

| Option | Complexity | Cost | Scope |
| --- | --- | --- | --- |
| SQL locks only | Low | None | Cannot cover external effects; rejected |
| New distributed admission service | High | New operation/dependency | Unnecessary for this single-host fixture; deferred |
| Shared private admission plus durable limited-role SQL backstop | Moderate | No new dependency | Covers the declared trusted local topology; selected |

## Consequences

- Existing transaction, idempotency, fencing, limited grants and NTFS contracts stay.
- Crashes can require manual reconciliation and reduce availability; fail closed.
- Direct administrator misuse, unknown receivers and detached effects are excluded.
- C: and E: prove separate volumes, not independent hosts or physical failures.
- ACL-protected escrow is trusted local custody, not a hardware or separate-user vault.
- Production topology, custody, retention and activation require a separate review.

## Action items

1. Execute late-call, drain, crash/ownership, SQL, custody and replica negatives.
2. Preserve actual exits, role contract, restore/replay and cleanup evidence.
3. Keep production configuration unchanged and document manual reconciliation.
