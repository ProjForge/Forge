# Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

## Scope

This policy applies to official FORGE Windows executables published by the
`ProjForge/Forge` repository. A valid signature links a released binary to the
reviewed source and automated build that produced it. Source archives and
checksums remain unsigned release evidence and are distributed alongside the
binary.

## Team roles

- Committer and reviewer: [BlinkStreamTeam](https://github.com/BlinkStreamTeam),
  the current public maintainer and ProjForge organization owner.
- Signing approver: [BlinkStreamTeam](https://github.com/BlinkStreamTeam).

Changes from other contributors require maintainer review before merge.
Signing is a separate manual approval after all release gates pass.

## Release controls

1. Changes reach protected `main` through a pull request with required CI.
2. Linux, Windows, PostgreSQL 14 restart/continuity and clean-Windows bootstrap
   gates must pass on the exact source revision.
3. The build performs a clean dependency restore, tests production dependencies,
   emits third-party notices and stamps verified FORGE product metadata before
   requesting a signature.
4. SignPath must obtain the binary through the configured build integration;
   maintainers do not upload an arbitrary local replacement.
5. Every signing request requires explicit approval. The resulting signature,
   timestamp, source revision and SHA-256 manifests are verified before the
   GitHub prerelease is published.

Signing keys are generated and retained by the signing provider's hardware
security module. FORGE source, GitHub secrets and release artifacts never
contain a private signing key.

## Verification

Users can verify an extracted executable with PowerShell:

```powershell
Get-AuthenticodeSignature .\FORGE-Workbench.exe | Format-List Status,SignerCertificate,TimeStamperCertificate
Get-FileHash .\FORGE-Workbench.exe -Algorithm SHA256
```

`Status` must be `Valid`, the signer must chain to the SignPath Foundation
certificate, and the archive hash must match the release `SHA256SUMS.txt`.

## Privacy

See the [FORGE privacy policy](../PRIVACY.md). FORGE does not send telemetry or
personal data to SignPath. The signing service processes build artifacts and
repository metadata only as part of an explicitly approved release request.
