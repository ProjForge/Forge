[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$')][string]$RunId,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]{0,14}$')][string]$ExpectedComputerName,
    [switch]$ConfirmDisposableVm,
    [switch]$PlanOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($RunId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$') { throw 'RunId must be a lowercase UUID' }
# Enumerate one level at a time: never follow a junction while discovering children.
function Assert-SafeTree([string]$Path) {
    $pending = New-Object 'Collections.Generic.Queue[object]'
    $pending.Enqueue(@($Path, 0))
    $count = 0
    while ($pending.Count) {
        $entry = $pending.Dequeue()
        $item = Get-Item -LiteralPath $entry[0] -Force
        if ((++$count) -gt 100000 -or $entry[1] -gt 64) { throw 'Kit traversal limit exceeded' }
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are forbidden' }
        if ($item.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) {
                $pending.Enqueue(@($child.FullName, ($entry[1] + 1)))
            }
        }
    }
}
function Set-ProtectedDirectory([string]$Path, [bool]$UsersRead) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier($sid)),
            'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    if ($UsersRead) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')),
            'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    }
    # Apply security at creation, before any payload is placed in the directory.
    $directory = New-Object IO.DirectoryInfo($Path)
    $directory.Create($acl)
}
# Reject redirected ancestors, including a redirected portable-kit root.
$ancestor = Get-Item -LiteralPath $PSScriptRoot -Force
while ($null -ne $ancestor) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected kit ancestor' }
    $ancestor = $ancestor.Parent
}
$inputPath = Join-Path $PSScriptRoot 'input'
Assert-SafeTree $inputPath
$inputAllowed = @('guest.ps1','role.ps1','acl.ps1','node.exe','check-handoff.mjs',
    'remote-coherent-transfer.mjs','probe.mjs','database.mjs','packages','node_modules','postgres')
foreach ($entry in Get-ChildItem -LiteralPath $inputPath -Force) {
    if ($entry.Name -notin $inputAllowed) { throw "Unexpected input output or entry: $($entry.Name)" }
}
$allowed = @('input','Start-VmDestination.ps1','Submit-VmReplica.ps1','Start-Rehearsal.ps1',
    'Submit-Replica.ps1','Test-Kit.mjs','bootstrap.ps1','sandbox-config.xml','README.md','acta.md')
