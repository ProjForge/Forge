# FORGE Resilience 0.2

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
3. publish payload then manifest to every replica and authenticate each copy;
4. apply retention only after every target succeeds;
5. atomically write sanitized status JSON.

```powershell
node dist/cli.js run-policy --config recovery-policy.example.json
```

Policy files contain no credentials. Paths must be absolute, replica names and
paths must be unique, and at least one replica is required. Unknown or malformed
files are ignored by retention.

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
