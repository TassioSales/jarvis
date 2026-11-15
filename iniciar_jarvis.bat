@echo off
setlocal enabledelayedexpansion
title JARVIS_Launcher
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
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 8787,5173 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"

echo.
echo [2/4] Iniciando Bridge WebSocket na porta 8787...
start "JARVIS_Bridge_Node" /min cmd /c "node bridge/server.mjs"

echo.
echo [3/4] Iniciando Interface 3D na porta 5173...
start "JARVIS_Vite_Web" /min cmd /c "npm run dev"

echo.
echo [4/4] Aguardando servidores ficarem prontos...
powershell -NoProfile -Command "$deadline = (Get-Date).AddSeconds(20); while ((Get-Date) -lt $deadline) { $b = [bool](Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue); $v = [bool](Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue); if ($b -and $v) { exit 0 }; Start-Sleep -Milliseconds 400 }; exit 1"

if errorlevel 1 (
    echo [AVISO] Tempo limite de espera atingido, tentando abrir monitores assim mesmo...
) else (
    echo [OK] Bridge e Interface 3D online e respondendo com sucesso!
)

echo.
echo Abrindo JARVIS nos seus 3 monitores...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-windows.ps1"

echo.
echo ===================================================================
echo   JARVIS ONLINE EM TODOS OS 3 MONITORES!
echo   Clique em INITIALISE no monitor principal e diga: 'Hey Jarvis'
echo ===================================================================
echo.
pause