foreach ($entry in Get-ChildItem -LiteralPath $PSScriptRoot -Force) {
    if ($entry.Name -notin $allowed) { throw "Unexpected kit output or entry: $($entry.Name)" }
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirected kit entry' }
}
foreach ($relative in @('guest.ps1','role.ps1','acl.ps1','node.exe','check-handoff.mjs',
    'remote-coherent-transfer.mjs','probe.mjs','database.mjs',
    'postgres/bin/initdb.exe','postgres/bin/pg_ctl.exe','postgres/bin/pg_dump.exe',
    'postgres/bin/pg_restore.exe','postgres/bin/psql.exe')) {
    if (!(Test-Path -LiteralPath (Join-Path $inputPath $relative) -PathType Leaf)) { throw "Missing kit file: $relative" }
}
foreach ($relative in @('packages','node_modules','postgres')) {
    if (!(Test-Path -LiteralPath (Join-Path $inputPath $relative) -PathType Container)) { throw "Missing kit directory: $relative" }
}
$scripts = @(Get-ChildItem -LiteralPath $inputPath -Filter '*.ps1' -Recurse -File)
$scripts += @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' -File)
foreach ($script in $scripts) {
    $tokens = $null; $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw "Invalid PowerShell syntax: $($script.Name)" }
    if ($script.FullName -eq (Join-Path $inputPath 'guest.ps1')) {
        if ('DestinationVm' -notin @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })) {
            throw 'guest.ps1 lacks the DestinationVm contract'
        }
    }
}
$taskName = 'ForgePreprodRestore-' + $RunId
$paths = @('C:\ForgeFixture','C:\ForgeFixtureInput','C:\FixtureInbox','C:\FixtureOutput')
if ($PlanOnly) {
    Write-Output ("Plan only; task: {0}; paths: {1}; result: C:\FixtureOutput\result.json" -f $taskName, ($paths -join ', '))
    return
}
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Execution requires Windows PowerShell 5.1' }
if (!$ConfirmDisposableVm) { throw 'Execution requires -ConfirmDisposableVm on a dedicated disposable VM' }
if (![Environment]::Is64BitProcess -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'Windows x64 process required' }
if ($env:COMPUTERNAME -ine $ExpectedComputerName) { throw 'Computer name mismatch' }
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator required' }
$system = Get-CimInstance Win32_ComputerSystem
if ($system.Name -ine $ExpectedComputerName -or $system.PartOfDomain) { throw 'Unexpected computer or domain membership' }
$vmIdentity = "$($system.Manufacturer) $($system.Model)"
if ($vmIdentity -notmatch '(?i)(Microsoft Corporation Virtual Machine|VMware|VirtualBox|innotek|QEMU|KVM|Xen|HVM domU|Parallels|Amazon EC2|Google Compute Engine)') {
    throw 'Known virtual-machine model required'
}
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
if ($disk.FileSystem -ne 'NTFS' -or $disk.DriveType -ne 3) { throw 'C: must be a local NTFS volume' }
if (@(Get-NetRoute -ErrorAction Stop | Where-Object { $_.DestinationPrefix -in @('0.0.0.0/0','::/0') }).Count) {
    throw 'Default routes are forbidden; use private or console access. Networking was not changed.'
}
foreach ($path in $paths) {
    if (Test-Path -LiteralPath $path) { throw "Existing fixture path: $path" }
}
if (@(Get-ScheduledTask | Where-Object TaskName -eq $taskName).Count) { throw 'Scheduled task collision' }
$ownedTask = $false
$verifiedCleanup = $false
try {
    Set-ProtectedDirectory 'C:\ForgeFixtureInput' $true
    Set-ProtectedDirectory 'C:\FixtureInbox' $false
    Set-ProtectedDirectory 'C:\FixtureOutput' $false
    # Copy the input contents only. Fresh children inherit the protected destination ACL.
    Assert-SafeTree $inputPath
    foreach ($child in Get-ChildItem -LiteralPath $inputPath -Force) {
        Copy-Item -LiteralPath $child.FullName -Destination 'C:\ForgeFixtureInput' -Recurse
    }
    Assert-SafeTree 'C:\ForgeFixtureInput'
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File C:\ForgeFixtureInput\guest.ps1 -HostRole Destination -RunId $RunId -DestinationVm"
    $action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory 'C:\ForgeFixtureInput'
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 140) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Principal $taskPrincipal -Settings $settings | Out-Null
    $ownedTask = $true
    $started = Get-Date
    Start-ScheduledTask -TaskName $taskName -TaskPath '\'
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        Start-Sleep -Seconds 2
        $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\'
        $info = Get-ScheduledTaskInfo -TaskName $taskName -TaskPath '\'
        if ($info.LastRunTime -ge $started.AddSeconds(-1) -and $task.State -notin @('Running','Queued')) { break }
        if ($timer.Elapsed.TotalMinutes -ge 140) { throw 'Destination task timed out' }
    } while ($true)
    Assert-SafeTree 'C:\FixtureOutput'
    $result = Get-Content -LiteralPath 'C:\FixtureOutput\result.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    $verifiedCleanup = ($result.runId -ceq $RunId -and $result.accountsRemoved -is [bool] -and $result.accountsRemoved -and $result.privateRemoved -is [bool] -and $result.privateRemoved)
    if ($info.LastTaskResult -ne 0 -or $result.passed -isnot [bool] -or !$result.passed -or !$verifiedCleanup) { throw 'Destination result or cleanup verification failed' }
    Write-Output 'Verified destination success; sanitized result preserved at C:\FixtureOutput\result.json'
} finally {
    try {
        if ($ownedTask) {
            $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\'
            if ($task.State -in @('Running','Queued')) {
                $verifiedCleanup = $false
                Stop-ScheduledTask -TaskName $taskName -TaskPath '\'
            }
            Unregister-ScheduledTask -TaskName $taskName -TaskPath '\' -Confirm:$false
        }
    } finally {
        if (!$verifiedCleanup) {
            Write-Warning 'Cleanup is not verified. Discard this disposable VM; do not reuse it. Fixture paths were not deleted.'
        }
    }
}
