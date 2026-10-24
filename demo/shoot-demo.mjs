import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PAGE = 'file:///F:/MyApp/eternal/memory-eternal/site/demo/index.html'
const OUT = path.resolve('site/assets')
const PORT = 9456
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'me-demo-'))
const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--allow-file-access-from-files', '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore', windowsHide: true })

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.errors = [] }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')) })
    const c = new Cdp(ws)
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && c.pending.has(m.id)) { const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result) }
      else if (m.method === 'Runtime.exceptionThrown') c.errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text)
    }
    return c
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })) }) }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || '')); return r.result && r.result.value }
  async shot(file) { const r = await this.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')) }
}
async function devtools() { for (let i = 0; i < 120; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) return (await r.json()).webSocketDebuggerUrl } catch {} await sleep(150) } throw new Error('devtools timeout') }

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  await devtools()
  const created = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' })
  const target = await created.json()
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(2200)
  async function shot(name) { await sleep(450); await cdp.shot(path.join(OUT, name + '.png')); console.log('shot', name) }

  const guideOpen = await cdp.eval(`!document.querySelector('#guideOverlay').hidden`)
  if (guideOpen) {
    await cdp.eval(`document.querySelector('#guideNext').click()`)
    await sleep(200)
    await shot('onboarding')
    await cdp.eval(`document.querySelector('#guideSkip').click()`)
    await sleep(300)
  }
  await shot('hero')
  console.log(JSON.stringify(await cdp.eval(`(() => ({ cards: document.querySelectorAll('.card').length, feature: !!document.querySelector('.feature'), pending: document.querySelector('#navPending') ? document.querySelector('#navPending').innerText : '', overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()`), null, 2))

  await cdp.eval(`document.querySelectorAll('.card:not(.feature)')[1].click()`)
  await sleep(800)
  await shot('reader')
  await cdp.eval(`document.querySelector('#closeReader').click()`)
  await sleep(300)

  await cdp.eval(`document.querySelector('[data-view=audit]').click()`)
  await sleep(700)
  await cdp.eval(`(() => { const b = document.querySelector('#batchAll'); if (b) b.click(); return true })()`)
  await sleep(250)
  await shot('audit')
  await cdp.eval(`(() => { const b = document.querySelector('#batchAll'); if (b) b.click(); return true })()`)

  await cdp.eval(`document.querySelector('[data-view=graph]').click()`)
  await sleep(2600)
  await shot('graph')
  await cdp.eval(`(() => { document.querySelector('#zoomIn').click(); document.querySelector('#zoomIn').click(); return true })()`)
  await sleep(500)
  await shot('graph-zoom')

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await cdp.eval(`document.querySelector('[data-view=library]').click()`)
  await sleep(800)
  await shot('mobile')
  console.log(JSON.stringify(await cdp.eval(`({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth })`), null, 2))
  console.log(JSON.stringify({ errors: cdp.errors }, null, 2))
  cdp.ws.close(); child.kill(); await sleep(300)
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
}
main().catch((e) => { console.error('demo shoot failed', e); child.kill(); process.exitCode = 1 })
