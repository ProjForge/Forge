# ADR-007: Combine filesystem and immutable S3 recovery targets

**Status:** Accepted
**Date:** 2026-08-11
**Deciders:** FORGE maintainers

## Context

The installed filesystem replica provides fast recovery from primary-disk loss,
but remains inside the same computer. A cloud-only design would cover location
loss while increasing recovery latency and dependence on an account, provider
and network connection. FORGE needs both properties without coupling recovery
packages to one vendor.

## Decision

Recovery policies support two target types:

- `filesystem` for removable disks, mounted volumes and network shares;
- `s3` for off-site S3-compatible object stores with Object Lock.

S3 credentials are resolved outside policy JSON through the standard SDK
credential chain. The adapter uploads the encrypted payload before its manifest,
downloads both objects again and authenticates the complete package before the
policy can apply any local retention. Object Lock is mandatory for S3 targets.
Cloud expiry and deletion remain provider lifecycle operations after the lock
period; FORGE never attempts to bypass or shorten WORM retention.

## Options Considered

| Option | Complexity | Recovery speed | Site-loss protection | Vendor coupling |
|---|---:|---:|---:|---:|
| Filesystem only | Low | High | Deployment-dependent | None |
| Cloud only | Medium | Network-dependent | High | Medium |
| Filesystem plus S3-compatible | Medium | High locally | High | Low |

## Trade-off Analysis

The combined design adds an SDK and cloud configuration, but preserves the
existing fast local path and creates an independent off-site path. A generic S3
contract avoids one adapter per provider; required Object Lock intentionally
excludes partially compatible services that cannot enforce immutability.

## Consequences

- A deployment can survive both local disk failure and total machine loss.
- Client-side encryption keeps providers outside the plaintext trust boundary.
- A successful policy run proves remote bytes were downloaded and authenticated,
  rather than trusting upload acknowledgement alone.
- Operators must create an Object-Lock-enabled bucket, configure lifecycle and
  supply least-privilege credentials through the runtime environment.
- A local S3 endpoint is useful for compatibility tests but is not evidence of
  off-site durability.

## Action Items

1. Implement and unit-test the generic S3 adapter. — Complete
2. Validate against an Object-Lock-compatible S3 endpoint. — Pending deployment
3. Configure a real off-site bucket and run a restore drill from it. — Pending
