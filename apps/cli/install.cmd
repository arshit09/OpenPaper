@echo off
rem Install the OpenPaper CLI from Command Prompt.
rem
rem   curl -fsSL https://github.com/arshit09/OpenPaper/releases/latest/download/install.cmd -o install.cmd && install.cmd && del install.cmd
rem
rem It runs install.ps1 (same folder of the same release) with Windows PowerShell, which every Windows 10 and 11 PC
rem has. The environment variables install.ps1 documents work here too; OPENPAPER_INSTALL_PS1 points at another copy.
setlocal
if not defined OPENPAPER_INSTALL_PS1 set "OPENPAPER_INSTALL_PS1=https://github.com/arshit09/OpenPaper/releases/latest/download/install.ps1"
set "OPENPAPER_INSTALL_CMD=1"
rem Started from PowerShell 7, the inherited module path would point Windows PowerShell at 7's modules.
set "PSModulePath="
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; Invoke-Expression (Invoke-RestMethod -UseBasicParsing $env:OPENPAPER_INSTALL_PS1)"
exit /b %errorlevel%
