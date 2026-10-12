@echo off
REM start-collector.bat — jalanin collector + restart otomatis kalau mati.
cd /d "%~dp0"
:loop
echo [%date% %time%] starting netmon-collector...
node server.js
echo [%date% %time%] mati (exit %errorlevel%), restart 3 dtk...
timeout /t 3 /nobreak >nul
goto loop
