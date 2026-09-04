; AI Video Studio — Windows installer.
; Build order:
;   npm run build
;   node scripts/prepare-desktop-build.mjs
;   npx @electron/packager desktop/staging "AI Video Studio" --platform=win32 --arch=x64 --out=desktop/electron-dist --overwrite --no-asar --icon=desktop/icon.ico
;   compile this with Inno Setup (ISCC.exe)
; Output: desktop\dist-installer\AI-Video-Studio-Setup.exe
;
; Packages the real native Electron build (electron-dist\AI Video Studio-win32-x64)
; — not the old wscript+node+Edge-app-mode launcher this used to ship. That
; approach always showed up as Microsoft Edge everywhere it mattered (taskbar,
; Task Manager, Alt-Tab); this is a genuine standalone .exe with its own icon.

#define MyAppName "AI Video Studio"
#define MyAppVersion "1.1.14"
#define MyAppExeDesc "AI Video Studio"
#define MyAppExeName "AI Video Studio.exe"

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
; A previous install's app.exe (and its background server, kept alive by the
; system-tray "close hides instead of quits" behavior) can still be running
; and holding files open during an upgrade — ask Windows to close it first
; instead of the install just failing partway through with a file-lock error.
CloseApplications=yes
RestartApplications=no
SetupIconFile=..\desktop\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}

[Files]
Source: "electron-dist\AI Video Studio-win32-x64\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\AI Video Studio"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Comment: "{#MyAppExeDesc}"
Name: "{autodesktop}\AI Video Studio"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Comment: "{#MyAppExeDesc}"

[Run]
Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Flags: postinstall nowait skipifsilent; Description: "Mo AI Video Studio ngay"
