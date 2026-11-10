@echo off
rem Moyu launcher (development mode: runs the source in this folder)
cd /d "%~dp0"
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" . %*
) else if exist "dist\Moyu-win32-x64\Moyu.exe" (
  start "" "dist\Moyu-win32-x64\Moyu.exe" %*
) else (
  echo Please run: npm install
  pause
)
