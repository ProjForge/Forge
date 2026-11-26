# Forge RC 6 diagnostics export in Windows Sandbox

On 2026-11-26, the rebuilt Windows x64 candidate retained version
`0.2.0-rc.6` and was assembled from clean source commit
`a0b85f1e829da7f1cd39595ec5b8fb15704b2af4`. The local ZIP is unsigned.
Its SHA-256 is `459FA992870CEDF796B2E9686E5D0CA30A7F34C784161E3E5D3CA73D22149CFE`.
The release verifier checked 22 internal files. The earlier candidate had
SHA-256 `03EC83CA1AD12B94AFFFC082AC5502BCD83609C1580874D5C248733E897EA515`.
The results below apply to the rebuilt ZIP.

## Export from the installed candidate

The host and guest verified the candidate digest. The WinForms wizard ran in
interactive session 1 under the standard account. It rejected an unavailable
loopback endpoint and a role with incomplete grants before installing with the
valid role. PostgreSQL ran on guest loopback with disposable data. Networking
was disabled. The installed exporter and executable matched the ZIP members.

Run the installed `Export-FORGE-Diagnostics.ps1` with Windows PowerShell 5.1,
`-NoProfile -NonInteractive -File` and an explicit output path. The guest
reported `es-ES` and no localized Archive resource directories. Exit code was
0, with one output path and no stderr records. A separate clean process
verified that `Microsoft.PowerShell.Archive` was absent both before and after
calling the installed exporter. The first Sandbox launch had no interactive
logon. It closed before a fresh instance ran the acceptance successfully.

## Privacy and regression

The archive contained precisely `README.txt` and `diagnostics.json`.
The test checked the JSON field allowlist and scanned both entries for the
fixture password, DPAPI bytes in Base64 and hex, DSN, database and Windows
identities, paths, and canaries in the project, logs, bootstrap, indexing and
WAL inputs. Release metadata, credential presence, stale indexing and WAL
count and dates remained visible. The database, configuration and DPAPI
credential were identical before and after export. Only sanitized evidence
left the guest. The fixture had no registered Forge scheduled tasks or
PostgreSQL Windows services.

The PowerShell regression disables archive-module autoload, tests the exact
entries and encodings, checks replacement with `-Force` on a writable
destination and verifies byte preservation when the destination is locked.
On Windows, `File.Replace` requires a writable destination. The regression
does not simulate a late native filesystem failure during replacement.
`npm run check` also passed locally with Node 22 in the isolated build clone.
An earlier Node 24 run was stopped after an unrelated gateway admission test
failed. The admission test passed individually with Node 22.

All 15 guest checks passed. The standard-account process and host runner
exited 0, and the owned Sandbox closed. Remote restoration remains pending.

[Package verification](release-verification.json) ·
[Guest results](sandbox-result.json) · [Session and evidence digests](sandbox-session.json).
