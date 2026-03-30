@echo off
REM ============================================================
REM  OCD — Build + Start Dashboard + Verify MCP
REM  Double-click this file to rebuild and launch everything.
REM ============================================================

title OCD Dashboard Launcher
cd /d "C:\Projects\OCD"

echo.
echo  ====================================
echo   OCD Dashboard Launcher
echo  ====================================
echo.

REM ── Step 1: Build server (TypeScript → dist/) ─────────────
echo [1/5] Building server...
call pnpm --filter ./apps/server run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Server build failed!
    pause
    exit /b 1
)
echo       Server build OK

REM ── Step 2: Build client (Vite → dist/) ───────────────────
echo [2/5] Building client...
call pnpm --filter ./apps/client run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Client build failed!
    pause
    exit /b 1
)
echo       Client build OK

REM ── Step 3: Kill any existing dashboard on port 3030 ──────
echo [3/5] Checking for existing dashboard...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3030.*LISTENING" 2^>nul') do (
    echo       Stopping old dashboard (PID %%a)...
    taskkill /PID %%a /F >nul 2>&1
)

REM ── Step 4: Start dashboard ───────────────────────────────
echo [4/5] Starting dashboard on http://localhost:3030 ...
start "OCD Dashboard" /min cmd /c "cd /d C:\Projects\OCD && node apps/server/dist/index.js"

REM Wait for it to come up
timeout /t 3 /nobreak >nul

REM Verify it's running
curl -s -o nul -w "%%{http_code}" http://localhost:3030/ > "%TEMP%\ocd-check.txt" 2>nul
set /p STATUS=<"%TEMP%\ocd-check.txt"
del "%TEMP%\ocd-check.txt" 2>nul

if "%STATUS%"=="200" (
    echo       Dashboard running at http://localhost:3030
) else (
    echo       Dashboard may still be starting... check http://localhost:3030
)

REM ── Step 5: Verify MCP is configured ──────────────────────
echo [5/5] Checking MCP configuration...
findstr /C:"ocd" "C:\Projects\pm-dashboard\.mcp.json" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo       MCP configured in pm-dashboard
) else (
    echo [WARN] MCP not found in pm-dashboard\.mcp.json
)

echo.
echo  ====================================
echo   All done!
echo  ====================================
echo.
echo   Dashboard:  http://localhost:3030
echo   MCP:        Active (auto-spawned by Claude Code per session)
echo.
echo   The MCP runs your LOCAL source via tsx fallback,
echo   so code changes take effect on next Claude Code session.
echo   The dashboard uses the built dist/ files.
echo.
echo   Press any key to open the dashboard in your browser...
pause >nul
start http://localhost:3030
