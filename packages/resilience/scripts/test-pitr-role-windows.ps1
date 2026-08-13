[CmdletBinding()]
param([string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin')

$ErrorActionPreference = 'Stop'
$initdb = Join-Path $PostgresBin 'initdb.exe'
$pgCtl = Join-Path $PostgresBin 'pg_ctl.exe'
$psql = Join-Path $PostgresBin 'psql.exe'
$pgBaseBackup = Join-Path $PostgresBin 'pg_basebackup.exe'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$root = [IO.Path]::GetFullPath((Join-Path $tempRoot "forge-pitr-role-$([Guid]::NewGuid().ToString('N'))"))
if (-not $root.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $root) -notmatch '^forge-pitr-role-[a-f0-9]{32}$') { throw 'Unsafe role test root.' }
$primary = Join-Path $root 'primary'
$backup = Join-Path $root 'backup'
$config = Join-Path $root 'config'
$pitr = Join-Path $root 'pitr'
$log = Join-Path $root 'primary.log'
$port = Get-Random -Minimum 62000 -Maximum 63000
$admin = 'forge_pitr_admin'
$role = 'forge_pitr_replication'
$started = $false
$plain = $null
$protected = $null

function Invoke-Checked([string]$Tool,[string[]]$Arguments) {
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Native tool failed with exit code ${LASTEXITCODE}: $Tool" }
}
try {
    New-Item -ItemType Directory -Force -Path $root,$config,$pitr | Out-Null
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    Invoke-Checked $initdb @('-D',$primary,'-U',$admin,'-A','trust','--no-locale','-E','UTF8')
    @("listen_addresses = '127.0.0.1'","port = $port","max_wal_senders = 4") | Add-Content -LiteralPath (Join-Path $primary 'postgresql.conf') -Encoding utf8
    Invoke-Checked $pgCtl @('-D',$primary,'-l',$log,'-w','start')
    $started = $true
    [ordered]@{postgresBin=$PostgresBin} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $config 'resilience-runtime.json') -Encoding utf8
    [ordered]@{
        version=1;outputDirectory=(Join-Path $root 'logical');replicas=@([ordered]@{
            name='test-worm';type='s3';bucket='forge-test-bucket';prefix='logical';region='eu-west-1';objectLock=[ordered]@{mode='COMPLIANCE';retentionDays=30}
        });retention=[ordered]@{keepLast=14;maxAgeHours=720};labelPrefix='test';lockPath=(Join-Path $root 'logical.lock');statusPath=(Join-Path $root 'logical-status.json')
    } | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $config 'resilience-policy.json') -Encoding utf8
    $adminPassword = ConvertTo-SecureString 'ignored-by-isolated-trust-auth' -AsPlainText -Force
    & (Join-Path $PSScriptRoot 'setup-pitr-role-windows.ps1') -HostName 127.0.0.1 -Port $port -Database postgres -AdminRole $admin -ReplicationRole $role -PostgresBin $PostgresBin -ConfigRoot $config -PitrRoot $pitr -AdminPassword $adminPassword | Out-Null

    $attributes = & $psql -X -A -t -h 127.0.0.1 -p $port -U $admin -d postgres -c "SELECT rolcanlogin,rolreplication,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls,rolconnlimit FROM pg_roles WHERE rolname='$role';"
    if ($LASTEXITCODE -ne 0 -or ([string]$attributes).Trim() -ne 't|t|f|f|f|f|f|2') { throw "Replication role attributes are unsafe: $attributes" }
    $runtime = Get-Content -LiteralPath (Join-Path $config 'pitr-runtime.json') -Raw | ConvertFrom-Json
    $policy = Get-Content -LiteralPath (Join-Path $config 'pitr-policy.json') -Raw | ConvertFrom-Json
    if ($runtime.enabled -ne $false -or $policy.replicas[0].prefix -ne "physical/$($runtime.cluster.systemIdentifier)") { throw 'Physical runtime or cluster-scoped policy is invalid.' }
    if ((Get-Content -LiteralPath (Join-Path $config 'pitr-runtime.json') -Raw) -match 'ignored-by|PASSWORD') { throw 'A credential leaked into runtime JSON.' }

    $hbaPath = Join-Path $primary 'pg_hba.conf'
    (Get-Content -LiteralPath $hbaPath) -replace '(^host\s+.*\s+)trust\s*$', '${1}scram-sha-256' | Set-Content -LiteralPath $hbaPath -Encoding ascii
    Invoke-Checked $pgCtl @('-D',$primary,'reload')
    $protected = [Convert]::FromBase64String((Get-Content -LiteralPath (Join-Path $config 'resilience-replication.dpapi') -Raw).Trim())
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    $env:PGPASSWORD = [Text.Encoding]::UTF8.GetString($plain)
    Invoke-Checked $pgBaseBackup @('-h','127.0.0.1','-p',[string]$port,'-U',$role,'-D',$backup,'-Fp','-X','stream','--checkpoint=fast','--manifest-checksums=SHA256','--no-password')
    Write-Output 'PASS: dedicated replication role is least-privilege, DPAPI-protected, cluster-scoped and accepted by pg_basebackup under SCRAM.'
}
finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    if ($plain) { [Array]::Clear($plain,0,$plain.Length) }
    if ($protected) { [Array]::Clear($protected,0,$protected.Length) }
    if ($started) { & $pgCtl -D $primary -m immediate -w stop | Out-Null }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
