# ADR-002: Optional semantic reranking

**Status:** Accepted
**Date:** 2026-08-11
**Deciders:** FORGE maintainers

## Context

The frozen 60-query suite measured Qwen3 Embedding 0.6B below the top-1 gate.
We compared a larger embedding profile with reranking while preserving project
scope and unchanged acceptance thresholds.

## Decision

Keep Qwen3 Embedding 0.6B Q8 as the default fast retriever. Add a future,
optional top-5 reranking stage for workflows requiring single-result precision.
Do not adopt Qwen3 Embedding 4B Q4_K_M.

## Options Considered

| Option | Quality | Runtime cost | Decision |
|---|---:|---:|---|
| 0.6B embeddings | 83.33% top-1 | 639 MB | Keep as fast retrieval |
| 4B Q4 embeddings | 86.67% top-1 | 2.50 GB; 2560-d vectors | Reject |
| 0.6B + Qwen3.5 9B top-5 rerank | 90% top-1 | 9.73 GiB; 622 ms mean | Optional path |

## Consequences

- Default retrieval remains small and fast.
- Precision mode incurs model-load and ~0.6 second reranking latency.
- Gateway 0.1.5 and Core MCP 0.1.5 provide project-scoped, version-bound,
  bounded candidate-text hydration; the semantic bridge can now consume it.
- Reranking remains outside FORGE Core and cannot weaken project isolation.
