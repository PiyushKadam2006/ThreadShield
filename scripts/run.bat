@echo off
setlocal

echo =======================================================
echo  ThreadShield — Multithreaded File Scanner Runner
echo =======================================================

cd /d "%~dp0\.."

if not exist bin\scanner.exe (
    echo [INFO] Scanner executable not found. Running build script...
    call scripts\build.bat
    if %errorlevel% neq 0 (
        echo [ERROR] Build failed. Cannot start application.
        pause
        exit /b 1
    )
)

if not exist node_modules (
    echo [INFO] Installing required Node.js packages...
    call npm.cmd install
)

if not exist samples (
    echo [INFO] Generating initial test sample dataset...
    call node server\sample_generator.js
)

echo [INFO] Launching ThreadShield Dashboard on http://127.0.0.1:3000...
start http://127.0.0.1:3000
node server\server.js

