[CmdletBinding()]
param(
    [string]$HostName = '127.0.0.1',
    [ValidateRange(1,65535)][int]$Port = 5432,
    [string]$Database = 'forge_test',
    [string]$AdminRole = 'postgres',
    [string]$ReplicationRole = 'forge_pitr_replication',
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin',
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [string]$PitrRoot = 'E:\FORGE PITR',
    [Security.SecureString]$AdminPassword
)

$ErrorActionPreference = 'Stop'
if ($ReplicationRole -notmatch '^[a-z_][a-z0-9_]{0,62}$') { throw 'ReplicationRole is not a safe PostgreSQL identifier.' }
if (-not $AdminPassword) { $AdminPassword = Read-Host "Password for PostgreSQL administrator '$AdminRole'" -AsSecureString }
$psql = Join-Path ([IO.Path]::GetFullPath($PostgresBin)) 'psql.exe'
if (-not (Test-Path -LiteralPath $psql -PathType Leaf)) { throw "psql.exe was not found: $psql" }
$runtimePath = Join-Path $ConfigRoot 'resilience-runtime.json'
$sourcePolicyPath = Join-Path $ConfigRoot 'resilience-policy.json'
$secretPath = Join-Path $ConfigRoot 'resilience-replication.dpapi'
$physicalRuntimePath = Join-Path $ConfigRoot 'pitr-runtime.json'
$physicalPolicyPath = Join-Path $ConfigRoot 'pitr-policy.json'
foreach ($path in @($secretPath,$physicalRuntimePath,$physicalPolicyPath)) {
    if (Test-Path -LiteralPath $path) { throw "Refusing to overwrite existing PITR configuration: $path" }
}
$adminPointer = [IntPtr]::Zero
$adminPlain = $null
$replicationBytes = $null
$passwordBytes = $null
$protectedBytes = $null
$temporarySecret = "$secretPath.$([Guid]::NewGuid().ToString('N')).tmp"
$temporaryRuntime = "$physicalRuntimePath.$([Guid]::NewGuid().ToString('N')).tmp"
$temporaryPolicy = "$physicalPolicyPath.$([Guid]::NewGuid().ToString('N')).tmp"
$success = $false

try {
    New-Item -ItemType Directory -Force -Path $ConfigRoot | Out-Null
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $adminPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($AdminPassword)
    $adminPlain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($adminPointer)
    $env:PGPASSWORD = $adminPlain
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $replicationBytes = New-Object byte[] 48; $rng.GetBytes($replicationBytes) } finally { $rng.Dispose() }
    $replicationPassword = [Convert]::ToBase64String($replicationBytes)
    $escapedRole = $ReplicationRole.Replace("'","''")
    $escapedPassword = $replicationPassword.Replace("'","''")
    $sql = @"
DO `$forge_pitr`$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$escapedRole') THEN
    IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='$escapedRole') THEN
      RAISE EXCEPTION 'Existing PITR role has memberships and cannot be converged safely';
    END IF;
    EXECUTE format('ALTER ROLE %I WITH LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD %L', '$escapedRole', '$escapedPassword');
  ELSE
    EXECUTE format('CREATE ROLE %I WITH LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 2 PASSWORD %L', '$escapedRole', '$escapedPassword');
  END IF;
END
`$forge_pitr`$;
"@
    $sql | & $psql -X -w -v ON_ERROR_STOP=1 -h $HostName -p $Port -U $AdminRole -d $Database -f - | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the dedicated PostgreSQL replication role.' }
    $metadataSql = "SELECT json_build_object('systemIdentifier',system_identifier::text,'timeline',timeline_id,'serverVersion',current_setting('server_version'),'serverVersionNumber',current_setting('server_version_num')::integer)::text FROM pg_control_system(), pg_control_checkpoint();"
    $metadataText = & $psql -X -w -A -t -v ON_ERROR_STOP=1 -h $HostName -p $Port -U $AdminRole -d $Database -c $metadataSql
    if ($LASTEXITCODE -ne 0) { throw 'Could not read PostgreSQL cluster identity.' }
    $cluster = (([string]$metadataText).Trim() | ConvertFrom-Json)

    $passwordBytes = [Text.Encoding]::UTF8.GetBytes($replicationPassword)
    $protectedBytes = [Security.Cryptography.ProtectedData]::Protect($passwordBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Convert]::ToBase64String($protectedBytes) | Set-Content -LiteralPath $temporarySecret -Encoding ascii
    $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    $sourcePolicy = Get-Content -LiteralPath $sourcePolicyPath -Raw | ConvertFrom-Json
    $sourceS3 = @($sourcePolicy.replicas | Where-Object type -eq 's3')
    if ($sourceS3.Count -ne 1) { throw 'Exactly one immutable S3 source target is required.' }
    $targetName = 'aws-physical-worm'
    $pitrRootPath = [IO.Path]::GetFullPath($PitrRoot)
    [ordered]@{
        version=1;outputDirectory=(Join-Path $pitrRootPath 'encrypted')
        replicas=@([ordered]@{
            name=$targetName;type='s3';bucket=[string]$sourceS3[0].bucket
            prefix="physical/$($cluster.systemIdentifier)";region=[string]$sourceS3[0].region
            objectLock=[ordered]@{mode=[string]$sourceS3[0].objectLock.mode;retentionDays=[int]$sourceS3[0].objectLock.retentionDays}
        })
        retention=[ordered]@{keepLast=14;maxAgeHours=720};labelPrefix='physical'
        lockPath=(Join-Path $ConfigRoot 'pitr.lock');statusPath=(Join-Path $pitrRootPath 'status\pitr-policy.json')
    } | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $temporaryPolicy -Encoding utf8
    [ordered]@{
        version=1;enabled=$false;postgresBin=[IO.Path]::GetFullPath($PostgresBin)
        cluster=[ordered]@{systemIdentifier=[string]$cluster.systemIdentifier;timeline=[int]$cluster.timeline;serverVersion=[string]$cluster.serverVersion;serverVersionNumber=[int]$cluster.serverVersionNumber}
        replication=[ordered]@{host=$HostName;port=$Port;user=$ReplicationRole}
        policyPath=$physicalPolicyPath;s3=[ordered]@{region=[string]$sourceS3[0].region;target=$targetName}
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporaryRuntime -Encoding utf8
    Move-Item -LiteralPath $temporaryPolicy -Destination $physicalPolicyPath
    Move-Item -LiteralPath $temporaryRuntime -Destination $physicalRuntimePath
    Move-Item -LiteralPath $temporarySecret -Destination $secretPath
    $success = $true
    [ordered]@{status='PASS';role=$ReplicationRole;systemIdentifier=[string]$cluster.systemIdentifier;enabled=$false;configuredAt=[datetime]::UtcNow.ToString('o')} | ConvertTo-Json
}
catch {
    if (-not $success) { Remove-Item -LiteralPath $secretPath,$physicalRuntimePath,$physicalPolicyPath -Force -ErrorAction SilentlyContinue }
    throw
}
finally {
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporarySecret -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporaryRuntime,$temporaryPolicy -Force -ErrorAction SilentlyContinue
    $replicationPassword = $null
    $adminPlain = $null
    if ($adminPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminPointer) }
    if ($replicationBytes) { [Array]::Clear($replicationBytes,0,$replicationBytes.Length) }
    if ($passwordBytes) { [Array]::Clear($passwordBytes,0,$passwordBytes.Length) }
    if ($protectedBytes) { [Array]::Clear($protectedBytes,0,$protectedBytes.Length) }
}
