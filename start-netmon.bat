@echo off
REM start-netmon.bat — satu klik jalan semua: collector + dashboard Netmon - Router AI.
cd /d "%~dp0"
REM 1) collector (cuma nyalain kalau port 8932 masih bebas)
netstat -ano | findstr "LISTENING" | findstr ":8932 " >nul
if %errorlevel%==0 (
  echo [netmon] collector sudah jalan di :8932, skip start.
) else (
  echo [netmon] menyalakan collector...
  start "netmon-collector" /min node "collector\server.js"
  timeout /t 3 /nobreak >nul
)
REM 2) dashboard
echo [netmon] buka dashboard...
start "" "index.html"
echo [netmon] beres. Jangan tutup window netmon-collector kalau masih mantau.
