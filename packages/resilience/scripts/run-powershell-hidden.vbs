Option Explicit

Dim shell, command, index, exitCode

If WScript.Arguments.Count < 1 Then WScript.Quit 64

Set shell = CreateObject("WScript.Shell")
command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & QuoteArgument(WScript.Arguments(0))

For index = 1 To WScript.Arguments.Count - 1
    command = command & " " & QuoteArgument(WScript.Arguments(index))
Next

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode

Function QuoteArgument(value)
    If InStr(value, Chr(34)) > 0 Then WScript.Quit 64
    QuoteArgument = Chr(34) & value & Chr(34)
End Function
