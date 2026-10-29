@echo off
setlocal enabledelayedexpansion

echo =======================================================
echo  ThreadShield C++ Scanning Engine Build Script
echo  Operating Systems Concurrent Architecture Project
echo =======================================================

cd /d "%~dp0\.."

if not exist bin mkdir bin

set COMPILER=
if exist "%LOCALAPPDATA%\w64devkit\bin\g++.exe" (
    set COMPILER="%LOCALAPPDATA%\w64devkit\bin\g++.exe"
    goto FOUND
)

where g++ >nul 2>nul
if %errorlevel% equ 0 (
    set COMPILER=g++
    goto FOUND
)

where clang++ >nul 2>nul
if %errorlevel% equ 0 (
    set COMPILER=clang++
    goto FOUND
)

echo [ERROR] No modern C++17 compatible compiler found in PATH or w64devkit.
echo Please ensure g++ or clang++ is installed.
echo Suggested: Download w64devkit (https://github.com/skeeto/w64devkit)
exit /b 1

:FOUND
echo [INFO] Using compiler: %COMPILER%
echo [INFO] Compiling src/scanner.cpp -^> bin/scanner.exe (C++17, -O3, -pthread)...

%COMPILER% -std=c++17 -O3 -pthread src/scanner.cpp -o bin/scanner.exe
if %errorlevel% neq 0 (
    echo [ERROR] Compilation failed!
    exit /b %errorlevel%
)

echo [SUCCESS] Binary created successfully at bin/scanner.exe
bin\scanner.exe --help >nul 2>nul
exit /b 0

