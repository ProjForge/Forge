param([ValidateSet("init","deny","capture","restore","cleanup")][string]$Role, [string]$ExpectedSid, [string]$RunId, [string]$Pin)
$ErrorActionPreference='Stop'
$dir='custodian';if($Role -in 'capture','deny'){$dir='capturer'}
$env:TEMP="C:\ForgeFixture\capturer\temp"
if($Role -in 'init','restore'){$env:TEMP='C:\ForgeFixture\private\temp';New-Item -ItemType Directory -Force $env:TEMP | Out-Null}
if($Role -eq 'cleanup'){$env:TEMP='C:\ForgeFixture\custodian\temp'}
$env:TMP=$env:TEMP
$result=@{role=$Role;passed=$false}
try {
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FixtureMove {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool MoveFile(string a,string b);
 public static int Try(string a,string b){if(MoveFile(a,b))return 0;return Marshal.GetLastWin32Error();}
}
"@

 $id=[Security.Principal.WindowsIdentity]::GetCurrent()
 $env:FORGE_EXPECTED_SID=$id.User.Value
 $principal=New-Object Security.Principal.WindowsPrincipal($id)
 $result.sidMatchesExpected=($id.User.Value -eq $ExpectedSid)
 $result.administrator=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
 $sha=[Security.Cryptography.SHA256]::Create()
 $result.sidHash=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($id.User.Value)))).Replace('-','').ToLower()
 if(!$result.sidMatchesExpected -or $result.administrator){throw 'Invalid effective token'}
 $result.backupOperator=$principal.IsInRole([Security.Principal.SecurityIdentifier]'S-1-5-32-551')
 $privs=(& whoami.exe /priv | Out-String)
 $result.forbiddenPrivilegesPresent=($privs -match 'SeBackupPrivilege|SeRestorePrivilege|SeTakeOwnershipPrivilege')
 if($result.backupOperator -or $result.forbiddenPrivilegesPresent){throw 'Unsafe token'}
 if($Role -eq 'deny'){
  $result.moves=@()
  foreach($source in @('C:\ForgeFixture\private\rsa.pem','C:\ForgeFixture\private')){
   $denied=$false
   $code=[FixtureMove]::Try($source,'C:\ForgeFixture\capturer\stolen'+[guid]::NewGuid().ToString('N'))
   if($code -ne 5){throw "Native move expected 5; actual $code"}
   $result.moves+=@{denied=$true;hresult='0x80070005';win32=5}
  }
  [IO.File]::WriteAllText('C:\ForgeFixture\capturer\own','control')
  [IO.File]::Move('C:\ForgeFixture\capturer\own','C:\ForgeFixture\capturer\moved')
  $result.ownMoveAllowed=$true
  $denied=$false
  try{$f=[IO.File]::Open('C:\ForgeFixture\custodian\init.result.json',[IO.FileMode]::Open,[IO.FileAccess]::Write);$f.Dispose()}catch [UnauthorizedAccessException]{$denied=($_.Exception.HResult -eq -2147024891)}
  if(!$denied){throw 'Capturer can write custodian result'}
  $result.custodianResultWriteDenied5=$true
  foreach($access in @([IO.FileAccess]::Read,[IO.FileAccess]::Write)){
   $denied=$false
   try{$f=[IO.File]::Open('C:\ForgeFixture\private\rsa.pem',[IO.FileMode]::Open,$access,[IO.FileShare]::ReadWrite);$f.Dispose()}catch [UnauthorizedAccessException]{
    $hr=$_.Exception.HResult
    if($hr -ne -2147024891){throw 'Unexpected access HRESULT'}
    $denied=$true
   }
   if(!$denied){throw 'Private file access unexpectedly allowed'}
  }
  $result.privateOpenHresult='0x80070005';$result.win32Error=5
 }
 if ($Role -eq 'cleanup') {
  $private = 'C:\ForgeFixture\private'
  $report = 'C:\ForgeFixture\report-parent\reports'
  foreach ($parent in @('C:\ForgeFixture','C:\ForgeFixture\report-parent')) {
   $directory = Get-Item -LiteralPath $parent -Force
   if (!$directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Unsafe fixture parent during cleanup'
   }
  }
  if (Test-Path -LiteralPath (Join-Path $private 'target')) { throw 'Restore cluster cleanup was incomplete' }
  foreach ($path in @($report,$private)) {
   if (!(Test-Path -LiteralPath $path)) { continue }
   $directory = Get-Item -LiteralPath $path -Force
   if (!$directory.PSIsContainer -or $directory.FullName -ine $path) { throw 'Unexpected fixture cleanup path' }
   $pending = [Collections.Generic.Stack[IO.FileSystemInfo]]::new()
   $pending.Push($directory)
   while ($pending.Count -gt 0) {
    $item = $pending.Pop()
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Fixture cleanup found a redirected entry' }
    if ($item.PSIsContainer) {
     foreach ($child in (Get-ChildItem -LiteralPath $item.FullName -Force)) { $pending.Push($child) }
    }
   }
   Remove-Item -LiteralPath $directory.FullName -Recurse -Force
   if (Test-Path -LiteralPath $path) { throw 'Fixture cleanup did not remove its directory' }
  }
  $result.privateRemoved = $true
  $result.reportRemoved = $true
 }
 if ($Role -in 'init','capture','restore') {
  Set-Location C:\ForgeFixtureInput
  $probeArgs = @('C:\ForgeFixtureInput\probe.mjs', $Role, $RunId)
  if ($Pin) { $probeArgs += $Pin }
  # Windows PowerShell wraps native stderr in an ErrorRecord. Keep the Node
  # exit and sanitized JSON even when the expected rejection writes to stderr.
  try {
   $ErrorActionPreference = 'Continue'
   & C:\ForgeFixtureInput\node.exe @probeArgs 2> "C:\ForgeFixture\$dir\$Role.stderr.txt"
   $result.nodeExit = $LASTEXITCODE
  } finally {
   $ErrorActionPreference = 'Stop'
  }
  $result.crypto = Get-Content -LiteralPath "C:\ForgeFixture\$dir\$Role.crypto.json" -Raw | ConvertFrom-Json
  if ($result.nodeExit -ne 0) { throw 'Node probe failed' }
 }
 if($Role -eq 'init'){
  $acl=Get-Acl -LiteralPath 'C:\ForgeFixture\private\rsa.pem'
  $acl.SetAccessRuleProtection($true,$false)
  foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
  $acl.SetOwner($id.User)
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id.User,'FullControl','Allow')))
  Set-Acl -LiteralPath 'C:\ForgeFixture\private\rsa.pem' -AclObject $acl
  $verified=Get-Acl -LiteralPath 'C:\ForgeFixture\private\rsa.pem'
  $result.fileAclProtected=$verified.AreAccessRulesProtected
  $result.fileOwnerMatches=($verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $ExpectedSid)
  $result.fileOnlyCustodian=(@($verified.Access).Count -eq 1 -and $verified.Access[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $ExpectedSid)
  if(!$result.fileAclProtected -or !$result.fileOwnerMatches -or !$result.fileOnlyCustodian){throw 'File ACL mismatch'}
 }
 $result.passed=$true
} catch {$result.failureType=$_.Exception.GetType().FullName;$result.hresult=$_.Exception.GetBaseException().HResult;$result.failure=$_.Exception.Message}
$result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath "C:\ForgeFixture\$dir\$Role.result.json" -Encoding UTF8
if(!$result.passed){exit 1}
exit 0
