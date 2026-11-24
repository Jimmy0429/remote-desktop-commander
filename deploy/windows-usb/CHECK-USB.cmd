@echo off
setlocal DisableDelayedExpansion
if defined NODE_OPTIONS goto custom_node
if defined NODE_PATH goto custom_node
if not exist "%~dp0runtime\node.exe" (
  echo Extract the entire Jimmy Remote Commander USB folder before running this launcher.
  exit /b 1
)
"%~dp0runtime\node.exe" "%~dp0portable-launcher.mjs" check
if errorlevel 1 exit /b 1
exit /b 0

:custom_node
echo The USB pilot detected a customized Node environment.
echo Ask IT to review NODE_OPTIONS and NODE_PATH before running this package.
exit /b 1
