@echo off
REM remote-winbox.bat — dibuka browser via winbox://ip (butuh install-remote-handlers.bat sekali)
set T=%~1
set T=%T:winbox://=%
set T=%T:/=%
set WB=
if exist "%ProgramFiles%\WinBox\winbox64.exe" set WB=%ProgramFiles%\WinBox\winbox64.exe
if not defined WB if exist "%ProgramFiles%\WinBox\winbox.exe" set WB=%ProgramFiles%\WinBox\winbox.exe
if not defined WB if exist "%ProgramFiles(x86)%\WinBox\winbox64.exe" set WB=%ProgramFiles(x86)%\WinBox\winbox64.exe
if not defined WB if exist "%LOCALAPPDATA%\WinBox\winbox64.exe" set WB=%LOCALAPPDATA%\WinBox\winbox64.exe
if defined WB start "WinBox %T%" "%WB%" %T% & goto :eof
echo winbox64.exe tidak ketemu. Install WinBox dulu, lalu ulangi.
pause
