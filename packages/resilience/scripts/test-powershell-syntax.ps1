[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$scripts = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1'
foreach ($script in $scripts) {
    $tokens = $null
    $errors = $null
    [Management.Automation.Language.Parser]::ParseFile($script.FullName,[ref]$tokens,[ref]$errors) | Out-Null
    if ($errors.Count -gt 0) {
        $messages = $errors | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Message)" }
        throw "$($script.Name) failed PowerShell syntax validation: $($messages -join '; ')"
    }
}
Write-Output "PASS: $($scripts.Count) FORGE Resilience PowerShell scripts parsed successfully."

$testRoot = Join-Path ([IO.Path]::GetTempPath()) "forge-s3-config-$([Guid]::NewGuid().ToString('N'))"
try {
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    [ordered]@{ replicas = @([ordered]@{ name = 'filesystem-primary'; path = 'D:\recovery' }) } |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $testRoot 'resilience-policy.json') -Encoding utf8
    '{}' | Set-Content -LiteralPath (Join-Path $testRoot 'resilience-runtime.json') -Encoding utf8
    $testAccessKey = ConvertTo-SecureString 'AKIATESTFORGE12345678' -AsPlainText -Force
    $testSecretKey = ConvertTo-SecureString 'test-secret-key-that-is-never-an-aws-credential' -AsPlainText -Force
    & (Join-Path $PSScriptRoot 'configure-s3-windows.ps1') `
        -Bucket 'forge-test-recovery-bucket' -ConfigRoot $testRoot `
        -AccessKeyId $testAccessKey -SecretAccessKey $testSecretKey | Out-Null

    $policyText = Get-Content -LiteralPath (Join-Path $testRoot 'resilience-policy.json') -Raw
    $policy = $policyText | ConvertFrom-Json
    $target = @($policy.replicas | Where-Object { $_.name -eq 'aws-offsite-worm' })
    if ($target.Count -ne 1 -or $target[0].bucket -ne 'forge-test-recovery-bucket') { throw 'S3 target was not configured correctly.' }
    if ($policyText.Contains('AKIATESTFORGE') -or $policyText.Contains('test-secret-key')) { throw 'AWS credential leaked into policy JSON.' }

    Add-Type -AssemblyName System.Security -ErrorAction Stop
    foreach ($secretName in @('resilience-aws-access-key-id.dpapi','resilience-aws-secret-access-key.dpapi')) {
        $protected = [Convert]::FromBase64String((Get-Content -LiteralPath (Join-Path $testRoot $secretName) -Raw).Trim())
        $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        try { if ($plain.Length -eq 0) { throw "$secretName did not decrypt." } }
        finally { [Array]::Clear($plain,0,$plain.Length); [Array]::Clear($protected,0,$protected.Length) }
    }
    Write-Output 'PASS: S3 configuration stores credentials only in CurrentUser DPAPI.'
}
finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
