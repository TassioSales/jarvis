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

echo [1/4] Liberando portas 8787 e 5173...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8787 ^| findstr LISTENING') do taskkill /f /pid %%a > nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :5173 ^| findstr LISTENING') do taskkill /f /pid %%a > nul 2>&1

echo.
echo [2/4] Iniciando Bridge WebSocket na porta 8787...
start "JARVIS Bridge" cmd /c "node bridge/server.mjs"

echo.
echo [3/4] Iniciando Interface 3D na porta 5173...
start "JARVIS Web" cmd /c "npm run dev"

echo.
echo [4/4] Aguardando inicializacao completa das portas 8787 e 5173...
set /a attempts=0

:check_ports
set /a attempts+=1
if %attempts% gtr 30 goto ports_timeout
ping 127.0.0.1 -n 2 > nul

netstat -an | findstr 127.0.0.1:8787 | findstr LISTENING > nul
if errorlevel 1 goto check_ports

netstat -an | findstr 127.0.0.1:5173 | findstr LISTENING > nul
if errorlevel 1 goto check_ports

echo [OK] Subsistemas online e portas ativas!
goto launch_windows

:ports_timeout
echo [AVISO] Tempo limite de espera atingido, tentando abrir monitores...

:launch_windows
echo.
echo Abrindo JARVIS nos seus 3 monitores...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-windows.ps1"

echo.
echo ===================================================================
echo   JARVIS ONLINE EM TODOS OS MONITORES. Clique em INITIALISE na tela.
echo ===================================================================
echo.
pause
