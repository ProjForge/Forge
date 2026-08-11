# FORGE Semantic Evaluation v2

Versioned 30-fact, 60-query Spanish/English retrieval regression.

Acceptance thresholds:

- top-1 >= 90%
- top-3 >= 98%
- MRR >= 0.94
- zero cross-project leaks
- zero stale results

Run with `scripts/test-evaluation-v2.ps1` while PostgreSQL and LM Studio are
available. The runner seeds an isolated idempotent project, indexes it through
the real worker, queries the real Gateway and writes a JSON report.

The first Qwen3 Embedding 0.6B Q8 baseline did not pass: top-1 83.33%, top-3
98.33%, MRR 0.9028, zero leaks and zero stale results. A more specific query
instruction was worse and is rejected. The measured gap is ranking precision,
not project isolation or top-3 recall.

Follow-up comparison:

- Qwen3 Embedding 4B Q4_K_M: top-1 86.67%, top-3 96.67%, MRR 0.9167; rejected.
- Qwen3 Embedding 0.6B + local Qwen3.5 9B generative reranker over top-5:
  top-1 90%, candidate recall 98.33%, mean 622 ms, p95 675 ms; accepted
  as the architecture direction, pending a production candidate-text contract.
