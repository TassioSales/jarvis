import { execFile } from 'node:child_process'
import { cpus, freemem, hostname, totalmem, uptime } from 'node:os'

/**
 * The machine, for the core monitor: processor, graphics card, memory, disks,
 * network and the processes doing the most.
 *
 * Sampled on timers here rather than per request, so three windows polling
 * cost one measurement, and each source runs at the pace it changes: the GPU
 * and the network every few seconds, the disks and the process list every
 * fifteen (that one starts a PowerShell, which is not free).
 *
 * Every source is optional. No NVIDIA card, no `netstat`, a PowerShell that
 * fails — that part is null and the rest still reports.
 */

const run = (file, args, timeout = 8000) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      resolve(err ? null : String(stdout)),
    )
  })

// ------------------------------------------------------------------ processor

let lastCpu = cpus()
let cpuNow = 0
const cpuHistory = []

function sampleCpu() {
  const next = cpus()
  let idle = 0
  let total = 0
  next.forEach((c, i) => {
    const before = lastCpu[i]?.times
    if (!before) return
    for (const k of Object.keys(c.times)) total += c.times[k] - before[k]
    idle += c.times.idle - before.idle
  })
  lastCpu = next
  cpuNow = total ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0
  cpuHistory.push(Math.round(cpuNow))
  if (cpuHistory.length > 90) cpuHistory.shift()
}

// ----------------------------------------------------------------------- GPU

let gpu = null
async function sampleGpu() {
  const out = await run('nvidia-smi', [
    '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
    '--format=csv,noheader,nounits',
  ])
  if (!out) return void (gpu = null)
  const [name, util, used, total, temp, power] = out.trim().split('\n')[0].split(',').map((s) => s.trim())
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null)
  gpu = { name, util: num(util), memUsed: num(used), memTotal: num(total), temp: num(temp), power: num(power) }
}

// ------------------------------------------------------------------- network

let netLast = null
let net = null
const netHistory = []
async function sampleNet() {
  // "Bytes    <received>    <sent>" — the one line of `netstat -e` that matters.
  const out = await run('netstat', ['-e'], 4000)
  const m = out && /^\s*\S+\s+(\d+)\s+(\d+)\s*$/m.exec(out.split('\n').find((l) => /^\s*(Bytes|Bytes)\b/i.test(l)) ?? '')
  if (!m) return
  const now = { at: Date.now(), rx: Number(m[1]), tx: Number(m[2]) }
  if (netLast && now.at > netLast.at) {
    const s = (now.at - netLast.at) / 1000
    net = { down: Math.max(0, (now.rx - netLast.rx) / s), up: Math.max(0, (now.tx - netLast.tx) / s) }
    netHistory.push({ down: net.down, up: net.up })
    if (netHistory.length > 60) netHistory.shift()
  }
  netLast = now
}

// ------------------------------------------------- disks and the process list

let disks = []
let top = []
let procLast = null
const SCRIPT =
  "$d = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace;" +
  'ConvertTo-Json -Compress -InputObject @($d);' +
  "'---';" +
  '$p = Get-Process | Where-Object { $_.CPU -ne $null } | Select-Object Id,ProcessName,CPU,WorkingSet64;' +
  'ConvertTo-Json -Compress -InputObject @($p)'

async function sampleSlow() {
  const out = await run('powershell', ['-NoProfile', '-Command', SCRIPT], 15000)
  if (!out) return
  const [d, p] = out.split('---').map((s) => s.trim())
  try {
    disks = JSON.parse(d).map((x) => ({ name: x.DeviceID, total: x.Size, free: x.FreeSpace }))
  } catch {
    /* keep the last */
  }
  try {
    const now = { at: Date.now(), list: JSON.parse(p) }
    if (procLast) {
      const before = new Map(procLast.list.map((x) => [x.Id, x.CPU]))
      const secs = (now.at - procLast.at) / 1000
      const cores = cpus().length
      // Same-named processes (every Chrome tab is "chrome") are one row.
      const byName = new Map()
      for (const x of now.list) {
        const was = before.get(x.Id)
        const pct = was === undefined ? 0 : Math.max(0, ((x.CPU - was) / secs / cores) * 100)
        const row = byName.get(x.ProcessName) ?? { name: x.ProcessName, cpu: 0, mem: 0, count: 0 }
        row.cpu += pct
        row.mem += x.WorkingSet64
        row.count++
        byName.set(x.ProcessName, row)
      }
      top = [...byName.values()]
        .filter((r) => r.name !== 'Idle' && r.name !== '_Total')
        .sort((a, b) => b.cpu - a.cpu || b.mem - a.mem)
        .slice(0, 8)
        .map((r) => ({ ...r, cpu: Math.round(r.cpu * 10) / 10 }))
    }
    procLast = now
  } catch {
    /* keep the last */
  }
}

// --------------------------------------------------------------------- timers

let started = false
function start() {
  if (started) return
  started = true
  setInterval(sampleCpu, 2000).unref()
  setInterval(() => void sampleGpu(), 3000).unref()
  setInterval(() => void sampleNet(), 3000).unref()
  setInterval(() => void sampleSlow(), 15000).unref()
  sampleCpu()
  void sampleGpu()
  void sampleNet()
  void sampleSlow()
}

/** Everything measured, as of now. Starts the sampling on first call. */
export function system() {
  start()
  return {
    host: hostname(),
    uptime: uptime(),
    cpu: { now: Math.round(cpuNow), cores: cpus().length, name: cpus()[0]?.model?.trim() ?? '', history: cpuHistory },
    mem: { used: totalmem() - freemem(), total: totalmem() },
    gpu,
    net,
    netHistory,
    disks,
    top,
  }
}
