@echo off
echo Stopping existing proxy on port 8080...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

echo Starting Gemini Proxy silently...
wscript "%~dp0run-silent.vbs"

echo Proxy restarted successfully!
timeout /t 2 >nul