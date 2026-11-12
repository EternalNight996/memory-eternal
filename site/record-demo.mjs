#!/usr/bin/env node
// 录制官网 Demo Reel：Chrome headless + CDP screencast 录真实 Demo 页面，
// 再用 ffmpeg 编码成 1280x720 / 30fps / H.264，供 site 的 CRT 播放器使用。
//
// 用法：node site/record-demo.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const PAGE = pathToFileURL(path.join(ROOT, 'site/demo/index.html')).href
const OUT = path.join(ROOT, 'site/assets')
const FRAMES = path.join(ROOT, 'site/.demo-frames')
const MP4 = path.join(OUT, 'demo-reel.mp4')
const POSTER = path.join(OUT, 'demo-reel-poster.jpg')
const CURSOR = path.join(ROOT, 'site/demo/reel-cursor.js')
const PORT = 9463
const CHROME = process.env.CHROME || (process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

fs.mkdirSync(OUT, { recursive: true })
fs.rmSync(FRAMES, { recursive: true, force: true })
fs.mkdirSync(FRAMES, { recursive: true })
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'me-reel-'))
const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio', '--allow-file-access-from-files',
  '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT, 'about:blank',
], { stdio: 'ignore', windowsHide: true })

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map() }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')) })
    const c = new Cdp(ws)
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && c.pending.has(m.id)) {
        const { res, rej } = c.pending.get(m.id); c.pending.delete(m.id)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      } else if (m.method && c.handlers.has(m.method)) c.handlers.get(m.method)(m.params)
    }
    return c
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  on(method, fn) { this.handlers.set(method, fn) }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''))
    return r.result && r.result.value
  }
}

async function devtools() {
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) return (await r.json()).webSocketDebuggerUrl } catch {}
    await sleep(150)
  }
  throw new Error('devtools timeout')
}

async function main() {
  await devtools()
  const created = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(PAGE), { method: 'PUT' })
  const target = await created.json()
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
  await cdp.send('Page.navigate', { url: PAGE })
  await sleep(2200)

  // 跳过首访引导；注入一个可见的鼠标，避免录屏里只有界面自己跳变。
  const guideOpen = await cdp.eval("!document.querySelector('#guideOverlay').hidden")
  if (guideOpen) { await cdp.eval("document.querySelector('#guideSkip').click()"); await sleep(350) }
  await cdp.eval(fs.readFileSync(CURSOR, 'utf8'))
  await sleep(500)

  let frameNo = 0
  const frames = []
  const startedAt = Date.now()
  const marks = []
  cdp.on('Page.screencastFrame', (p) => {
    try {
      const file = 'f-' + String(frameNo).padStart(5, '0') + '.jpg'
      fs.writeFileSync(path.join(FRAMES, file), Buffer.from(p.data, 'base64'))
      frames.push({ file, ts: Number(p.metadata && p.metadata.timestamp) || 0 })
      frameNo++
      cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {})
    } catch { /* 丢一帧不影响成片 */ }
  })
  const mark = (name) => { marks.push({ name, at: (Date.now() - startedAt) / 1000 }); console.log('mark', name, marks[marks.length - 1].at.toFixed(2) + 's') }

  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 })
  await sleep(900)
  mark('library')
  await sleep(900)
  await cdp.eval("window.__reelFindCard('技能：create-skill')")
  await sleep(900)
  mark('reader')
  await sleep(2200)
  await cdp.eval("document.querySelector('#closeReader').click()")
  await sleep(420)
  await cdp.eval("document.querySelector('[data-view=audit]').click()")
  await sleep(950)
  mark('audit')
  await cdp.eval("window.__reelMove('[data-kind=skill]')")
  await sleep(450)
  await cdp.eval("window.__reelClick('[data-kind=skill]')")
  await sleep(1500)
  await cdp.eval("window.__reelMove('.audit-row')")
  await sleep(800)
  mark('audit-skill')
  await sleep(900)
  await cdp.eval("document.querySelector('[data-view=graph]').click()")
  await sleep(3200)
  mark('graph')
  await cdp.eval("window.__reelMove('#zoomIn')")
  await sleep(350)
  await cdp.eval("document.querySelector('#zoomIn').click()")
  await sleep(700)
  await cdp.eval("document.querySelector('#zoomIn').click()")
  await sleep(1500)
  mark('graph-zoom')
  await cdp.eval("window.__reelMove('[data-view=library]')")
  await sleep(350)
  await cdp.eval("document.querySelector('[data-view=library]').click()")
  await sleep(1600)
  mark('end')
  await cdp.send('Page.stopScreencast')
  await sleep(500)

  if (frames.length < 10) throw new Error('录制帧太少：' + frames.length)
  // 固定 30fps：screencast 的帧间隔会被宿主调度抖动放大/压缩，按序号编码最稳。
  const ff = spawn('ffmpeg', [
    '-y', '-framerate', '30', '-i', path.join(FRAMES, 'f-%05d.jpg'),
    '-vf', 'scale=1280:720:flags=lanczos',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-an', MP4,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  const code = await new Promise((res) => ff.on('close', res))
  if (code !== 0) throw new Error('ffmpeg 编码失败，退出码 ' + code)
  await new Promise((res) => {
    const p = spawn('ffmpeg', ['-y', '-ss', '0.6', '-i', MP4, '-frames:v', '1', '-q:v', '3', POSTER], { stdio: 'ignore' })
    p.on('close', res)
  })

  const probe = JSON.parse(await new Promise((res, rej) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'json', MP4])
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('close', (c) => c === 0 ? res(out) : rej(new Error('ffprobe failed')))
  }))
  console.log(JSON.stringify({ frames: frames.length, marks, duration: Number(probe.format.duration), size: Number(probe.format.size), mp4: MP4, poster: POSTER }, null, 2))
  cdp.ws.close(); child.kill(); await sleep(300)
  fs.rmSync(FRAMES, { recursive: true, force: true })
  try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
}
main().catch((e) => { console.error('record demo failed', e); child.kill(); process.exitCode = 1 })
