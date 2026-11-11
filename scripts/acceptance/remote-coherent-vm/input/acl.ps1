param([string]$Path)
$ErrorActionPreference='Stop'
$a=Get-Acl -LiteralPath $Path
$expected=$env:FORGE_EXPECTED_SID
$owner=($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $expected)
$only=(@($a.Access | Where-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $expected}).Count -eq 0)
if(!$owner -or !$only){throw 'Callback ACL mismatch'}
@{ownerMatches=$owner;onlyCustodian=$only} | ConvertTo-Json -Compress
