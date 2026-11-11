@echo off
echo === inspired x : Mars Guide chatbot (port 3000) + website server (port 8000) ===
where node >nul 2>nul || (echo Node.js 20+ is required: https://nodejs.org & pause & exit /b 1)
cd /d "%~dp0chatbot"
if not exist .env (copy .env.example .env >nul & echo. & echo Created chatbot\.env  - OPEN IT, choose AI_PROVIDER and paste your API key, then run this file again. & notepad .env & pause & exit /b 0)
if not exist node_modules (echo Installing chatbot packages... & call npm install)
start "Mars Guide chatbot (port 3000)" cmd /k npm start
cd /d "%~dp0"
echo Installing Python packages...
pip install rasterio numpy pillow
python server.py
pause
