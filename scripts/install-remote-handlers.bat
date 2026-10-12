@echo off
REM install-remote-handlers.bat — SEKALI saja per mesin (HKCU, tanpa admin).
REM Daftarkan ssh:// telnet:// winbox:// biar klik-kanan Remote di NetMon langsung buka app.
cd /d "%~dp0"
call :reg ssh "%CD%\remote-ssh.bat" "URL:SSH"
call :reg telnet "%CD%\remote-telnet.bat" "URL:Telnet"
call :reg winbox "%CD%\remote-winbox.bat" "URL:WinBox"
echo.
echo Beres. Coba di browser: klik kanan node - Remote - SSH/Telnet/Winbox.
echo (PuTTY/WinBox/ssh harus sudah terinstall. Login diketik manual, tidak disimpan.)
pause
goto :eof
:reg
reg add "HKCU\Software\Classes\%~1" /ve /d "%~3" /f >nul
reg add "HKCU\Software\Classes\%~1" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\%~1\shell\open\command" /ve /d "\"%~2\" \"%%1\"" /f >nul
echo + %~1
goto :eof
