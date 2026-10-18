@echo off
rem Liga o JARVIS: sobe a ponte e a interface e abre uma janela em cada monitor.
rem   Jarvis.cmd            interface principal + paineis nos outros monitores
rem   Jarvis.cmd -MainOnly  so a interface principal
rem   Jarvis.cmd -Auto      liga sozinho, sem esperar o clique em INICIAR
cd /d "%~dp0"

rem Os dois servidores precisam estar no ar juntos. Se so um sobrou de uma
rem execucao anterior (janela fechada, queda), ele e encerrado para que a nova
rem partida nao esbarre numa porta ocupada.
powershell -NoProfile -Command "$b = [bool](Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue); $f = [bool](Get-NetTCPConnection -State Listen -LocalPort 5173 -ErrorAction SilentlyContinue); if ($b -and $f) { exit 0 }; Get-NetTCPConnection -State Listen -LocalPort 8787,5173,8790 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }; exit 1"
if errorlevel 1 (
  start "JARVIS" /min cmd /c "npm start"
  timeout /t 7 /nobreak >nul
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\open-windows.ps1" %*
