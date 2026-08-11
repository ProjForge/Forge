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
