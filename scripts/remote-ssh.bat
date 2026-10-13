@echo off
REM remote-ssh.bat — dibuka browser via ssh://user@ip atau ssh://ip (butuh install-remote-handlers.bat sekali)
set T=%~1
set T=%T:ssh://=%
set T=%T:/=%
start "SSH %T%" cmd /k ssh %T%
