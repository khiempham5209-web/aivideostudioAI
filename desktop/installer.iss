; AI Video Studio — Windows installer.
; Build order: npm run build  ->  node scripts/prepare-desktop-build.mjs  ->  compile this with Inno Setup (ISCC.exe)
; Output: desktop\dist-installer\AI-Video-Studio-Setup.exe

#define MyAppName "AI Video Studio"
#define MyAppVersion "1.1.2"
#define MyAppExeDesc "AI Video Studio (local)"

[Setup]
AppId={{8F3B2C7A-6E1D-4B9A-9C2E-AIVIDEOSTUDIO1}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
DefaultDirName={autopf}\AI Video Studio
DefaultGroupName=AI Video Studio
DisableProgramGroupPage=yes
OutputDir=dist-installer
OutputBaseFilename=AI-Video-Studio-Setup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
; No code-signing certificate — Windows SmartScreen may warn on first run.
; Expected for a personal-use installer; user can "More info" -> "Run anyway".
PrivilegesRequired=lowest

[Files]
Source: "staging\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\AI Video Studio"; Filename: "wscript.exe"; Parameters: """{app}\hidden-launch.vbs"""; WorkingDir: "{app}"; Comment: "{#MyAppExeDesc}"
Name: "{autodesktop}\AI Video Studio"; Filename: "wscript.exe"; Parameters: """{app}\hidden-launch.vbs"""; WorkingDir: "{app}"; Comment: "{#MyAppExeDesc}"

[Run]
Filename: "wscript.exe"; Parameters: """{app}\hidden-launch.vbs"""; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent; Description: "Mo AI Video Studio ngay"
