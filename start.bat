@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
if exist "node_modules\electron\package.json" goto run
echo [EXAONE Desktop] Installing dependencies. First run only...
call npm install
if errorlevel 1 goto failed
:run
echo [EXAONE Desktop] Starting. The first launch downloads the Electron runtime, which can take a minute.
call npm start
if errorlevel 1 goto failed
exit /b 0
:nonode
echo [EXAONE Desktop] Node.js 22.12 or newer is required. Install it from https://nodejs.org and run this file again.
pause
exit /b 1
:failed
echo [EXAONE Desktop] Something went wrong. See the messages above.
pause
exit /b 1
