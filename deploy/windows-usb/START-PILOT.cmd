@echo off
setlocal DisableDelayedExpansion
if not exist "%~dp0runtime\node.exe" (
  echo Extract the entire Jimmy Remote Commander USB folder before running this launcher.
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0portable-launcher.mjs" start
exit /b %errorlevel%
