import http from 'node:http'
import { networkInterfaces } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import WebSocket from 'ws'
import QRCode from 'qrcode'

/**
 * Her, from the phone, anywhere in the house.
 *
 * The bridge itself stays on loopback (see server.mjs). This is a second,
 * deliberately small server on the home network, port 8788, that does three
 * things and nothing else: a page, a question box that relays to the bridge
 * the same way the HUD does, and the feed of what she has announced.
 *
 * Nothing works without pairing. A random key lives in ~/.jarvis/mobile.json;
 * the QR code on the core monitor carries it; scanning it sets a cookie, and
 * every request after that must carry the cookie. Without it: 401. The key is
 * rotated by deleting that file. JARVIS_MOBILE=0 keeps this server off.
 *
 * The phone types rather than records: a page on the home network is plain
 * http, and phones only open the microphone for https. The keyboard's own
 * dictation button fills the box just as well.
 */
const OFF = process.env.JARVIS_MOBILE === '0'
const PORT = Number(process.env.JARVIS_MOBILE_PORT ?? 8788)
const BRIDGE_PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)
const FILE = join(process.env.JARVIS_MEMORY_DIR ?? join(homedir(), '.jarvis'), 'mobile.json')

function key() {
  try {
    const k = JSON.parse(readFileSync(FILE, 'utf8')).key
    if (typeof k === 'string' && k.length >= 32) return k
  } catch {
    /* first run */
  }
  const k = randomBytes(24).toString('base64url')
  mkdirSync(join(FILE, '..'), { recursive: true })
  writeFileSync(FILE, JSON.stringify({ key: k }) + '\n')
  return k
}
const KEY = OFF ? '' : key()

const same = (a, b) => {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The home-network address: Wi-Fi or Ethernet, never a virtual switch. */
function lanAddress() {
  const all = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, ip: a.address })),
  )
  const real = all.filter((a) => !/vethernet|virtual|vmware|virtualbox|wsl|docker|hyper-v|loopback/i.test(a.name))
  const pick = real.find((a) => /^(192\.168\.|10\.)/.test(a.ip)) ?? real[0] ?? all[0]
  return pick?.ip ?? null
}

// --------------------------------------------------------------- the feed

const feed = []
/** What she announced (reminders, alerts), for the phone to show. */
export function pushFeed(text) {
  feed.push({ at: new Date().toISOString(), text: String(text).slice(0, 400) })
  if (feed.length > 30) feed.shift()
}

// ------------------------------------------------------------- the relay

/** Ask the bridge as the HUD would, and wait for the answer. */
function ask(text) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/?once=1`, { origin: 'http://localhost:5173', headers: { host: `127.0.0.1:${BRIDGE_PORT}` } })
    const timer = setTimeout(() => {
      ws.terminate()
      resolve({ text: 'Receio que a resposta tenha demorado demais, senhor.', brain: null })
    }, 120_000)
    ws.on('open', () => ws.send(JSON.stringify({ type: 'ask', text })))
    ws.on('message', (raw) => {
      let m
      try {
        m = JSON.parse(String(raw))
      } catch {
        return
      }
      // A consent card cannot be answered from here: refuse it, plainly.
      if (m.type === 'confirm' && m.id) ws.send(JSON.stringify({ type: 'reply', id: m.id, ok: false }))
      if (m.type === 'done' || m.type === 'error') {
        clearTimeout(timer)
        ws.close()
        resolve({ text: m.text ?? m.message ?? '', brain: m.brain ?? 'claude' })
      }
    })
    ws.on('error', () => {
      clearTimeout(timer)
      resolve({ text: 'Não consegui falar com a ponte, senhor.', brain: null })
    })
  })
}

// ---------------------------------------------------------------- server

const hits = new Map()
const limited = (ip) => {
  const now = Date.now()
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000)
  list.push(now)
  hits.set(ip, list)
  return list.length > 40
}

const cookieOf = (req) => /(?:^|;\s*)jt=([^;]+)/.exec(req.headers.cookie ?? '')?.[1]

const PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Wednesday</title>
<style>
:root{--c:#00e5ff;--bg:#01060c;--ink:#e6fbff;--ink2:#9fc7cf}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column}
header{padding:18px 16px 10px;letter-spacing:.35em;font-weight:600;color:var(--c);border-bottom:1px solid #0b3540}
main{flex:1;padding:12px 16px;overflow:auto}
.msg{margin:10px 0;line-height:1.45}.me{color:var(--ink2)}.her{border-left:2px solid var(--c);padding-left:10px}
.feed{margin-top:18px;border-top:1px dashed #0b3540;padding-top:8px;font-size:14px;color:var(--ink2)}
.feed b{color:#ffb347;font-weight:400}
form{display:flex;gap:8px;padding:12px 16px calc(12px + env(safe-area-inset-bottom));border-top:1px solid #0b3540;background:#020a12;position:sticky;bottom:0}
input{flex:1;padding:12px;border-radius:10px;border:1px solid #0b3540;background:#031018;color:var(--ink);font-size:16px}
button{padding:0 16px;border-radius:10px;border:1px solid var(--c);background:transparent;color:var(--c);font-size:15px}
label{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink2);padding:0 16px 8px}
</style></head><body>
<header>WEDNESDAY</header>
<main id="log"><p class="msg me">Escreva ou use o microfone do teclado.</p><div class="feed" id="feed"></div></main>
<label><input type="checkbox" id="speak" checked style="flex:none"> falar as respostas no celular</label>
<form id="f"><input id="q" placeholder="Pergunte à Wednesday…" autocomplete="off"><button>Enviar</button></form>
<script>
const log=document.getElementById('log'),q=document.getElementById('q'),feedEl=document.getElementById('feed')
const add=(t,c)=>{const p=document.createElement('p');p.className='msg '+c;p.textContent=t;log.insertBefore(p,feedEl);log.scrollTop=log.scrollHeight}
document.getElementById('f').onsubmit=async e=>{e.preventDefault();const t=q.value.trim();if(!t)return;q.value='';add(t,'me');add('…','her')
 const r=await fetch('/m/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:t})}).then(r=>r.json()).catch(()=>({text:'Sem conexão.'}))
 log.querySelectorAll('.her')[log.querySelectorAll('.her').length-1].textContent=r.text
 if(document.getElementById('speak').checked&&'speechSynthesis' in window){const u=new SpeechSynthesisUtterance(r.text);u.lang='pt-BR';speechSynthesis.speak(u)}}
let seen=''
async function poll(){const f=await fetch('/m/feed').then(r=>r.json()).catch(()=>null);if(f){feedEl.innerHTML='<div>Avisos</div>'+f.slice(-8).reverse().map(x=>'<p><b>'+new Date(x.at).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})+'</b> '+x.text.replace(/</g,'&lt;')+'</p>').join('')
 const last=f.at(-1);if(last&&last.at!==seen){if(seen&&navigator.vibrate)navigator.vibrate(200);seen=last.at}}}
poll();setInterval(poll,15000)
</script></body></html>`

