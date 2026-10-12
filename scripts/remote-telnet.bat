@echo off
REM remote-telnet.bat — dibuka browser via telnet://ip (butuh install-remote-handlers.bat sekali)
REM PuTTY kalau ada (mode telnet), kalau tidak pakai telnet.exe bawaan Windows.
set T=%~1
set T=%T:telnet://=%
set T=%T:/=%
if exist "%ProgramFiles%\PuTTY\putty.exe" start "Telnet %T%" "%ProgramFiles%\PuTTY\putty.exe" -telnet %T% & goto :eof
if exist "%ProgramFiles(x86)%\PuTTY\putty.exe" start "Telnet %T%" "%ProgramFiles(x86)%\PuTTY\putty.exe" -telnet %T% & goto :eof
where putty.exe >nul 2>&1
if %errorlevel%==0 start "Telnet %T%" putty.exe -telnet %T% & goto :eof
where telnet >nul 2>&1
if %errorlevel%==0 start "Telnet %T%" cmd /k telnet %T% & goto :eof
echo.
echo Telnet client tidak ketemu.
echo   Opsi 1 (bawaan Windows): aktifkan fitur "Telnet Client" lewat Control Panel - Program - Turn Windows features on/off
echo   Opsi 2: install PuTTY dari https://www.putty.org
echo.
pause
