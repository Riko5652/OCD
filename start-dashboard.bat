@echo off
:: OCD Dashboard auto-start script
:: Starts the OCD dashboard server on port 3030
:: Can be added to Windows Task Scheduler for auto-start on login

title OCD Dashboard (port 3030)

cd /d C:\Projects\OCD

:: Check if port 3030 is already in use
netstat -ano | findstr ":3030.*LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo [OCD] Dashboard already running on port 3030. Exiting.
    exit /b 0
)

echo [OCD] Starting dashboard on http://localhost:3030 ...
cd /d C:\Projects\OCD\apps\server
npx tsx watch --env-file=../../.env src/index.ts
