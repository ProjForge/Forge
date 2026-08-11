Option Explicit

Dim shell, fileSystem, scriptDirectory, launcher, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
launcher = fileSystem.BuildPath(scriptDirectory, "run-qwen.ps1")

command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & launcher & """"
exitCode = shell.Run(command, 0, True)

WScript.Quit exitCode
