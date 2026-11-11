@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto nonode
echo [EXAONE Code] Registering the "exaone" command...
call npm link
if errorlevel 1 goto failed
echo.
echo [EXAONE Code] Done. Open a NEW terminal, go to any folder and run:  exaone
pause
exit /b 0
:nonode
echo [EXAONE Code] Node.js 22.12 or newer is required. Install it from https://nodejs.org and run this file again.
pause
exit /b 1
:failed
echo [EXAONE Code] npm link failed. See the messages above.
pause
exit /b 1
