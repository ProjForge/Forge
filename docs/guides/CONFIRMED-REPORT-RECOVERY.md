# Confirmed report recovery (isolated opt-in pilot)

Keep all writers stopped. Use only the intended isolated Core/control databases,
with their existing limited runtime/state roles. Do not activate a service.

Before loss, with FORGE_COORDINATOR_REPORT_ROOT set to the existing receiver,
run the built CLI and save a UTF-8 proof file outside that receiver. This works
in Windows PowerShell 5.1 and PowerShell 7; capture requires no database:

~~~powershell
$proofFile = Join-Path $PWD 'report target.json'
node packages/coordinator/dist/cli.js capture-report-target $proofFile
if ($LASTEXITCODE -ne 0) { throw 'Report target capture failed' }
~~~

The JSON contains canonicalPath, dev and ino as captured by Node, using exactly
the fingerprint inputs of the original publisher (Windows path is lowercased
when hashed). Keep this trusted metadata with the consistent Core/control and
report-byte backup. A pre-loss manifest with exactly these fields is also valid.
Do not invent metadata after loss or derive it from the replacement directory.

Restore the consistent database checkpoints and report bytes separately. Create
a trusted, quiescent replacement at the same canonical local path. It must have
a distinct physical identity, contain the exact original report file and have no
symlink/junction receiver or symlink report. The command performs verification
only; it does not create directories or restore files.

With FORGE_DATABASE_URL and FORGE_COORDINATOR_DATABASE_URL already supplied by
the isolated launcher and the report root set, invoke exactly one task from
Windows PowerShell 5.1 or PowerShell 7 using the proof FILE path:

~~~powershell
node packages/coordinator/dist/cli.js recover-report project-key task-key $proofFile
if ($LASTEXITCODE -ne 0) { throw 'Report recovery failed; inspect the backup and checkpoint' }
~~~

The capture command creates the proof file exclusively (wx), never overwrites it,
and writes UTF-8 without BOM. Recovery also accepts UTF-8 with BOM (including
PowerShell 5.1 Set-Content -Encoding UTF8 output). Do not pass raw JSON as argv
or use PowerShell 5.1 > redirection, which writes UTF-16.

No model configuration is required. The command accepts no watch mode. Inspect
status for the same project/task afterward. completed means reconciliation passed;
idle means nothing eligible was claimed (including completed replay or an active
lease), not proof that recovery succeeded. failed exits 1; missing receipts, wrong proof/path or incompatible configuration
also exit 1. Missing prepared output or receipt refuses explicitly. Invalid proof,
missing/corrupt report or invalid prepared bytes fail before claim, leaving the
entire row (including attempts and epoch) unchanged. Verification repeats inside
the existing lease fence; failures after claim retain normal bounded retry rules.
An ineligible row (for example exhausted attempts) can return idle without changing
anything. The original receipt and target remain immutable. Do not reset retries
or edit SQL checkpoints. Normal enqueue/worker entry points retain physical
target pinning and cannot claim this old task on the replacement.

The native -JointRestore acceptance uses only disposable PostgreSQL and synthetic
provider output. It removes the full original receiver, holds its emptied inode
until replacement creation to prevent reuse, removes the old directory, restores
saved bytes and exercises real one-shot CLI recovery, concurrent callers and replay.
See ADR-012 for scope and assumptions.
