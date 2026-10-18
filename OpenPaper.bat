@echo off
title OpenPaper
cd /d "%~dp0"

set "CLI=packages\server\dist\cli.js"
if defined OPENPAPER_HOME (set "SERVER_INFO=%OPENPAPER_HOME%\server.json") else (set "SERVER_INFO=%USERPROFILE%\.openpaper\server.json")
set "NEED_BUILD="

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20.19+ from https://nodejs.org and try again.
  pause
  exit /b 1
)

rem Dependencies are current when npm's install marker is newer than every package manifest.
call :up_to_date "node_modules\.package-lock.json" "package-lock.json,package.json,packages\core\package.json,packages\server\package.json,apps\editor\package.json"
if errorlevel 1 (
  call :stop_server
  echo Installing dependencies...
  call npm install || goto :fail
  set "NEED_BUILD=1"
)

rem The build is current when dist\cli.js is newer than every source file.
if not defined NEED_BUILD (
  call :up_to_date "%CLI%" "packages\core\src,packages\server\src,packages\server\scripts,apps\editor\src,apps\editor\public,apps\editor\index.html,apps\editor\vite.config.ts"
  if errorlevel 1 set "NEED_BUILD=1"
)
if defined NEED_BUILD (
  call :stop_server
  echo Building the latest version of OpenPaper...
  call npm run build || goto :fail
)

rem A server started before the current build is running old code, so restart it.
call :up_to_date "%SERVER_INFO%" "%CLI%"
if errorlevel 1 call :stop_server

call npm start || goto :fail
exit /b 0

:fail
echo.
echo OpenPaper failed to start. See the messages above.
pause
exit /b 1

rem ---------------------------------------------------------------------------

:up_to_date
rem Usage: call :up_to_date "target" "source1,source2,..."
rem Exit code 0 when the target exists and no source file or folder is newer than it.
set "OP_TARGET=%~1"
set "OP_SOURCES=%~2"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$t = Get-Item -LiteralPath $env:OP_TARGET -ErrorAction SilentlyContinue; if (-not $t) { exit 1 };" ^
  "$paths = $env:OP_SOURCES -split ',' | Where-Object { Test-Path -LiteralPath $_ };" ^
  "$newer = @(Get-Item -LiteralPath $paths) + @(Get-ChildItem -LiteralPath $paths -Recurse -Force -ErrorAction SilentlyContinue) | Where-Object { $_.LastWriteTime -gt $t.LastWriteTime } | Select-Object -First 1;" ^
  "if ($newer) { exit 1 } else { exit 0 }"
exit /b %errorlevel%

:stop_server
rem Stop a running OpenPaper server and wait (up to ~20s) until it has exited.
if not exist "%CLI%" exit /b 0
node "%CLI%" status >nul 2>nul || exit /b 0
echo Stopping the running OpenPaper server (it is on an older build)...
node "%CLI%" stop >nul
for /l %%i in (1,1,20) do (
  node "%CLI%" status >nul 2>nul || exit /b 0
  ping -n 2 127.0.0.1 >nul
)
echo Warning: the old server did not stop in time.
exit /b 0
