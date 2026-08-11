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
