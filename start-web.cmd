@echo off
cd /d "%~dp0"
echo Starting AI Auto Video Studio at http://127.0.0.1:8787
echo Keep this window open while using the web app.
echo.
set NODE_NO_WARNINGS=1
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm.cmd was not found in PATH.
  echo Please install Node.js or run this from a terminal that has npm.
  pause
  exit /b 1
)
npm.cmd run api
echo.
echo Server stopped or failed to start. Check the message above.
pause
