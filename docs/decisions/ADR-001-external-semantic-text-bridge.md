# ADR-001: External semantic text bridge

**Status:** Accepted
**Date:** 2026-08-11
**Deciders:** FORGE maintainers

## Context

FORGE semantic search accepts vectors so the Core remains independent of model
vendors. Clients need a safe text-query workflow without duplicating embedding
configuration or coupling the Core MCP server to LM Studio or Qwen.

## Decision

Provide `forge_search_text` through a separate semantic bridge process. The
bridge owns the provider adapter and immutable query transformation, then calls
the existing project-scoped Gateway semantic search.

## Options Considered

- Add model calls to Core MCP: simpler deployment, but violates the provider boundary.
- Leave only a smoke script: no stable callable contract or reusable validation.
- External bridge: one extra process, while preserving Core independence.

## Consequences

- Core and database remain provider-agnostic.
- Provider outages affect only text-query embedding, not FORGE persistence.
- The bridge profile configuration must exactly match the registered vector space.
- Deployments register a second MCP server when natural-language search is desired.
