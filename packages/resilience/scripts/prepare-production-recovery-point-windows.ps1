[CmdletBinding()]
param(
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [string]$PitrRoot = 'E:\FORGE PITR',
    [Security.SecureString]$AdminPassword
)

$ErrorActionPreference = 'Stop'
$runtime = Get-Content -LiteralPath (Join-Path $ConfigRoot 'resilience-runtime.json') -Raw | ConvertFrom-Json
$physical = Get-Content -LiteralPath (Join-Path $ConfigRoot 'pitr-runtime.json') -Raw | ConvertFrom-Json
$psql = Join-Path ([string]$physical.postgresBin) 'psql.exe'
$uploader = Join-Path $PSScriptRoot 'run-physical-uploader-windows.ps1'
$recordPath = Join-Path $ConfigRoot 'production-recovery-point.json'
$statusPath = Join-Path $ConfigRoot 'production-recovery-point-status.json'
$adminPointer = [IntPtr]::Zero
$adminPlain = $null

function Write-AtomicJson([string]$Path,[object]$Value) {
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try { $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding utf8; Move-Item -LiteralPath $temporary -Destination $Path -Force }
    finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}
function Invoke-AdminSql([string]$Sql,[switch]$Scalar,[string]$Database='postgres') {
    $arguments = @('-X','-w','-v','ON_ERROR_STOP=1','-h',[string]$physical.replication.host,'-p',[string]$physical.replication.port,'-U','postgres','-d',$Database)
    if ($Scalar) { $arguments += @('-A','-t') }
    $output = $Sql | & $psql @arguments -f - 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Administrative PostgreSQL command failed: $($output -join ' ')" }
    if ($Scalar) { return (($output | Out-String).Trim()) }
    return $output
}

try {
    if (-not $AdminPassword) { $AdminPassword = Read-Host "Password for PostgreSQL administrator 'postgres'" -AsSecureString }
    $adminPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($AdminPassword)
    $adminPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($adminPointer)
    $env:PGPASSWORD = $adminPlain
    $name = 'forge_production_acceptance_' + (Get-Date).ToUniversalTime().ToString('yyyyMMdd_HHmmss')
    $counts = Invoke-AdminSql "SELECT json_build_object('projects',(SELECT count(*) FROM forge.projects),'memories',(SELECT count(*) FROM forge.memories))::text;" -Scalar -Database ([string]$runtime.database.name) | ConvertFrom-Json
    Invoke-AdminSql "SELECT pg_create_restore_point('$name');" -Database ([string]$runtime.database.name) | Out-Null
    $wal = Invoke-AdminSql 'SELECT pg_walfile_name(pg_switch_wal());' -Scalar -Database ([string]$runtime.database.name)
    if ($wal -notmatch '^[0-9A-F]{24}$') { throw "PostgreSQL returned an unsafe WAL name: $wal" }

    $walPath = Join-Path (Join-Path ([IO.Path]::GetFullPath($PitrRoot)) 'wal') $wal
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Path -LiteralPath $walPath -PathType Leaf) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (-not (Test-Path -LiteralPath $walPath -PathType Leaf)) { throw "The restore-point WAL was not archived locally: $wal" }
    & $uploader -ConfigRoot $ConfigRoot -PitrRoot $PitrRoot | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The physical WAL uploader failed.' }
    $receipt = Join-Path (Join-Path ([IO.Path]::GetFullPath($PitrRoot)) 'receipts') "wal-$wal.receipt.json"
    if (-not (Test-Path -LiteralPath $receipt -PathType Leaf)) { throw "AWS authentication receipt is missing for the restore-point WAL: $wal" }
    $record = [ordered]@{
        format='forge-production-recovery-point'; version=1; name=$name; wal=$wal
        database=[string]$runtime.database.name; projects=[int64]$counts.projects; memories=[int64]$counts.memories
        systemIdentifier=[string]$physical.cluster.systemIdentifier; createdAt=(Get-Date).ToUniversalTime().ToString('o')
    }
    Write-AtomicJson $recordPath $record
    Write-AtomicJson $statusPath ([ordered]@{status='PASS';record=$record;updatedAt=(Get-Date).ToUniversalTime().ToString('o')})
    $record | ConvertTo-Json -Depth 6
}
catch {
    Write-AtomicJson $statusPath ([ordered]@{status='FAIL';error=$_.Exception.Message;updatedAt=(Get-Date).ToUniversalTime().ToString('o')})
    throw
}
finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    if ($adminPlain) { $adminPlain = $null }
    if ($adminPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminPointer) }
}
