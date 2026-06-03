@echo off
cd /d "%~dp0"

if not exist "node_modules" (
  echo Installing dependencies (one time)...
  call npm install
)

echo Starting menu editor...
start cmd /k node server.js

timeout /t 3 >nul

echo Opening editor...
start http://localhost:4001/

echo Done!
