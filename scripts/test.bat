@echo off
setlocal

echo =======================================================
echo  ThreadShield Test Suite Runner
echo =======================================================

cd /d "%~dp0\.."

if not exist bin\scanner.exe (
    call scripts\build.bat
    if %errorlevel% neq 0 exit /b 1
)

node server\test_suite.js
exit /b %errorlevel%

