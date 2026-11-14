@echo off
chcp 65001 > nul
title J.A.R.V.I.S. — Holographic Iron Man AI Assistant
color 0B

echo ===================================================================
echo                     ⚡ J.A.R.V.I.S. PROTOCOL ⚡
echo             Just A Rather Very Intelligent System
echo                      Personal AI Co-Pilot
echo                       Autor: Tássio Sales
echo ===================================================================
echo.

cd /d "%~dp0"

echo [1/3] Iniciando o Cérebro Neural (Bridge WebSocket na porta 8787)...
start /b cmd /c "node bridge/server.mjs"

echo.
echo [2/3] Iniciando o Rosto Holográfico 3D (Vite Frontend na porta 5173)...
start /b cmd /c "npm run dev"

echo.
echo [3/3] Aguardando compilação do Three.js...
timeout /t 4 /nobreak > nul

echo.
echo [✓] Abrindo J.A.R.V.I.S. em Modo Holográfico sem bordas...

REM Tenta abrir no Chrome em modo Aplicativo de tela cheia
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:5173 --start-maximized
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --app=http://localhost:5173 --start-maximized
) else (
    start http://localhost:5173
)

echo.
echo ===================================================================
echo   J.A.R.V.I.S. ONLINE. Clique em 'INITIALISE' e diga: "Hey Jarvis"
echo ===================================================================
echo.
pause
