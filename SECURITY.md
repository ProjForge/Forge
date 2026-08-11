# Security policy

## Supported versions

FORGE is pre-1.0. Security fixes are applied to the latest release candidate.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting for this repository and include:

- affected component and version;
- reproduction steps or proof of concept;
- expected impact;
- any suggested mitigation.

Please avoid accessing data that is not yours and allow maintainers reasonable
time to investigate before disclosure. Receipt will normally be acknowledged
within seven days. A remediation timeline depends on severity and reproducibility.

## Security boundaries

- Workbench 0.1.x is a local, single-user tool and must remain loopback-only.
- Secrets must never be committed or placed in browser state.
- PostgreSQL runtime roles should use least privilege.
- Embedding and reranking providers are external trust boundaries.
