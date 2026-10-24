import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PAGE = 'file:///F:/MyApp/eternal/memory-eternal/site/index.html'
const OUT = path.resolve('site/assets')
const PORT = 9457
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'me-land-'))
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--allow-file-access-from-files', '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore', windowsHide: true })

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [] }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')) }); const c = new Cdp(ws); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) } else if (m.method === 'Runtime.exceptionThrown') c.errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text) }; return c }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || '')); return r.result && r.result.value }
  async shot(file, full) { const params = { format: 'png' }; if (full) params.captureBeyondViewport = true; const r = await this.send('Page.captureScreenshot', params); fs.writeFileSync(file, Buffer.from(r.data, 'base64')) }
}
async function devtools() { for (let i = 0; i < 120; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) return (await r.json()).webSocketDebuggerUrl } catch {} await sleep(150) } throw new Error('devtools timeout') }

const main = async () => {
  await devtools()
  const created = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' })
  const t = await created.json(); const cdp = await Cdp.connect(t.webSocketDebuggerUrl)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: PAGE }); await sleep(1200)
  await cdp.shot(path.join(OUT, 'landing-hero.png'))
  const h = await cdp.eval(`document.documentElement.scrollHeight`)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  await cdp.shot(path.join(OUT, 'landing-full.png'))
  console.log(JSON.stringify({ height: h, overflow: await cdp.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`), errors: cdp.errors }, null, 2))
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await sleep(500)
  await cdp.shot(path.join(OUT, 'landing-mobile.png'))
  console.log(JSON.stringify({ mobileOverflow: await cdp.eval(`document.documentElement.scrollWidth - document.documentElement.clientWidth`) }))
  cdp.ws.close(); child.kill(); await sleep(300)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
}
main().catch((e) => { console.error('landing shoot failed', e); child.kill(); process.exitCode = 1 })
