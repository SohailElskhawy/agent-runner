@echo off
if "%~1"=="--version" (
  echo fake opencode 1.0.0
  exit /b 0
)
node "%~dp0fake-opencode.mjs" %*
