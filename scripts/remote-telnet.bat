@echo off
REM remote-telnet.bat — dibuka browser via telnet://ip (butuh install-remote-handlers.bat sekali)
set T=%~1
set T=%T:telnet://=%
set T=%T:/=%
if exist "%ProgramFiles%\PuTTY\putty.exe" start "Telnet %T%" "%ProgramFiles%\PuTTY\putty.exe" -telnet %T% & goto :eof
if exist "%ProgramFiles(x86)%\PuTTY\putty.exe" start "Telnet %T%" "%ProgramFiles(x86)%\PuTTY\putty.exe" -telnet %T% & goto :eof
where putty.exe >nul 2>&1
if %errorlevel%==0 start "Telnet %T%" putty.exe -telnet %T% & goto :eof
where telnet >nul 2>&1
if %errorlevel%==0 start "Telnet %T%" cmd /k telnet %T% & goto :eof
echo PuTTY dan Telnet Client tidak ketemu.
echo Pilihan: install PuTTY, atau nyalakan fitur Windows "Telnet Client", lalu ulangi.
pause
