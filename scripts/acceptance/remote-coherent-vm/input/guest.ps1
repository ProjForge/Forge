param(
    [Parameter(Mandatory)][ValidateSet('Source','Destination')][string]$HostRole,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9-]{36}$')][string]$RunId,
    [ValidatePattern('^([a-f0-9]{64})?$')][string]$RecipientSha256 = '',
    [switch]$DestinationVm
)
$ErrorActionPreference = 'Stop'
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne 'S-1-5-18') { throw 'Guest supervisor requires SYSTEM' }
if ($DestinationVm -and $HostRole -ne 'Destination') { throw 'The direct VM mode supports only restoration' }
if (@(Get-NetRoute -ErrorAction Stop | Where-Object DestinationPrefix -in '0.0.0.0/0','::/0').Count -gt 0) { throw 'Guest has a network default route' }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FixtureLaunch {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct SI { public int cb; public string reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags; public short show,reserved2; public IntPtr extra,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] public struct PI {public IntPtr process,thread;public int pid,tid;}
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool LogonUser(string u,string d,string p,int t,int provider,out IntPtr token);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessWithTokenW(IntPtr token,int flags,string app,System.Text.StringBuilder cmd,int creation,IntPtr env,string dir,ref SI si,out PI pi);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint c);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [StructLayout(LayoutKind.Sequential)] struct SA {public int length; public IntPtr descriptor;public int inherit;}
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s,uint v,out IntPtr p,out uint n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateWindowStation(string n,uint flags,uint access,ref SA sa);
 [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
 [DllImport("user32.dll",SetLastError=true)] static extern bool SetProcessWindowStation(IntPtr w);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateDesktop(string n,IntPtr dev,IntPtr mode,uint flags,uint access,ref SA sa);
 public static uint Run(string u,string p,string args){
  IntPtr token;if(!LogonUser(u,".",p,2,0,out token))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"LogonUser failed; Win32="+Marshal.GetLastWin32Error());
  try{
 string sid=new System.Security.Principal.WindowsIdentity(token).User.Value;
 IntPtr sd;uint size;
 if(!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;"+sid+")",1,out sd,out size))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"SD");
 SA sa=new SA();sa.length=Marshal.SizeOf(sa);sa.descriptor=sd;
 string station="Forge"+Guid.NewGuid().ToString("N");
 IntPtr old=GetProcessWindowStation(),ws=CreateWindowStation(station,0,0x000F037F,ref sa);
 if(ws==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"WindowStation");
 if(!SetProcessWindowStation(ws))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"SetStation");
 IntPtr desktop=CreateDesktop("default",IntPtr.Zero,IntPtr.Zero,0,0x000F01FF,ref sa);
 SetProcessWindowStation(old);
 if(desktop==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"Desktop");
 SI si=new SI();si.cb=Marshal.SizeOf(si);si.desktop=station+@"\default";PI pi;
   if(!CreateProcessWithTokenW(token,0,@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",new System.Text.StringBuilder("powershell.exe "+args),0x08000000,IntPtr.Zero,@"C:\ForgeFixtureInput",ref si,out pi))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),"CreateProcessWithTokenW");
   try{if(WaitForSingleObject(pi.process,600000)!=0)throw new Exception("Native role timeout");uint code;GetExitCodeProcess(pi.process,out code);return code;}finally{CloseHandle(pi.process);CloseHandle(pi.thread);}
  }finally{CloseHandle(token);}
 }
}
"@
$ErrorActionPreference='Stop'
$root='C:\ForgeFixture'
$users=@('ForgeCustodian','ForgeCapturer')
$createdUsers = @()
$privateCreated = $false
$privateReady = $false
$result=@{runId=$RunId;hostRole=$HostRole;passed=$false;tests=@();sourceCommit='42031db73e38320889a04d9026af044dcbb03eee';fixtureOnly=$true}
if ($DestinationVm) { $result.destinationMode = 'direct-vm' }
try{
 if(Test-Path $root){throw 'Fixture root already exists'}
 New-Item -ItemType Directory $root | Out-Null
 $passwords=@{}
 foreach($user in $users){
  $bytes=New-Object byte[] 32;[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $passwords[$user]=[Convert]::ToBase64String($bytes)+'aA!7'
  New-LocalUser -Name $user -Password (ConvertTo-SecureString $passwords[$user] -AsPlainText -Force) | Out-Null
  $createdUsers += $user
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
 }
 $sid1=(Get-LocalUser $users[0]).SID;$sid2=(Get-LocalUser $users[1]).SID
 if($sid1.Value -eq $sid2.Value){throw 'Duplicate SID'}
 $result.distinctRealSids=$true
 $adminMembers=@(Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object {$_.SID.Value})
 if($adminMembers -contains $sid1.Value -or $adminMembers -contains $sid2.Value){throw 'Admin membership'}
 $acl=Get-Acl $root
 $acl.SetAccessRuleProtection($true,$false)
 foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
 foreach($sid in @($sid1,$sid2,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))){
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
 }
 $system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
 $acl.SetOwner($system)
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
 Set-Acl $root $acl
 foreach($d in @('custodian','capturer','exchange','public')){
  New-Item -ItemType Directory "$root/$d" | Out-Null
  $a=Get-Acl "$root/$d";$a.SetAccessRuleProtection($true,$false)
  foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)}
  $s=$sid1;$reader=$system
  if($d -eq 'capturer' -or $d -eq 'exchange'){$s=$sid2;$reader=$sid1}
  if($d -eq 'exchange'){$reader=$sid1}
  if($d -eq 'exchange' -and $HostRole -eq 'Destination'){$s=$system}
  if($d -eq 'public'){$reader=$sid2}
  $a.SetOwner($s)
  $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
  $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($reader,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')))
  $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
  Set-Acl "$root/$d" $a
 }
 New-Item -ItemType Directory "$root/custodian/temp","$root/capturer/temp" | Out-Null
 New-Item -ItemType Directory "$root/report-parent" | Out-Null
 $a=Get-Acl "$root/report-parent";$a.SetAccessRuleProtection($true,$false)
 foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)}
 $a.SetOwner($system)
 $reportWriters = @($system)
 if ($HostRole -eq 'Source') { $reportWriters += $sid2 } else { $reportWriters += $sid1 }
 foreach($s in $reportWriters){$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))}
 Set-Acl "$root/report-parent" $a
 if ($HostRole -eq 'Destination') {
 New-Item -ItemType Directory "$root/private" | Out-Null
 $privateCreated = $true
 $acl=Get-Acl "$root/private"
 $acl.SetAccessRuleProtection($true,$false)
 foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
 $acl.SetOwner($sid1)
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid1,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
 Set-Acl "$root/private" $acl
 $verified=Get-Acl "$root/private"
 $result.directoryAclProtected=$verified.AreAccessRulesProtected
 $result.directoryOwnerMatches=($verified.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid1.Value)
 $result.directoryOnlyCustodian=(@($verified.Access).Count -eq 1 -and $verified.Access[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid1.Value)
 if(!$result.directoryAclProtected -or !$result.directoryOwnerMatches -or !$result.directoryOnlyCustodian){throw 'Directory ACL mismatch'}
 $privateReady = $true
 }
 'allowed' | Set-Content "$root/public/control" -NoNewline -Encoding ascii

 function Invoke-FixtureRole {
  param([string]$Role, [string]$Pin = '')
  $index = 0
  $dir = 'custodian'
  if ($Role -in 'capture','deny') { $index = 1; $dir = 'capturer' }
  $user = $users[$index]
  $sid = (Get-LocalUser $user).SID.Value
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File C:\ForgeFixtureInput\role.ps1 -Role $Role -ExpectedSid $sid -RunId $RunId"
  if ($Pin) { $arguments += " -Pin $Pin" }
  $exitCode = [FixtureLaunch]::Run($user, $passwords[$user], $arguments)
  $entry = Get-Content -LiteralPath "$root/$dir/$Role.result.json" -Raw | ConvertFrom-Json
  $result.tests += @{ role = $Role; processExit = $exitCode; result = $entry }
  if ($exitCode -ne 0 -or !$entry.passed) { throw "Failed fixture phase: $Role" }
  return $entry
 }

 Set-Location C:\ForgeFixtureInput
 if ($HostRole -eq 'Source') {
  Copy-Item -LiteralPath 'C:\FixtureInbox\public.pem' -Destination "$root/public/public.pem"
  $captured = Invoke-FixtureRole 'capture' $RecipientSha256
  Copy-Item -LiteralPath "$root/exchange" -Destination 'C:\FixtureOutput\handoff' -Recurse
  $captured.crypto.transfer | ConvertTo-Json -Compress |
      Set-Content -LiteralPath 'C:\FixtureOutput\transfer.json' -Encoding ASCII
 } else {
  $init = Invoke-FixtureRole 'init'
  Invoke-FixtureRole 'deny' | Out-Null
  Copy-Item -LiteralPath "$root/public/public.pem" -Destination 'C:\FixtureOutput\public.pem'
  @{ runId = $RunId; recipientSha256 = $init.crypto.recipientSha256 } | ConvertTo-Json -Compress |
      Set-Content -LiteralPath 'C:\FixtureOutput\recipient.json' -Encoding ASCII

  $request = 'C:\FixtureInbox\restore.sha256'
  $wait = [Diagnostics.Stopwatch]::StartNew()
  while (!(Test-Path -LiteralPath $request)) {
   if ($wait.Elapsed.TotalHours -ge 2) { throw 'Timed out waiting for the authenticated handoff' }
   Start-Sleep -Milliseconds 500
  }
  $pin = (Get-Content -LiteralPath $request -Raw).Trim()
  if ($pin -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid manifest SHA-256' }
  if ($DestinationVm -and @(Get-NetRoute -ErrorAction Stop | Where-Object DestinationPrefix -in '0.0.0.0/0','::/0').Count -gt 0) {
   throw 'Destination VM gained a default route while waiting for the handoff'
  }
  $env:FORGE_REHEARSAL_RECIPIENT = $init.crypto.recipientSha256
  # SYSTEM stages only the verified allowlist from the read-only share. The custodian rechecks it.
  & .\node.exe .\probe.mjs stage $RunId $pin
  if ($LASTEXITCODE -ne 0) { throw 'Replica staging failed' }
  $restored = Invoke-FixtureRole 'restore' $pin
  if ($init.sidHash -ne $restored.sidHash) { throw 'The custodian token changed' }
 }
 $result.passed = $true
} catch {
 $result.failureType = $_.Exception.GetType().FullName
 $result.failure = $_.Exception.Message
 $result.hresult = $_.Exception.GetBaseException().HResult
} finally {
 if ($DestinationVm) {
  $result.privateRemoved = !$privateCreated
  if ($privateReady) {
   try {
    $cleanup = Invoke-FixtureRole 'cleanup'
    $result.privateRemoved = $cleanup.privateRemoved -eq $true -and $cleanup.reportRemoved -eq $true
   } catch {
    $result.cleanupFailure = $_.Exception.GetType().FullName
   }
  }
  if (!$result.privateRemoved) { $result.passed = $false }
 }
 foreach ($user in $createdUsers) { Remove-LocalUser -Name $user -ErrorAction SilentlyContinue }
 $result.accountsRemoved = (@(Get-LocalUser | Where-Object {$createdUsers -contains $_.Name}).Count -eq 0)
 $result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath 'C:\FixtureOutput\result.json' -Encoding UTF8
}
if (!$result.passed -or !$result.accountsRemoved) { exit 1 }
exit 0
