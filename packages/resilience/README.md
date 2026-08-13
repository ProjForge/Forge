# FORGE Resilience 0.3

Creates authenticated encrypted recovery packages and restores them into an
empty PostgreSQL database without writing a plaintext dump to disk.

## Requirements

- Node.js 20+
- PostgreSQL client tools (`pg_dump` and `pg_restore`) from the source major or newer
- A PostgreSQL role that can read every object in the `forge` schema for backup
- A target role that can create the FORGE schema and required extensions for restore
- A passphrase of at least 20 bytes, preferably stored in a permission-restricted file

Set `FORGE_POSTGRES_BIN` when PostgreSQL tools are not on `PATH`.

Configure a distinct read-only role instead of reusing the application runtime
or a superuser:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-backup-role.ps1
```

The script grants only database connection, schema usage and selection from
current FORGE tables/sequences. Run it again after migrations add relations;
the backup preflight fails closed if any relation is missing.

## Backup

```powershell
$env:FORGE_DATABASE_URL = 'postgresql://forge_backup@127.0.0.1:5432/forge'
$env:FORGE_BACKUP_PASSPHRASE_FILE = 'D:\secrets\forge-backup.passphrase'
$env:FORGE_POSTGRES_BIN = 'C:\Program Files\PostgreSQL\18\bin'
node dist/cli.js backup --output 'E:\FORGE Backups'
```

The command returns JSON containing a `.forge-backup` payload and its
`.forge-backup.json` manifest. Store both files together.

## Verify

```powershell
node dist/cli.js verify --manifest 'E:\FORGE Backups\forge-....forge-backup.json'
```

Verification checks size, SHA-256 and AES-GCM authentication and decrypts the
entire stream to a discard sink. It does not touch PostgreSQL.

## Restore

Create a new empty database first. Restore never drops or cleans an existing one.

```powershell
$env:FORGE_RESTORE_DATABASE_URL = 'postgresql://forge_restore@127.0.0.1:5432/forge_recovered'
node dist/cli.js restore --manifest 'E:\FORGE Backups\forge-....forge-backup.json'
```

The payload is authenticated once before restore, then decrypted again directly
into `pg_restore --single-transaction`. Migration checksums and every FORGE table
count must match the consistent source snapshot before success is reported.

See [the resilience contract](../../docs/RESILIENCE.md) for current guarantees,
threat model and functionality that is deliberately not claimed yet.

## Native recovery drill

The integration drill creates two random temporary databases and a temporary
read-only backup role, proves that role cannot write, backs up the source,
restores the target, compares every table count and reads a sentinel project.
It then drops both databases and the role.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-native.ps1
```

The administrative password is requested interactively, held only for the
process lifetime and never written to disk or passed as a child-process argument.

## Scheduled verified policy

`run-policy` executes one complete recovery cycle:

1. acquire a local single-run lock;
2. create and authenticate the logical package;
3. publish payload then manifest to every filesystem or S3 replica and authenticate each copy;
4. apply retention only after every target succeeds;
5. atomically write sanitized status JSON.

```powershell
node dist/cli.js run-policy --config recovery-policy.example.json
```

Policy files contain no credentials. Paths must be absolute, replica names and
locations must be unique, and at least one replica is required. Existing targets
without a `type` remain filesystem targets. Unknown or malformed local files are
ignored by retention.

### Immutable S3 replica

Use an Object-Lock-enabled S3-compatible bucket. Credentials are resolved by the
AWS SDK credential chain (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional
session token, shared credentials or workload identity); never add them to the
policy file.

```json
{
  "name": "offsite-worm",
  "type": "s3",
  "bucket": "forge-recovery-prod",
  "prefix": "logical",
  "region": "eu-west-1",
  "objectLock": {
    "mode": "COMPLIANCE",
    "retentionDays": 30
  }
}
```

`endpoint` and `forcePathStyle` support compatible providers and loopback test
servers. Non-loopback endpoints must use HTTPS. Each run uploads the encrypted
payload first, uploads its manifest as the publication marker, downloads both
and performs full SHA-256 plus AES-GCM verification. FORGE does not delete cloud
objects: configure provider lifecycle to expire them only after Object Lock.

The optional [AWS reference deployment](../../deploy/aws/README.md) provisions
a private Object-Lock bucket and least-privilege identity without embedding an
access key in CloudFormation state.

Fetch a selected package back into a new local directory before restore:

```powershell
node dist/cli.js fetch-s3 `
  --config recovery-policy.json `
  --target offsite-worm `
  --object-manifest scheduled-2026-08-11T19-51-37-499Z.forge-backup.json `
  --output 'D:\FORGE Recovery\incoming'
```

Only a safe manifest file name is accepted. FORGE downloads the manifest and
its referenced payload, authenticates both, refuses existing destination files
and publishes the payload before its manifest. Use the returned local manifest
path with the normal `restore` command.

Windows operators can run the complete provider acceptance drill with the
installed DPAPI configuration. It downloads and authenticates the selected
package, restores it into a random isolated PostgreSQL database, verifies
migration checksums and table counts, and removes only that generated database
unless `-KeepDatabase` is supplied:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-s3-native.ps1 `
  -ObjectManifest 'scheduled-2026-08-11T22-24-36-576Z.forge-backup.json' `
  -OutputDirectory 'D:\FORGE Recovery' `
  -KeepDatabase
```

The PostgreSQL administrative password is requested invisibly and remains only
in the drill process environment. AWS credentials and the package passphrase
are decrypted from CurrentUser DPAPI only for the duration of the drill.

