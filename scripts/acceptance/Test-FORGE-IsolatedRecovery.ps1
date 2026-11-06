[CmdletBinding()]
param([string]$PostgresBin='C:\Program Files\PostgreSQL\18\bin', [ValidateRange(1024,65535)][int]$Port=55439)
$ErrorActionPreference='Stop'
$workspace = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$runRoot = [IO.Path]::GetFullPath((Join-Path $workspace '.run'))
$root = [IO.Path]::GetFullPath((Join-Path $runRoot ('recovery-drill-'+[Guid]::NewGuid().ToString('N'))))
if (-not $root.StartsWith($runRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe drill root.' }
$started=$false
try {
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $data=Join-Path $root 'data'
    & (Join-Path $PostgresBin 'initdb.exe') -D $data -U forge_drill -A trust --locale=C --encoding=UTF8 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Disposable cluster initialization failed.' }
    # A direct native invocation avoids a pipeline held open by the postmaster.
    & (Join-Path $PostgresBin 'pg_ctl.exe') -D $data -l (Join-Path $root 'postgres.log') -o "-h 127.0.0.1 -p $Port" -w start
    if ($LASTEXITCODE -ne 0) { throw 'Disposable PostgreSQL startup failed.' }
    $started=$true
    $env:FORGE_TEST_ADMIN_DATABASE_URL="postgresql://forge_drill@127.0.0.1:$Port/postgres"
    $env:FORGE_POSTGRES_BIN=$PostgresBin
    Push-Location (Join-Path $workspace 'packages\resilience')
    try {
        & (Get-Command node.exe).Source --test .test-dist/tests/integration/native-recovery.test.js
        if ($LASTEXITCODE -ne 0) { throw 'Native isolated restore failed.' }
    } finally { Pop-Location }
    @{status='PASS';scope='synthetic isolated logical restore; not production-chain PITR';checkedAt=[datetime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runRoot 'isolated-recovery-result.json') -Encoding utf8
} finally {
    Remove-Item Env:FORGE_TEST_ADMIN_DATABASE_URL,Env:FORGE_POSTGRES_BIN -ErrorAction SilentlyContinue
    if ($started) {
        & (Join-Path $PostgresBin 'pg_ctl.exe') -D (Join-Path $root 'data') -m fast -w stop | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Disposable PostgreSQL did not stop; retained its files for inspection.' }
    }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
