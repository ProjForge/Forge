# Resilience 0.3 implementation findings

Date: 2026-08-11
Environment: PostgreSQL 18.4 on Windows, Node.js 20+

## RES-001: the runtime role is not a backup role

The first live backup correctly failed because the least-privilege application
role could not read every FORGE relation. Elevating it would have expanded the
runtime attack surface.

Resolution: add a distinct read-only backup role and a catalog-based preflight
that lists every inaccessible table or sequence and fails closed. The setup
script must be rerun after a migration adds relations.

## RES-002: rejected restores leaked a client connection

The non-empty-target regression exposed that a failure during restore preflight
did not close its PostgreSQL client. This could delay administrative cleanup and
accumulate idle connections after repeated rejected restores.

Resolution: close the client on every preflight failure. The native test now
creates a blocker relation, proves restore rejects it, proves the relation still
exists, removes it and only then performs the real restore.

## RES-003: logical recovery is not PITR

`pg_dump` recovery packages reconstruct FORGE at the time of the latest verified
backup. They cannot replay changes to an arbitrary instant.

Resolution: document logical recovery and PostgreSQL physical/WAL recovery as
separate layers. No point-in-time recovery claim is made by Resilience 0.2.

## RES-004: both sides of the streaming pipeline must settle

An encryption error could reject before the concurrently running `pg_dump`
process had terminated. Cleanup must not return while a producer may still hold
the exported snapshot or write to its pipe.

Resolution: an encryption failure terminates the child, and backup waits for
both encryption and `pg_dump` to settle before rolling back and removing partial
files.

## Native validation result

The automated drill passed on PostgreSQL 18.4:

- temporary read-only role could read but not write;
- consistent custom-format dump was encrypted without a plaintext archive;
- payload and authenticated manifest verification passed;
- restore refused a non-empty target without deleting its relation;
- empty-target restore completed in one transaction;
- migration checksums, every FORGE table count and a sentinel project matched;
- both temporary databases and the temporary role were removed.

The administrative password was requested interactively, held for the process
lifetime and was not stored in the repository, status file or test log.

## RES-005: Windows WAL hashing must allow PostgreSQL file sharing

The first physical drill archived one segment and then repeatedly failed because
`Get-FileHash` reopened later WAL files with sharing flags incompatible with the
running server, even though copying was permitted.

Resolution: hash WAL through a read-only .NET stream that explicitly allows
`FileShare.ReadWrite` and `FileShare.Delete`. Source and copied bytes remain
SHA-256 compared without requiring PostgreSQL to release the segment first.

## RES-006: server readiness is not recovery completion

`pg_ctl -w start` returned as soon as the recovery cluster accepted read-only
connections. The initial test could observe base-backup data before WAL replay
reached the named target and promotion completed.

Resolution: poll `pg_is_in_recovery()` until false, then validate recovered
application rows. The final PostgreSQL 18.4 drill verified the base-backup
manifest, archived required WAL, recovered to `forge_safe_point`, preserved the
safe row, excluded both later mutations and removed the temporary clusters.

## RES-007: scheduled-task scripts must target Windows PowerShell 5.1

The first schedule installation used `.NET Path.IsPathFullyQualified`, available
to PowerShell 7 but absent from Windows PowerShell 5.1, which is the stable
in-box runtime used by the registered task.

Resolution: validate absolute Windows paths with `Path.IsPathRooted`, parse every
script with the Windows PowerShell grammar and keep the scheduled action pinned
to the in-box executable rather than depending on a user's `pwsh` installation.

## RES-008: Windows PowerShell 5.1 emits a UTF-8 BOM

The first real scheduled run reached Node but failed before policy status because
Windows PowerShell 5.1 wrote `resilience-policy.json` with a leading UTF-8 BOM,
which raw `JSON.parse` rejects.

Resolution: the CLI removes exactly one leading Unicode BOM before strict JSON
parsing. Other leading garbage and malformed JSON still fail closed.

## RES-009: object stores do not provide filesystem rename semantics

An S3 upload cannot reproduce the local partial-file plus atomic-rename
publication sequence. Treating two successful `PUT` responses as a verified
backup would also leave transport or provider corruption undetected.

Resolution: upload the encrypted payload first and its manifest last as the
publication marker, then download both into an isolated temporary directory and
run the normal SHA-256 and AES-GCM verifier. A policy failure prevents every
retention pass. A payload orphaned before manifest publication is safe and may
remain WORM-protected until provider lifecycle removes it.

## RES-010: application retention must not weaken Object Lock

Deleting expired cloud packages from the same runtime would require delete
permissions and creates pressure to grant Object Lock bypass capability.

Resolution: FORGE requires a positive Object Lock policy on every S3 target and
never deletes cloud objects. Provider lifecycle owns deletion after retention
expires. Backup credentials should receive only the object operations required
for upload and verification, without governance-bypass permission.

## RES-011: typed targets must preserve version-1 filesystem policies

Making `type` mandatory on every target compiled the new S3 design but broke the
existing native test and would have rejected installed policy objects created by
older code.

Resolution: absence of `type` continues to mean `filesystem`; parsed policies
are normalized to the explicit value. Existing JSON, programmatic callers and
the installed Windows task remain compatible.

## RES-012: Object Lock uploads require an integrity header

Object-Lock-enabled S3 uploads require a supported content checksum. Relying on
SDK defaults would make compatibility dependent on a specific SDK version or
provider behavior.

Resolution: calculate SHA-256 for both payload and manifest and send explicit
`ChecksumAlgorithm: SHA256` plus the base64 checksum. The SDK integration test
observes both Object Lock and checksum headers on the real HTTP requests.

## RES-013: replica failure must not release the policy lock early

`Promise.all` reports the first rejected target immediately while other replica
operations continue. With a slower network target, the policy could write error
status and release its single-run lock while another upload was still active.

Resolution: settle every concurrent replica operation before propagating the
first failure. Retention still does not run after any failure, and a regression
test proves a slow successful replica finishes before the policy reports a
simultaneous failed target.

## RES-014: off-site backup without a native fetch path is incomplete

The first S3 slice could upload and verify remote objects, but disaster recovery
would still depend on a provider CLI and manual pairing of payload and manifest.

Resolution: add `fetch-s3`. It accepts only a safe manifest file name beneath the
configured prefix, follows the parsed manifest to the payload, downloads both
through the same SDK adapter, authenticates them, refuses overwrites and
publishes payload before manifest for subsequent normal restore.
