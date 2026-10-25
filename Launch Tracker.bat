@echo off
setlocal EnableExtensions
rem ============================================================
rem  Character Tracker - Launch Tracker  [rebuilt 2026-10-25]
rem  Starts the standalone server. Optionally opens a Cloudflare
rem  quick tunnel so others can visit your sheet over https.
rem  No account needed; the link is ephemeral and dies with this
rem  window. Data lives in the .\data folder next to this file.
rem ============================================================

set "PORT=5173"
set "NODE=%~dp0node\node.exe"
set "CF=%~dp0cloudflared\cloudflared.exe"
set "TLOG=%~dp0cloudflared-tunnel.log"
set "UFILE=cf-tunnel-url.txt"
set "CT_NO_BROWSER=1"
cd /d "%~dp0"

echo ============================================
echo   Character Tracker - standalone server
echo ============================================
echo.

rem ---- resolve node: bundled folder first, then system ----
if exist "%NODE%" goto node_resolved
set "NODE=node"
where node >nul 2>nul
if not errorlevel 1 goto node_resolved
echo [error] node was not found. Keep the bundled node folder next to this file.
pause
exit /b 1
:node_resolved

rem ---- resolve cloudflared: local folder first, then PATH ----
set "HAVECF=0"
if exist "%CF%" goto cf_resolved
where cloudflared >nul 2>nul
if errorlevel 1 goto cf_missing
set "CF=cloudflared"
goto cf_resolved
:cf_missing
echo [i] cloudflared was not found - the sharing tunnel needs it.
echo     It can be downloaded from the official GitHub release
echo     [about 15 MB, into the cloudflared folder].
set "ANSWER="
set /p ANSWER=Install cloudflared now? [Y/N]
if /i not "%ANSWER:~0,1%"=="Y" goto cf_skip
set "ARCH=amd64"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if not exist "%~dp0cloudflared" mkdir "%~dp0cloudflared"
echo Downloading cloudflared for %ARCH% ...
curl -L -o "%~dp0cloudflared\cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-%ARCH%.exe"
if exist "%~dp0cloudflared\cloudflared.exe" goto cf_installed
echo Download failed - continuing without sharing support.
goto cf_skip
:cf_installed
echo Installed.
:cf_resolved
set "HAVECF=1"

:share_prompt
echo.
set "ANSWER="
set /p ANSWER=Open a sharing tunnel? [Y/N]
if /i not "%ANSWER:~0,1%"=="Y" goto noshare
if "%HAVECF%"=="0" (
  echo [!] No cloudflared available - starting local-only.
  goto noshare
)

rem ---- start the tunnel in a minimized window; log merges stderr ----
echo Starting tunnel, this takes a few seconds ...
del "%UFILE%" >nul 2>nul
del "%TLOG%" >nul 2>nul
start "cf" /min cmd /c ""%CF%" tunnel --url http://localhost:%PORT% > "%TLOG%" 2>&1"

rem ---- poll the log for the link [one PowerShell call writes UFILE] ----
powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){ if(Test-Path '%TLOG%'){ $m=Select-String -Path '%TLOG%' -Pattern 'https://\S+\.trycloudflare\.com' | Select-Object -First 1; if($m){ Set-Content -Path 'cf-tunnel-url.txt' -Value $m.Matches[0].Value -NoNewline; break } }; Start-Sleep 1 }"

set "TUNNEL_URL="
if exist %UFILE% set /p TUNNEL_URL= <%UFILE%
echo.
if defined TUNNEL_URL goto linkshow
echo [!] No tunnel link appeared yet - see the minimized window log: %TLOG%
goto serve
:linkshow
clip < %UFILE%
title CT tunnel: %TUNNEL_URL%
echo --------------------------------------------------
echo   Share link  %TUNNEL_URL%
echo   Copied to clipboard - paste anywhere with Ctrl+V.
echo   Also saved in  cf-tunnel-url.txt  next to this file.
echo   Keep this window open - closing it ends the link.
echo --------------------------------------------------
goto serve

:noshare
echo.
echo Local only:  http://localhost:%PORT%

:serve
echo Starting the server ...
start "" http://localhost:%PORT%
"%NODE%" server.mjs --port %PORT%

rem ---- server exited: end ONLY the tunnel process we started ----
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cloudflared.exe' -and $_.CommandLine -match 'http://localhost:%PORT%' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo.
echo Server stopped. Tunnel closed if one was open.
pause
