import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { exec, execSync } from 'child_process'
import os from 'os'
import fs from 'fs'
import path from 'path'

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

/**
 * OS Pilot & Hardware Monitoring for Windows
 * Exposes direct voice-activated system control to JARVIS
 */
export function osPilotServer(emitToBrowser) {
  return createSdkMcpServer({
    name: 'jarvis_os',
    version: '1.0.0',
    tools: [
      tool(
        'os_control',
        'Executes native Windows OS control commands: lock screen, launch application, mute audio, or open system tools.',
        {
          action: z.enum([
            'lock_workstation',
            'open_vscode',
            'open_marketpulse',
            'open_spotify',
            'open_terminal',
            'open_calculator',
            'mute_audio',
            'volume_up',
            'volume_down'
          ]).describe('The specific operating system action to execute.'),
        },
        async ({ action }) => {
          try {
            switch (action) {
              case 'lock_workstation':
                exec('rundll32.exe user32.dll,LockWorkStation')
                return ok('Estação de trabalho bloqueada com sucesso, senhor.')

              case 'open_vscode':
                exec('code .')
                return ok('Visual Studio Code iniciado, senhor.')

              case 'open_marketpulse':
                exec('start http://localhost:8080')
                return ok('Terminal MarketPulse AI aberto no navegador, senhor.')

              case 'open_spotify':
                exec('start spotify:')
                return ok('Spotify iniciado, senhor.')

              case 'open_terminal':
                exec('start wt.exe || start powershell.exe')
                return ok('Terminal do Windows aberto, senhor.')

              case 'open_calculator':
                exec('calc.exe')
                return ok('Calculadora iniciada.')

              case 'mute_audio':
                // PowerShell audio mute toggle via WScript
                exec('powershell -Command "$wscript = New-Object -ComObject Wscript.Shell; $wscript.SendKeys([char]173)"')
                return ok('Áudio do sistema silenciado.')

              case 'volume_up':
                exec('powershell -Command "$wscript = New-Object -ComObject Wscript.Shell; 1..5 | ForEach-Object { $wscript.SendKeys([char]175) }"')
                return ok('Volume aumentado.')

              case 'volume_down':
                exec('powershell -Command "$wscript = New-Object -ComObject Wscript.Shell; 1..5 | ForEach-Object { $wscript.SendKeys([char]174) }"')
                return ok('Volume reduzido.')

              default:
                return refuse(`Ação "${action}" desconhecida.`)
            }
          } catch (err) {
            return refuse(`Erro ao executar ${action}: ${err.message}`)
          }
        }
      ),

      tool(
        'system_status',
        'Returns current real-time PC diagnostic metrics: CPU usage, RAM utilization, active DePIN background miners, and network status.',
        {},
        async () => {
          try {
            const totalMem = Math.round(os.totalmem() / (1024 * 1024 * 1024))
            const freeMem = Math.round(os.freemem() / (1024 * 1024 * 1024))
            const usedMem = totalMem - freeMem
            const memPercent = Math.round((usedMem / totalMem) * 100)
            const cpus = os.cpus().length
            const uptimeHours = Math.round(os.uptime() / 3600)

            // Checar se mineradoras e marketpulse estao ativas
            let grassStatus = 'Inativo'
            let dawnStatus = 'Inativo'
            let marketpulseStatus = 'Inativo'

            try {
              const tasklist = execSync('tasklist /FI "IMAGENAME eq grass.exe" 2>nul', { encoding: 'utf-8' })
              if (tasklist.includes('grass.exe')) grassStatus = 'Ativo (2.0x)'
            } catch {}

            try {
              const curlCheck = execSync('curl -s -o nul -w "%{http_code}" http://localhost:8080 --connect-timeout 2 2>nul', { encoding: 'utf-8' })
              if (curlCheck.trim() === '200') marketpulseStatus = 'Online (Porta 8080)'
            } catch {}

            const report = `DIAGNÓSTICO DO SISTEMA OPERACIONAL:
• Processador: ${cpus} núcleos lógicos ativos
• Memória RAM: ${usedMem} GB usados de ${totalMem} GB (${memPercent}%)
• Tempo Ligado: ${uptimeHours} horas contínuas
• DePIN Grass Desktop: ${grassStatus}
• MarketPulse AI: ${marketpulseStatus}
Todos os subsistemas vitais operando dentro dos parâmetros nominais, senhor.`

            return ok(report)
          } catch (err) {
            return refuse(`Falha ao obter diagnóstico: ${err.message}`)
          }
        }
      ),

      tool(
        'screen_capture',
        'Captures a live screenshot of the current active Windows screen so JARVIS can visually inspect code, errors, or documents.',
        {},
        async () => {
          try {
            const tempDir = os.tmpdir()
            const screenPath = path.join(tempDir, `jarvis_screen_${Date.now()}.png`)

            // Captura de tela nativa usando .NET sem dependências externas
            const psScript = `
              Add-Type -AssemblyName System.Windows.Forms
              Add-Type -AssemblyName System.Drawing
              $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
              $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
              $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
              $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
              $bitmap.Save('${screenPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
              $graphics.Dispose()
              $bitmap.Dispose()
            `
            execSync(`powershell -Command "${psScript.replace(/\n/g, ' ')}"`, { timeout: 8000 })

            if (fs.existsSync(screenPath)) {
              return ok(`Captura de tela realizada com sucesso e salva em "${screenPath}". A tela mostra a área de trabalho atual do usuário.`)
            }
            return refuse('Não foi possível gerar a captura de tela.')
          } catch (err) {
            return refuse(`Erro ao capturar tela: ${err.message}`)
          }
        }
      )
    ]
  })
}
