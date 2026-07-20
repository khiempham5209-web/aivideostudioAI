' Packaged (installed) version of scripts/hidden-launch.vbs — uses the
' portable node.exe bundled next to this file instead of relying on a
' system-wide Node.js install, since end users won't have Node installed.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = fso.BuildPath(scriptDir, "node\node.exe")
launcher = fso.BuildPath(scriptDir, "scripts\launch-desktop.mjs")

Set shell = CreateObject("WScript.Shell")
' 0 = hidden window, False = don't wait for it to finish
shell.Run """" & nodeExe & """ """ & launcher & """", 0, False
