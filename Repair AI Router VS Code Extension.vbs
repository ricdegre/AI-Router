Option Explicit
Dim shell, fso, root, command, process, output
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
command = "node """ & fso.BuildPath(root, "scripts\vscode-extension-manager.js") & """ repair"
Set process = shell.Exec(command)
Do While process.Status = 0
  WScript.Sleep 250
Loop
output = Trim(process.StdOut.ReadAll & vbCrLf & process.StdErr.ReadAll)
If process.ExitCode = 0 Then
  MsgBox output, vbInformation, "AI Router VS Code Extension"
Else
  MsgBox output, vbCritical, "AI Router VS Code Extension - Repair failed"
End If
