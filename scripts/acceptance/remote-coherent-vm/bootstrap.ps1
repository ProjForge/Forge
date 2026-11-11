param([string]$HostRole, [string]$RunId, [string]$RecipientSha256)
$ErrorActionPreference='Stop'
if (Test-Path 'C:\ForgeFixtureInput') { throw 'Fixture input already exists' }
Copy-Item C:\FixtureInput C:\ForgeFixtureInput -Recurse
$a=Get-Acl C:\ForgeFixtureInput;$a.SetAccessRuleProtection($true,$false)
foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)}
$s=[Security.Principal.SecurityIdentifier]'S-1-5-18';$a.SetOwner($s)
$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(([Security.Principal.SecurityIdentifier]'S-1-5-32-545'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl C:\ForgeFixtureInput $a
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File C:\ForgeFixtureInput\guest.ps1 -HostRole $HostRole -RunId $RunId -RecipientSha256 $RecipientSha256
exit $LASTEXITCODE
