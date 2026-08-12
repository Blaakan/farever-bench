@echo off
rem Open the bench UI in your own browser, with no Electron download and no
rem unsigned binary to talk Windows into running. Needs Node.js and your own
rem copy of Farever; everything else is forwarded verbatim, so
rem `bench-ui --game "D:\SteamLibrary\steamapps\common\Farever"` works, as does
rem `bench-ui --port 8080`. This is `bench ui --open` and nothing else.
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not on your PATH. Install the LTS build from https://nodejs.org/
  echo   winget install OpenJS.NodeJS.LTS
  goto :failed
)
node "%~dp0bin\bench.mjs" ui --open %*
if errorlevel 1 goto :failed
exit /b 0

:failed
rem Double-clicked from Explorer, the console window belongs to this script and
rem closes the instant it ends - taking the only line that says what went wrong
rem with it. So the last thing a failure does is wait. `pause` returns straight
rem away when stdin is not a console, so a script that calls this does not hang.
echo.
pause
exit /b 1
