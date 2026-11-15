@echo off
netstat -ano | findstr LISTENING | findstr :8080 >nul 2>&1
if errorlevel 1 (
    wscript "%~dp0run-silent.vbs"
    ping 127.0.0.1 -n 2 >nul
)
start "" pythonw "%~dp0widget.py"




