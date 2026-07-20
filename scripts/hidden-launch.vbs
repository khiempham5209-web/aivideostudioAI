' Double-click this file (or a shortcut to it) to start AI Video Studio with
' no visible console window, then open it in your default browser.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = fso.BuildPath(scriptDir, "launch-desktop.mjs")

Set shell = CreateObject("WScript.Shell")
' 0 = hidden window, False = don't wait for it to finish
shell.Run "node """ & launcher & """", 0, False
