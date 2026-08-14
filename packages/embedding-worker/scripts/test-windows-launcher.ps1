[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Join-Path ([IO.Path]::GetTempPath()) ('forge-embedding-config-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $root | Out-Null
    $config = @{
        database = @{ host = '::1'; port = 5433; name = 'generic forge'; user = 'runtime/user'; credentialFile = 'runtime.dpapi' }
        embedding = @{
            projectId = '11111111-2222-4333-8444-555555555555'; baseUrl = 'http://127.0.0.1:1234/v1'
            providerName = 'local-provider'; model = 'generic-model'; profileKey = 'generic-profile'; dimensions = 1024
            queryPrefix = "Retrieve project knowledge`nQuery:"
        }
    }
    $config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'workbench.json') -Encoding utf8
    $json = & (Join-Path $PSScriptRoot 'run-qwen.ps1') -ConfigRoot $root -ValidateConfiguration
    $result = $json | ConvertFrom-Json
    if (-not $result.valid -or $result.database.name -ne 'generic forge' -or $result.embedding.model -ne 'generic-model') {
        throw 'The launcher did not load the generic shared configuration.'
    }
    $source = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'run-qwen.ps1')
    if ($source -match 'bd726f08|forge_test') { throw 'The launcher still contains deployment-specific identifiers.' }
    Write-Output 'PASS: embedding Windows launcher is generic and configuration-driven.'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
