@echo off
title JARVIS - Sistema Holografico Stark
color 0B

echo ===================================================================
echo                     JARVIS PROTOCOL
echo             Just A Rather Very Intelligent System
echo                      Personal AI Co-Pilot
echo                       Autor: Tassio Sales
echo ===================================================================
echo.

cd /d "%~dp0"

echo [1/3] Iniciando Bridge WebSocket na porta 8787...
start "JARVIS Bridge" cmd /c "node bridge/server.mjs"

echo.
echo [2/3] Iniciando Interface 3D na porta 5173...
start "JARVIS Web" cmd /c "npm run dev"

echo.
echo [3/3] Aguardando inicializacao dos servidores...
ping 127.0.0.1 -n 5 > nul

echo.
echo Abrindo JARVIS no navegador...

if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --app=http://localhost:5173 --start-maximized
) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --app=http://localhost:5173 --start-maximized
) else (
    start http://localhost:5173
)

echo.
echo ===================================================================
echo   JARVIS ONLINE. Clique em INITIALISE na tela.
echo ===================================================================
echo.
pause
