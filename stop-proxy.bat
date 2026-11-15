@echo off
echo Stopping proxy on port 8080...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 ^| findstr LISTENING') do (
    taskkill /f /pid %%a >nul 2>&1
    echo Process %%a terminated.
)
echo Proxy stopped successfully!
timeout /t 2 >nul