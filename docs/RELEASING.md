# Release process

FORGE is currently published as a prerelease. Release artifacts must be built
from a clean tagged commit.

## Artifact assembly

For an untagged local candidate, run from a clean worktree:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\Build-FORGE-WindowsRelease.ps1
```

For an official release, create an annotated `v<package-version>` tag and bind
the build to it:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\Build-FORGE-WindowsRelease.ps1 -ExpectedTag v0.2.0-rc.4
```

The builder fails on dirty source, lightweight or mismatched tags, checksum
coverage gaps, incorrect PE identity, inconsistent provenance, or an invalid
signature state. It creates the source archive, Windows archive, internal and
outer SHA-256 manifests, and `release-verification.json`.

`.github/workflows/release-artifacts.yml` performs the same assembly on Windows
for tag pushes and manual dispatches, adds GitHub build provenance attestations,
and retains the verified bundle as a workflow artifact. It deliberately does
not create or modify a GitHub Release; public publication remains a separate
human approval.

The future signing integration must sign the executable before manifests and
archives are finalized, then run the verifier with `-RequireSigned`. A signed
result is accepted only when Authenticode is valid, an RFC 3161 timestamp is
present, every internal file is covered, and all outer hashes match. See
[`RELEASE-AUTOMATION-FINDINGS.md`](RELEASE-AUTOMATION-FINDINGS.md) for the
implementation findings and accepted boundary.

## Pre-release checklist

- [ ] CI passes on Linux and Windows.
- [ ] `npm run check` passes from a clean install.
- [ ] `npm run audit:production` reports no known production vulnerabilities.
- [ ] Native PostgreSQL migration and runtime-role tests pass.
- [ ] PostgreSQL 14 compatibility CI passes for schema restart, Gateway and MCP continuity.
- [ ] Every required row in `docs/CORE-COMPLETE-GATE.md` is PASS or explicitly accepted PASS WITH LIMIT.
- [ ] Workbench installer, DPAPI round-trip, custom port and uninstaller pass.
- [ ] Workbench update preserves configuration/DPAPI, rejects downgrade and survives a pre-publication swap failure.
- [ ] The allowlist diagnostics fixture proves connection identities, paths and secret sentinels are absent.
- [ ] No credentials, DPAPI blobs, generated logs or local paths are tracked.
- [ ] Source and Windows artifact SHA-256 manifests match.
- [ ] `release-verification.json` records the exact clean source commit.
- [ ] GitHub provenance attestations exist for both published archives.
- [ ] Third-party license notices are included with binary distributions.
- [ ] Release notes describe compatibility, known limitations and rollback.
- [ ] Windows binaries are signed, or the release is explicitly marked unsigned.
- [ ] Tester instructions identify prerequisites, smoke flows and safe feedback content.

## Rollback triggers

- Schema checksum mismatch or failed transactional migration.
- Cross-project data visibility.
- Managed identity, optimistic locking or append-only invariant regression.
- Workbench binding outside loopback.
- Credential exposure in process output, browser state or release artifacts.
- Mixed-version application files or loss of preserved configuration during update.

Rollback means withdrawing the affected prerelease artifact and restoring the
last validated version. Applied database migrations are never reverted with
destructive ad-hoc SQL; publish a forward corrective migration instead.