const NOT_PAIRED = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="background:#01060c;color:#e6fbff;font:16px system-ui;padding:24px"><h3 style="color:#00e5ff;letter-spacing:.3em">WEDNESDAY</h3>
<p>Este celular ainda não foi pareado. Escaneie o QR code no painel NÚCLEO do computador.</p></body>`

export function startMobile() {
  if (OFF) return null
  const server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress ?? ''
    if (limited(ip)) {
      res.writeHead(429)
      return res.end()
    }
    const url = new URL(req.url ?? '/', 'http://x')
    // Pairing: the key from the QR code becomes a cookie, then is dropped from the address bar.
    if (url.pathname === '/m' && url.searchParams.has('k')) {
      if (!same(url.searchParams.get('k'), KEY)) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(NOT_PAIRED.replace('ainda não foi pareado', 'leu um código antigo ou incompleto'))
      }
      // The page itself, not a redirect to it. A page opened from the camera
      // app is a navigation from outside, and a SameSite=Strict cookie set on
      // it was not sent on the redirect that followed — so the phone was told,
      // straight after pairing, that it was not paired. Lax is sent on
      // top-level navigations; the key in the address bar is removed by the
      // page with replaceState.
      res.writeHead(200, {
        'set-cookie': `jt=${KEY}; HttpOnly; SameSite=Lax; Path=/m; Max-Age=31536000`,
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
      })
      return res.end(PAGE.replace('<script>', "<script>history.replaceState(null,'','/m');"))
    }
    if (!same(cookieOf(req), KEY)) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(NOT_PAIRED)
    }
    if (req.method === 'GET' && url.pathname === '/m') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' })
      return res.end(PAGE)
    }
    if (req.method === 'GET' && url.pathname === '/m/feed') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(feed))
    }
    if (req.method === 'POST' && url.pathname === '/m/ask') {
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (body.length > 4000) break
      }
      let text = ''
      try {
        text = String(JSON.parse(body).text ?? '').trim().slice(0, 500)
      } catch {
        /* bad body */
      }
      if (!text) {
        res.writeHead(400)
        return res.end()
      }
      const answer = await ask(text)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify(answer))
    }
    res.writeHead(404)
    res.end()
  })
  server.on('error', (err) => console.warn(`[jarvis] phone server unavailable: ${err.code ?? err.message}`))
  server.listen(PORT, '0.0.0.0', () => console.log(`[jarvis] phone page on the home network, port ${PORT} (paired devices only)`))
  return server
}

/** For the core monitor (loopback only): the pairing address and its QR code. */
export async function mobileInfo() {
  if (OFF) return { enabled: false }
  const ip = lanAddress()
  if (!ip) return { enabled: true, url: null, qr: null }
  const url = `http://${ip}:${PORT}/m?k=${KEY}`
  // Black on white with the full quiet zone, and the lowest error correction
  // (fewest modules). The cyan-on-transparent version matched the panels and
  // no phone camera would read it: readers expect dark modules on a light,
  // bordered ground.
  const qr = await QRCode.toString(url, {
    type: 'svg',
    margin: 4,
    errorCorrectionLevel: 'L',
    color: { dark: '#000000ff', light: '#ffffffff' },
  })
  return { enabled: true, address: `http://${ip}:${PORT}/m`, qr }
}
