// 用 Chrome headless + CDP 截取蜘蛛侠皮肤下的真实界面，以及品牌头图 / Social preview。
// 用法：node scripts/shots.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9333
const OUT = path.resolve('assets/screen')
const root = 'http://127.0.0.1:7999'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHttp(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return r } catch { /* retry */ }
    await wait(250)
  }
  throw new Error('chrome devtools not ready: ' + url)
}

const userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'me-shot-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--allow-file-access-from-files',
  '--force-device-scale-factor=1',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`, 'about:blank',
], { stdio: 'ignore' })

try {
  await waitHttp(`http://127.0.0.1:${PORT}/json/version`)
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result) }
  }
  const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })) })
  await new Promise((r) => { ws.onopen = r })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })

  const goto = async (url, settle = 3800) => { await send('Page.navigate', { url }); await wait(settle) }
  const shoot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await fs.mkdir(OUT, { recursive: true })
    await fs.writeFile(path.join(OUT, name), Buffer.from(r.data, 'base64'))
    console.log('shot', name)
  }

  // 1) 设置蜘蛛侠皮肤 + 跳过首次引导，然后重载
  await goto(root + '/', 2200)
  await send('Runtime.evaluate', { expression: "localStorage.setItem('me-skin','spider'); localStorage.setItem('me-onboarded-v2','1'); localStorage.setItem('me-onboard-v2','1'); location.reload()" })
  await wait(4200)

  await goto(root + '/?tab=cards', 4200); await shoot('spider-cards.png')
  await goto(root + '/?tab=graph', 5200); await shoot('spider-graph.png')
  await goto(root + '/?tab=audit', 4200); await shoot('spider-audit.png')
  await goto(root + '/?tab=usage', 3800); await shoot('spider-usage.png')

  // 2) 品牌头图（1600x900）
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'file:///F:/MyApp/eternal/memory-eternal/assets/brand/hero.html' })
  await wait(1600); await shoot('hero.png')

  // 3) Social preview（1280x640）
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'file:///F:/MyApp/eternal/memory-eternal/assets/brand/social.html' })
  await wait(1600)
  const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await fs.writeFile(path.resolve('assets/social-preview.png'), Buffer.from(s.data, 'base64'))
  console.log('shot social-preview.png')

  ws.close()
} finally {
  try { chrome.kill() } catch { /* ignore */ }
  await wait(600)
  try { await fs.rm(userDir, { recursive: true, force: true }) } catch { /* lock */ }
}
