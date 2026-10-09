@echo off
rem Liga o JARVIS: sobe a ponte e a interface e abre uma janela em cada monitor.
rem   Jarvis.cmd            interface principal + paineis nos outros monitores
rem   Jarvis.cmd -MainOnly  so a interface principal
cd /d "%~dp0"

rem So sobe os servidores se ainda nao estiverem rodando.
powershell -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  start "JARVIS" /min cmd /c "npm start"
  timeout /t 6 /nobreak >nul
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-windows.ps1" %*
