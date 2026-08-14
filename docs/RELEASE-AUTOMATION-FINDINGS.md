# Release automation implementation findings

Date: 2026-08-14
Scope: Windows release assembly and verification

| Finding | Result |
| --- | --- |
| DIST-006 — Source and Windows archives, outer hashes and final verification required separate manual commands | Fixed: `Build-FORGE-WindowsRelease.ps1` now assembles both archives and fails closed through one verifier. |
| DIST-007 — A package could be built from a lightweight, version-mismatched or wrong-commit tag | Fixed: official builds require an annotated `v<package-version>` tag resolving exactly to `HEAD`. |
| DIST-008 — The installed `npm.cmd` wrapper can resolve its CLI through a missing user-global prefix | Fixed: Windows packaging invokes the npm CLI adjacent to the active `node.exe`, with `npm.cmd` only as a compatibility fallback. |
| DIST-009 — Manual release evidence did not prove complete internal checksum coverage or signing provenance | Fixed: verification checks every packaged file, both outer archives, PE identity, clean commit metadata and Authenticode/timestamp state, then emits sanitized JSON evidence. |
| DIST-010 — Automating artifacts could accidentally automate publication | Prevented: the workflow has read-only repository contents permission, uploads only a retained workflow artifact and provenance attestations, and never creates a GitHub Release. |
| DIST-011 — Array splatting passed named child-script parameters positionally, turning `-OutputRoot` into a path and the real path into a certificate thumbprint | Fixed: child PowerShell scripts now receive hashtable-splatted named parameters; the regression rejects array splatting at both boundaries. |
| DIST-012 — Inline PowerShell expressions split `git archive --prefix=` and made Git parse the archive root as a revision | Fixed: output and prefix are built as atomic Git arguments; the regression requires both explicit argument variables. |

The workflow intentionally remains unsigned until the SignPath integration is
approved. Signing must occur before the package manifests and archives are
finalized; the final pass will use `-RequireSigned` and reject a missing or
untimestamped signature.