On Windows, build the package and register a limited CurrentUser task:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows-schedule.ps1 `
  -OutputDirectory 'D:\FORGE Backups\logical' `
  -ReplicaDirectory '\\backup-server\FORGE\logical'
```

The installer requests the dedicated backup-role password and package
passphrase interactively and stores each with CurrentUser DPAPI. The scheduled
task uses `IgnoreNew`, retries failures, runs missed cycles when possible and
never places a secret in its action arguments or JSON configuration.

After provisioning the AWS reference target, add it to an existing Windows
schedule without replacing its database or passphrase configuration:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-s3-windows.ps1 `
  -Bucket 'your-globally-unique-bucket-name' `
  -Region 'eu-west-1' `
  -Prefix 'logical'
```

The command requests the recovery identity's access key and secret invisibly,
protects both with CurrentUser DPAPI and atomically adds the S3 target to the
existing policy. The scheduled runner exposes the decrypted values only to its
process environment and removes them after each run. It fails closed if only
one credential file exists. Never paste either value into policy JSON, source,
logs or support conversations.

## Physical WAL/PITR drill

The isolated Windows drill creates a disposable PostgreSQL cluster, enables WAL
archiving, verifies a SHA-256 base-backup manifest, creates a named restore
point, applies later destructive changes and proves recovery excludes them:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-pitr-native.ps1
```

`archive-wal.ps1` rejects unsafe names and different-content collisions, copies
through a partial file and verifies SHA-256. `restore-wal.ps1` performs the
inverse verified copy. Production activation remains an explicit DBA operation
because it changes cluster-wide PostgreSQL settings and requires a replication
identity, retention capacity and an independently monitored archive target.

Before production activation on Windows, run the non-mutating readiness check:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/preflight-pitr-windows.ps1 `
  -ArchiveDirectory 'E:\FORGE PITR\wal' `
  -MinimumFreeGiB 20
```

It inspects the service command, effective WAL settings, independent-volume
capacity, required scripts and BitLocker state, then writes non-secret atomic
status to `%APPDATA%\FORGE\pitr-preflight.json`. It never edits PostgreSQL,
creates the archive directory or restarts the service. See the
[production activation plan](../../docs/PITR-PRODUCTION-PLAN.md).

## Encrypted physical packages (0.4)

Physical WAL segments and base-backup archives use a separate, cluster-bound
format. The manifest authenticates the PostgreSQL system identifier, timeline,
server version, artifact kind, original plaintext SHA-256 and encryption
parameters. Creation reads the source twice and fails if it changes between the
initial hash and encryption. Verification authenticates AES-256-GCM and hashes
the decrypted plaintext without publishing it.

```powershell
$env:FORGE_BACKUP_PASSPHRASE_FILE = 'C:\secure\physical-passphrase.txt'
forge-resilience physical-pack --kind wal --source 'E:\FORGE PITR\wal\000000010000000000000001' `
  --output 'E:\FORGE PITR\encrypted' --label 'wal-000000010000000000000001' `
  --system-identifier '7548123456789012345' --timeline 1 `
  --server-version '18.4' --server-version-number 180004
forge-resilience physical-verify --manifest 'E:\FORGE PITR\encrypted\wal-000000010000000000000001.forge-physical.json'
```

`physical-upload-s3` and `physical-fetch-s3` accept the existing recovery policy
and named S3 target. Production must use a distinct DPAPI-protected physical
passphrase; the plaintext-file example above is illustrative and is not the
Windows deployment contract. Upload verifies locally first, publishes payload
before manifest under Object Lock, re-downloads both and authenticates the
plaintext before reporting success.

On Windows, prepare the BitLocker-protected spool from an elevated terminal:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-pitr-spool-windows.ps1 `
  -Root 'E:\FORGE PITR' -MinimumFreeGiB 20
```

The setup uses invariant Windows SIDs. SYSTEM, Administrators and the installing
user control the PITR root; PostgreSQL's NetworkService identity receives
`Modify` only on `wal`. The command is idempotent and does not edit PostgreSQL.

Create a distinct physical passphrase only while trusted offline media is
connected:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/configure-physical-secret-windows.ps1 `
  -RecoveryDirectory 'G:\FORGE-Recovery-Keys'
```

The script generates 48 CSPRNG bytes, protects the operational copy with
CurrentUser DPAPI, verifies the offline copy and updates `SHA256SUMS.txt`. It
refuses to overwrite either copy. Disconnect the recovery media after copying
the passphrase into a separate trusted password manager.

`run-physical-uploader-windows.ps1` processes only strict PostgreSQL WAL file
names in bounded batches. It creates or reuses an authenticated physical
package, verifies it locally, uploads through the named immutable S3 target and
writes an atomic receipt only after provider re-download and authentication.
Replay is idempotent, and raw WAL is never deleted by the uploader. The
`-PackageOnly` mode exists for isolated acceptance tests and performs no network
operation.

`run-physical-basebackup-windows.ps1` creates one stable daily base package. It
uses `pg_basebackup` with streamed WAL and a fast checkpoint, requires a
SHA-256 backup manifest to pass `pg_verifybackup`, archives the verified tree,
encrypts it and follows the same authenticated S3 receipt contract. Successful
staging is removed; failed staging is preserved for diagnosis. A replay reuses
the verified package and never starts a second backup for the same label.

The native acceptance test uses a disposable PostgreSQL cluster and never
connects to the production database:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-physical-basebackup-windows.ps1
```
