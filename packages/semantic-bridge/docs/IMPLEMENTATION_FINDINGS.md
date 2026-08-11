# Implementation findings

## FINDING-BRIDGE-01 — Zod optional-property inference

With `exactOptionalPropertyTypes`, Zod's inferred tool-handler input permits an
optional key whose value is explicitly `undefined`, while the domain input
requires the key to be absent. MCP JSON cannot carry `undefined`; the validated
handler value is therefore safely narrowed at the transport boundary. No domain
contract was weakened.

## FINDING-BRIDGE-02 — DPAPI credential envelope

The existing Windows credential file contains Base64-encoded DPAPI ciphertext,
not raw ciphertext bytes, and Windows PowerShell requires `System.Security` to
be loaded explicitly. The live-test launcher now follows the established reader
and clears all secret-bearing process variables in `finally`.

## FINDING-BRIDGE-03 — Precision mode must not tax or alter default retrieval

Status: implemented and live-tested

Semantic Bridge 0.1.1 keeps the existing vector-only path unless the caller
passes `rerank: true`. Precision mode retrieves at least five candidates,
hydrates current full text through Gateway 0.1.5 and promotes one model-selected
candidate while preserving the semantic order of the remainder. The model is
external and optional; Core contains no provider logic.

The validated generative model consumed its entire response budget when
reasoning was enabled. The compatible request therefore fixes temperature to
zero, `max_tokens` to 64 and `reasoning_effort` to `none`. Qwen 3.5 may return
an empty completion or remain active too long when constrained to 16 tokens;
64 remains tightly bounded. The prompt also begins with `/no_think`, because
the local Qwen chat template otherwise entered deliberative mode and exceeded
the MCP latency budget on the real five-candidate corpus. Invalid selections,
timeouts and provider failures return typed sanitized errors. Candidate text is
bounded and explicitly treated as untrusted data in the system instruction.
