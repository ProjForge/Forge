# Release process

FORGE is currently published as a prerelease. Release artifacts must be built
from a clean tagged commit.

## Pre-release checklist

- [ ] CI passes on Linux and Windows.
- [ ] `npm run check` passes from a clean install.
- [ ] `npm run audit:production` reports no known production vulnerabilities.
- [ ] Native PostgreSQL migration and runtime-role tests pass.
- [ ] Workbench installer, DPAPI round-trip, custom port and uninstaller pass.
- [ ] No credentials, DPAPI blobs, generated logs or local paths are tracked.
- [ ] Source and Windows artifact SHA-256 manifests match.
- [ ] Third-party license notices are included with binary distributions.
- [ ] Release notes describe compatibility, known limitations and rollback.
- [ ] Windows binaries are signed, or the release is explicitly marked unsigned.

## Rollback triggers

- Schema checksum mismatch or failed transactional migration.
- Cross-project data visibility.
- Managed identity, optimistic locking or append-only invariant regression.
- Workbench binding outside loopback.
- Credential exposure in process output, browser state or release artifacts.

Rollback means withdrawing the affected prerelease artifact and restoring the
last validated version. Applied database migrations are never reverted with
destructive ad-hoc SQL; publish a forward corrective migration instead.
