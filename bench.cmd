@echo off
rem Convenience wrapper so `bench ...` works from a plain cmd prompt without a
rem global npm install. Everything is forwarded verbatim.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not on your PATH. Install the LTS build from https://nodejs.org/
  echo   winget install OpenJS.NodeJS.LTS
  exit /b 1
)
node "%~dp0bin\bench.mjs" %*
