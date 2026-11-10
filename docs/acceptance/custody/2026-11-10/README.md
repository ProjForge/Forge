# Separate-account custody acceptance

Validated on 2026-11-10 in a disposable network-disabled Windows Sandbox with
Node 22.23.4. The trusted SYSTEM controller prepared the fixture.

The three roles used two distinct effective standard-account SIDs.
The custodian ran init and restore. The capture account ran capture.
Neither token held administrator, Backup Operators or backup/restore/take-ownership
privileges. Init generated the synthetic RSA private key with custodian-only
ownership and ACLs. Capture received its public key and held a transient AES key
while sealing four synthetic components with the existing Forge runtime.

Private-key read/write access and moves of the key and its directory failed with
Win32 error 5. Positive control read and move operations succeeded. Capture could
not overwrite the custodian result. SYSTEM controlled the parent and input roots.
TEMP paths and plaintext materializations were custodian-only.

Restore decrypted and verified four exact synthetic files after removal of the
originals. Wrong RSA, missing wrapped record, wrong AES and tampered ciphertext
were rejected before the restore callback. Restore in this JSON means synthetic
file decryption. No PostgreSQL restoration was executed in this rehearsal.

All three native processes and their Node children exited 0. Guest exit was 0.
Temporary accounts and tasks were removed. The owned Sandbox was closed and its
final environment list was empty. The guest audit recorded zero default routes.

Remote restoration remains PENDING until a second preproduction machine is
available. Earlier RPO/RTO figures belong to rehearsal #70. This custody rehearsal
adds no RPO/RTO measurements or production recovery guarantee.

## Runtime provenance

Source commit `3c9d10b9d8422c72b511318adf7d4b59751f4e62` used runtime tree
`59fdb02be7b5394ba9285ead267231e64114378b`, equivalent to merged main
`c30877d9b9b1a0b42bcbbf7f6aad524d788ce4d9`.
Both Git commits resolve to this tree. The result records the source commit
and Node version. The evidence was reviewed again for this publication.

## Published artifacts

These are byte-for-byte copies of the reviewed sanitized local evidence.
The optional local trace is `.run/evidence/custody-separate-account/`.
The five JSON files below form the public record. Git attributes in this directory
preserve their bytes across checkouts. The input inventory records the names and
hashes of the files used in the rehearsal. The harness remains in the local trace.

| Artifact | SHA-256 |
| --- | --- |
| [result.json](result.json) | 9a4a153f91ea42746fe117d88d0e8acea4312eef0da6646cb757534a27fd7599 |
| [guest-audit.json](guest-audit.json) | bf7dab56c05d1efb74e45f4fc2e16546eb45cbfd7464f51b07a6f4ca397a1952 |
| [guest-exit.json](guest-exit.json) | 0cec79bdabd108dc8f671ea11f65e0db39b7521a87c78cc337ba9cdfa7e42fe6 |
| [sandbox-closed.json](sandbox-closed.json) | 90255a0b24d45da9c2280c4628d0e08d80902949213f5f5f76d7f282b678a6bb |
| [input-hashes.json](input-hashes.json) | 3734f3d05f88ddf85918d13ac530fc156e0f3f268af0fcf983143a5b857b10b7 |
