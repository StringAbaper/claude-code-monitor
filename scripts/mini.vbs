' Starts scripts/mini.ps1 with no window. Launched by lib/mini.js.
' Windows PowerShell cannot start without a console: spawned detached from
' Node it gets none and exits at once, code 0, having run nothing. Run from
' here with window style 0, it gets a console that is simply hidden.
Set fso = CreateObject("Scripting.FileSystemObject")
ps1 = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "mini.ps1")
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -STA -WindowStyle Hidden -File """ & ps1 & """", 0, False
