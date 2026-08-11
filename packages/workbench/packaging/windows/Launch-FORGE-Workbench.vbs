Option Explicit
Dim shell, fileSystem, root, executable, url, urlFile, stream
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
root = fileSystem.GetParentFolderName(WScript.ScriptFullName)
executable = fileSystem.BuildPath(root, "FORGE-Workbench.exe")
url = "http://127.0.0.1:7334"
urlFile = fileSystem.BuildPath(root, "workbench.url")
If fileSystem.FileExists(urlFile) Then
  Set stream = fileSystem.OpenTextFile(urlFile, 1, False)
  url = Trim(stream.ReadAll)
  stream.Close
End If
shell.Run Chr(34) & executable & Chr(34), 0, False
WScript.Sleep 1800
shell.Run url, 1, False
