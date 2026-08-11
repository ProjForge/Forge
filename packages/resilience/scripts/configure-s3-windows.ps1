[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$')][string]$Bucket,
    [ValidateNotNullOrEmpty()][string]$Region = 'eu-west-1',
    [ValidateNotNullOrEmpty()][string]$Prefix = 'logical',
    [ValidateNotNullOrEmpty()][string]$TargetName = 'aws-offsite-worm',
    [ValidateSet('COMPLIANCE','GOVERNANCE')][string]$ObjectLockMode = 'COMPLIANCE',
    [ValidateRange(1,3650)][int]$RetentionDays = 30,
    [string]$ConfigRoot = (Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'FORGE'),
    [Security.SecureString]$AccessKeyId,
    [Security.SecureString]$SecretAccessKey
)

$ErrorActionPreference = 'Stop'
$policyPath = Join-Path $ConfigRoot 'resilience-policy.json'
$runtimePath = Join-Path $ConfigRoot 'resilience-runtime.json'
$accessKeyPath = Join-Path $ConfigRoot 'resilience-aws-access-key-id.dpapi'
$secretKeyPath = Join-Path $ConfigRoot 'resilience-aws-secret-access-key.dpapi'

if (-not (Test-Path -LiteralPath $policyPath) -or -not (Test-Path -LiteralPath $runtimePath)) {
    throw 'Install the FORGE Windows recovery schedule before configuring S3.'
}
if ($Region -notmatch '^[a-z]{2}(?:-gov)?-[a-z]+-\d$') { throw 'Region is not a valid AWS region name.' }
if ($Prefix -notmatch '^[a-zA-Z0-9][a-zA-Z0-9!_.*''()/-]{0,511}$' -or $Prefix.Contains('//') -or $Prefix.EndsWith('/')) {
    throw 'Prefix must be a safe relative S3 object prefix without a trailing slash.'
}
if ($TargetName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$') { throw 'TargetName contains unsupported characters.' }

if (-not $AccessKeyId) { $AccessKeyId = Read-Host 'AWS recovery Access Key ID' -AsSecureString }
if (-not $SecretAccessKey) { $SecretAccessKey = Read-Host 'AWS recovery Secret Access Key' -AsSecureString }

function Write-DpapiSecretAtomic([Security.SecureString]$Secret, [string]$Path) {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $secretPointer = [IntPtr]::Zero
    $plainBytes = $null
    $protectedBytes = $null
    $temporaryPath = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secret)
        $plainBytes = [Text.Encoding]::UTF8.GetBytes([Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer))
        if ($plainBytes.Length -eq 0) { throw 'AWS credentials cannot be empty.' }
        $protectedBytes = [Security.Cryptography.ProtectedData]::Protect($plainBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        [IO.File]::WriteAllText($temporaryPath,[Convert]::ToBase64String($protectedBytes),[Text.Encoding]::ASCII)
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
        if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
        if ($plainBytes) { [Array]::Clear($plainBytes,0,$plainBytes.Length) }
        if ($protectedBytes) { [Array]::Clear($protectedBytes,0,$protectedBytes.Length) }
    }
}

Write-DpapiSecretAtomic $AccessKeyId $accessKeyPath
Write-DpapiSecretAtomic $SecretAccessKey $secretKeyPath

$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
$existingTargets = @($policy.replicas | Where-Object { $_.name -ne $TargetName })
$s3Target = [ordered]@{
    name = $TargetName
    type = 's3'
    bucket = $Bucket
    prefix = $Prefix
    region = $Region
    objectLock = [ordered]@{ mode = $ObjectLockMode; retentionDays = $RetentionDays }
}
$policy.replicas = @($existingTargets) + @($s3Target)
$temporaryPolicyPath = "$policyPath.$([Guid]::NewGuid().ToString('N')).tmp"
try {
    $policy | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryPolicyPath -Encoding utf8
    Move-Item -LiteralPath $temporaryPolicyPath -Destination $policyPath -Force
}
finally {
    if (Test-Path -LiteralPath $temporaryPolicyPath) { Remove-Item -LiteralPath $temporaryPolicyPath -Force }
}

Write-Output "Configured S3 recovery target '$TargetName' in region '$Region'."
Write-Output 'AWS credentials are protected with CurrentUser DPAPI and are not stored in policy JSON.'
