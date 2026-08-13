[CmdletBinding()]
param(
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin',
    [switch]$KeepOnFailure
)

$ErrorActionPreference = 'Stop'
$initdb = Join-Path $PostgresBin 'initdb.exe'
$pgCtl = Join-Path $PostgresBin 'pg_ctl.exe'
$psql = Join-Path $PostgresBin 'psql.exe'
foreach ($tool in $initdb,$pgCtl,$psql) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Required PostgreSQL tool not found: $tool" }
}

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = [IO.Path]::GetFullPath((Join-Path $tempRoot "forge-base-worker-$([Guid]::NewGuid().ToString('N'))"))
if (-not $root.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $root) -notmatch '^forge-base-worker-[a-f0-9]{32}$') {
    throw 'Unsafe base-backup test root.'
}
$primary = Join-Path $root 'primary'
$config = Join-Path $root 'config'
$pitr = Join-Path $root 'pitr'
$log = Join-Path $root 'primary.log'
$packageRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe -ErrorAction Stop).Source
$cli = Join-Path $packageRoot 'dist\cli.js'
$port = Get-Random -Minimum 63000 -Maximum 64000
$user = 'forge_base_test'
$label = 'base-native-test'
$started = $false
$passed = $false
$plainValues = [Collections.Generic.List[byte[]]]::new()
$protectedValues = [Collections.Generic.List[byte[]]]::new()

function Set-TestPhase([string]$Phase) {
    [ordered]@{ phase=$Phase; updatedAt=(Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $root 'test-phase.json') -Encoding utf8
}

function Invoke-Checked([string]$Tool, [string[]]$Arguments) {
    # Do not pipe pg_ctl output: on Windows the detached server can inherit the
    # pipeline handle and keep PowerShell waiting after the server is ready.
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Native tool failed with exit code ${LASTEXITCODE}: $Tool" }
}

function Invoke-Sql([string]$Sql, [switch]$Scalar) {
    $arguments = @('-X','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',[string]$port,'-U',$user,'-d','postgres')
    if ($Scalar) { $arguments += @('-A','-t') }
    $arguments += @('-c',$Sql)
    $result = & $psql @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Isolated PostgreSQL query failed.' }
    if ($Scalar) { return (($result | Out-String).Trim()) }
    return $result
}

function Write-Dpapi([string]$Path, [string]$Value) {
    $plain = [Text.Encoding]::UTF8.GetBytes($Value)
    $protected = [Security.Cryptography.ProtectedData]::Protect($plain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $plainValues.Add($plain)
    $protectedValues.Add($protected)
    [Convert]::ToBase64String($protected) | Set-Content -LiteralPath $Path -Encoding ascii
}

try {
    New-Item -ItemType Directory -Force -Path $root,$config,$pitr | Out-Null
    Set-TestPhase 'initdb'
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    Invoke-Checked $initdb @('-D',$primary,'-U',$user,'-A','trust','--no-locale','-E','UTF8')
    @("listen_addresses = '127.0.0.1'","port = $port","max_wal_senders = 4") |
        Add-Content -LiteralPath (Join-Path $primary 'postgresql.conf') -Encoding utf8
    Set-TestPhase 'start'
    Invoke-Checked $pgCtl @('-D',$primary,'-l',$log,'-w','start')
    $started = $true
    Set-TestPhase 'seed'
    Invoke-Sql "CREATE TABLE base_backup_probe(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO base_backup_probe VALUES (1, 'durable');"
    Set-TestPhase 'metadata'
    $cluster = (Invoke-Sql "SELECT json_build_object('systemIdentifier',system_identifier::text,'timeline',timeline_id,'serverVersion',current_setting('server_version'),'serverVersionNumber',current_setting('server_version_num')::integer)::text FROM pg_control_system(), pg_control_checkpoint();" -Scalar) | ConvertFrom-Json

    Set-TestPhase 'dpapi'
    Write-Dpapi (Join-Path $config 'resilience-physical-passphrase.dpapi') 'base-worker-physical-passphrase-0123456789'
    Write-Dpapi (Join-Path $config 'resilience-replication.dpapi') 'base-worker-replication-test-secret'
    [ordered]@{ nodePath=$node; cliPath=$cli } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $config 'resilience-runtime.json') -Encoding utf8
    [ordered]@{
        postgresBin=$PostgresBin
        cluster=[ordered]@{
            systemIdentifier=[string]$cluster.systemIdentifier; timeline=[int]$cluster.timeline
            serverVersion=[string]$cluster.serverVersion; serverVersionNumber=[int]$cluster.serverVersionNumber
        }
        replication=[ordered]@{host='127.0.0.1';port=$port;user=$user}
        s3=[ordered]@{region='eu-west-1';target='unused'}
        policyPath=(Join-Path $config 'unused.json')
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $config 'pitr-runtime.json') -Encoding utf8

    Set-TestPhase 'worker'
    & (Join-Path $PSScriptRoot 'run-physical-basebackup-windows.ps1') `
        -ConfigRoot $config -PitrRoot $pitr -Label $label -PackageOnly | Out-Null
    $status = Get-Content -LiteralPath (Join-Path $pitr 'status\physical-basebackup.json') -Raw | ConvertFrom-Json
    if ($status.status -ne 'PASS' -or $status.result.status -ne 'packaged') { throw 'Base-backup worker did not pass.' }
    $manifestPath = Join-Path $pitr "encrypted\$label.forge-physical.json"
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.kind -ne 'base-backup' -or [string]$manifest.cluster.systemIdentifier -ne [string]$cluster.systemIdentifier) {
        throw 'Physical manifest is not bound to the isolated source cluster.'
    }
    if (@(Get-ChildItem -LiteralPath (Join-Path $pitr 'staging') -Force).Count -ne 0) { throw 'Successful staging data was not cleaned.' }

    Set-TestPhase 'offline-replay'
    Invoke-Checked $pgCtl @('-D',$primary,'-m','fast','-w','stop')
    $started = $false
    & (Join-Path $PSScriptRoot 'run-physical-basebackup-windows.ps1') `
        -ConfigRoot $config -PitrRoot $pitr -Label $label -PackageOnly | Out-Null
    if (@(Get-ChildItem -LiteralPath (Join-Path $pitr 'encrypted') -Filter '*.forge-physical.json').Count -ne 1) {
        throw 'Base-backup worker replay was not idempotent.'
    }
    $passed = $true
    Set-TestPhase 'complete'
    Write-Output 'PASS: isolated PostgreSQL base backup, native verification, encryption and offline idempotent replay passed.'
}
finally {
    if ($started) { & $pgCtl -D $primary -m immediate -w stop | Out-Null }
    foreach ($plain in $plainValues) { [Array]::Clear($plain,0,$plain.Length) }
    foreach ($protected in $protectedValues) { [Array]::Clear($protected,0,$protected.Length) }
    if ($passed -or -not $KeepOnFailure) {
        if ($root.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $root) -match '^forge-base-worker-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
