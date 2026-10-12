@echo off
REM remote-winbox.bat — dibuka browser via winbox://ip (butuh install-remote-handlers.bat sekali)
REM Cari winbox64.exe di lokasi umum; kalau tidak ada, tawarkan download.
setlocal EnableDelayedExpansion
set T=%~1
set T=%T:winbox://=%
set T=%T:/=%

set WB=
for %%P in (
  "%ProgramFiles%\WinBox\winbox64.exe"
  "%ProgramFiles%\WinBox\winbox.exe"
  "%ProgramFiles(x86)%\WinBox\winbox64.exe"
  "%ProgramFiles(x86)%\WinBox\winbox.exe"
  "%LOCALAPPDATA%\WinBox\winbox64.exe"
  "%LOCALAPPDATA%\Programs\WinBox\winbox64.exe"
  "%USERPROFILE%\Downloads\winbox64.exe"
  "%USERPROFILE%\Downloads\WinBox\winbox64.exe"
  "%USERPROFILE%\Desktop\winbox64.exe"
) do (
  if not defined WB if exist %%P set WB=%%P
)

if not defined WB (
  where winbox64.exe >nul 2>&1 && set WB=winbox64.exe
)
if not defined WB (
  where winbox.exe >nul 2>&1 && set WB=winbox.exe
)

if defined WB (
  echo Menjalankan WinBox: %WB%  IP: %T%
  start "WinBox %T%" "%WB%" %T%
  goto :eof
)

echo.
echo WinBox tidak ketemu di mesin ini.
echo.
echo   1. Download WinBox dari situs resmi MikroTik
echo   2. Buka file .exe-nya, sambungkan ke: %T%
echo.
choice /c YN /m "Buka halaman download WinBox sekarang"
if errorlevel 2 goto :eof
start "" "https://mikrotik.com/download"
