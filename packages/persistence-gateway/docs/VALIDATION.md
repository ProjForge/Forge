# Validation

Status: passed

Date: 2026-08-11

## Runtime

- PostgreSQL: 18.4
- FORGE schema: 0.1.3
- pgvector: 0.8.2
- Node.js: 24.15.0
- TypeScript: 5.9.3 strict

## Results

| Layer | Result |
|---|---:|
| Strict production build | Pass |
| Canonical JSON unit tests | 3/3 pass |
| Native PostgreSQL continuity/indexing integration | Pass |
| CLI smoke vertical slice | Pass |
| Dedicated runtime permission contract | Pass |
| npm dependency audit | 0 vulnerabilities |
| Clean TGZ install/public hydration method | Pass |

The native integration covers:

- schema compatibility startup check;
- registration replay and conflicting natural-key data;
- persistent request replay after Gateway replacement;
- rejection of a reused key with different input;
- two concurrent writes sharing one idempotency key;
- rollback of domain state and idempotency claim after a late FK failure;
- optimistic locking and stale-writer rejection;
- memory provenance and decision persistence;
- context compilation and append-only package materialization;
- process replacement followed by context reconstruction;
- stable-key recovery of project, assigned agent, task and execution after
  Gateway replacement;
- rejection of cross-project agent, task and execution lookups;
- stale source detection after a task version change;
- cross-project read isolation;
- deterministic keyset pagination without duplicates across equal timestamps;
- project-scoped task, execution, active-memory and decision catalogs;
- catalog status, priority, assignment, task, agent and type filters;
- summary projections that omit memory and decision bodies;
- ordered execution audit trail;
- profile registration replay and conflicting-definition rejection;
- finite vector, dimension and cosine zero-vector validation;
- source-version optimistic checks for memories, decisions and document chunks;
- idempotent embedding replay and conflicting natural-source rejection;
- exact ranking, score thresholds and deterministic ordering;
- stale-vector exclusion and explicit opt-in inclusion;
- semantic project isolation before and after Gateway replacement;
- transactional `embedding.put` event/audit persistence.
- deterministic bounded candidate pagination without duplicates;
- missing/stale candidate classification and source-text truncation;
- candidate input-hash stability and recovery after Gateway replacement;
- candidate disappearance after indexing and cross-project isolation;
- immutable embedding history across source versions.
- ordered candidate-text hydration with exact source-version matching;
- rejection of changed and cross-project candidate references.

## Smoke result

The CLI created a generic project, agent, task and execution, persisted one memory and one decision, compiled a context package, replaced the Gateway instance and recovered:

```text
memories: 1
decisions: 1
stale sources: 0
audit records: 4
```

No credentials are stored by the package or its tests. Integration traces intentionally remain in the dedicated `forge_test` database.

The final native continuity and smoke runs used `forge_test_runner`, not the
`postgres` administrator. Negative permission checks also confirmed that the
runtime role cannot create schema objects, mutate migration history, update
append-only events or delete project rows.
It can select vector source tables and select/insert profiles and embeddings,
but cannot update or delete either vector table.
