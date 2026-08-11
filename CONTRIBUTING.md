# Contributing to FORGE

Thank you for helping improve FORGE. The project values correctness, explicit
boundaries and small changes backed by evidence.

## Development setup

```bash
npm install
npm run build
npm test
```

Node.js 20+ and npm 10+ are required. Native PostgreSQL and model-provider tests
are opt-in and documented in the relevant package.

## Pull requests

1. Open or reference an issue for architectural or behavior-changing work.
2. Keep changes focused and preserve project scoping, optimistic locking,
   append-only history and provider independence.
3. Add regression tests for bugs and behavior tests for features.
4. Update documentation when contracts or operational steps change.
5. Never commit credentials, DPAPI blobs, generated binaries or local datasets.

Commit messages should be short, imperative summaries. Pull requests should
explain what changed, why, user/developer impact and the validation performed.

## Architecture decisions

Durable boundary changes require an ADR under `docs/decisions`. Use the existing
records as the template and record context, decision and consequences.
