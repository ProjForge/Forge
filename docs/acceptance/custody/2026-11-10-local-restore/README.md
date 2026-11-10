# Local restore under the separate custodian account

The 2026-11-10 rehearsal restored Core and the coordinator from an encrypted
generation in an offline Windows Sandbox with PostgreSQL 18.4 and Node 22.23.4.
Two standard Windows accounts ran the three processes recorded as `init`,
`capture` and `restore`. The custodian ran `init` and `restore` under the
same SID. The trusted SYSTEM supervisor prepared the disposable guest.

The capture account ran two `pg_dump` commands through the backup role and
wrapped the encryption key with the custodian's public key. Windows returned
error 5 when the capture account tried to open the private key or move it or
its directory. The capture account removed the source cluster and plaintext
inputs before the custodian started.

The custodian authenticated the four components under its private temporary
directory before creating a fresh loopback cluster. Invalid keys, a missing
wrapped key and modified ciphertext were rejected before provisioning. Both
transactional `pg_restore` commands exited 0 and the limited role checks passed.

Row counts and hashes matched across seven seeded tables before reconciliation,
including the pgvector embedding. The post-cut marker was absent. The report
verifier checked the restored bytes against the original receipt. The coordinator
returned `completed` and then `idle`, with one reconciliation, zero agent calls,
one execution and one result memory. The fixture used a synthetic handler.

All three native processes and their Node children exited 0. Both clusters
were removed, the temporary accounts were deleted and the Sandbox was closed.
The rehearsal covered synthetic data on one machine. Remote restoration remains
pending until a second preproduction machine is available.

## Evidence and provenance

The rehearsal ran from `42031db73e38320889a04d9026af044dcbb03eee`. That
commit and the integrated `main` commit
`e541c669d5230f41ff8517526365461f9ccea22e` resolve to tree
`7b0aede1002e5689535bcf5d75501ef03c0430f1`.

The JSON files retain the reviewed bytes. The input inventory lists filenames
and hashes from the rehearsal. Additional records are in the local
`.run/evidence/custody-full-restore/`. The harness is in the test worktree.

| Artifact | SHA-256 |
| --- | --- |
| [result.json](result.json) | `4cd08f5ad40fc5f2fa8ff193f6a25ce6c1cd1f1c375990623f70264b64112d69` |
| [build.json](build.json) | `b262e31913de064ef392c058a7a9c28253ddd5881d17fec1854651aa0822fdf2` |
| [guest-exit.json](guest-exit.json) | `0cec79bdabd108dc8f671ea11f65e0db39b7521a87c78cc337ba9cdfa7e42fe6` |
| [cleanup.json](cleanup.json) | `f9c25577dd1000771e0c77b1cce5568038f9532e8b932066e6b3cb298ea8aacb` |
| [sandbox-after.json](sandbox-after.json) | `90255a0b24d45da9c2280c4628d0e08d80902949213f5f5f76d7f282b678a6bb` |
| [input-hashes.json](input-hashes.json) | `de17d51ffbc19792bd8a3e74014a785a48e8f749bd4cd63fd16dca4b15ef3968` |
