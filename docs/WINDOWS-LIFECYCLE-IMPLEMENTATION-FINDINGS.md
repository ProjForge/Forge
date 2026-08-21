# Windows lifecycle implementation findings

Date: 2026-08-21  
Status: implementation candidate for the next release candidate

## DIST-014 — Direct overwrite was not an update transaction

The Workbench installer copied new files directly over the active installation.
An interrupted copy could leave mixed-version assets. The installer now stages
the complete verified package beside the destination, stops only the matching
Workbench process, swaps directories and restores the previous directory if a
later installation step fails.

## DIST-015 — Updates unnecessarily rotated DPAPI material

The previous installer always requested the runtime password and rewrote shared
configuration. A normal update now preserves both files byte-for-byte. Connection
changes require explicit `-Reconfigure`; accidental parameter drift fails closed.

## DIST-016 — Installed version provenance was absent

`RELEASE.json` was generated in the archive but not copied into the installed
application. The complete verified package is now installed, which makes the
source commit, version and signing state locally inspectable. Older-version
packages are rejected unless the operator explicitly allows a downgrade.

## DIST-017 — Tester evidence needed a safe generation boundary

Asking users to redact arbitrary logs is not a reliable privacy control.
`Export-FORGE-Diagnostics.ps1` builds a new document from an explicit allowlist:
platform/release identity, boolean configuration health, bounded bootstrap
state, PostgreSQL service state and FORGE task results. It never reads raw logs
or emits connection identities, configuration hashes, paths, usernames,
hostnames, credentials, DPAPI blobs or database content.
Allowed fields also constrain untrusted values: versions and commits must match
their canonical formats, bootstrap state uses known enums, and only exact FORGE
task identities are inspected.

## DIST-018 — Rollback cleanup needed publication-aware state

The first transactional implementation tracked whether the previous directory
had moved, but not whether the replacement had been published. A rename failure
before publication could therefore make broad catch cleanup target the previous
directory. Separate `moved` and `published` flags now ensure cleanup removes only
new artifacts created by the transaction; previous application/configuration
files are restored only from explicit sibling backups. Broad and reparse-point
managed paths are rejected before mutation.

## DIST-019 — Upgrade evidence must start from the published predecessor

Two locally generated fixtures cannot prove compatibility with an already
published package. The release gate now downloads the public rc.2 Workbench ZIP,
requires its pinned SHA-256
`F8517E7A86DE6F8892DD23401ADBC594837862E6EDB5732372622A7462B4D0BB`, installs
it in an isolated user-scoped root, applies the candidate and proves
configuration/DPAPI preservation, safe diagnostics and data-preserving
uninstall. The first rc.2-to-rc.3 candidate execution passed on 2026-08-21.
