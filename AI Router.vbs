Option Explicit
Dim shell, fso, root, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /d /c ""cd /d """ & root & """ && node scripts\windows-launcher.js start"""
shell.Run command, 0, False
