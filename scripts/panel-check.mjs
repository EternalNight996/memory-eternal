#!/usr/bin/env node
// 面板视觉/布局自检（零依赖）：用本机 Chrome headless + CDP 打开记忆面板，
// 逐步点击 → 断言「没有横向溢出 / 没有异常滚动条」→ 截图。
//
// 为什么需要它：0.10.42–0.10.47 的界面回归（按钮被挤压、横向滚动条、按钮消失）
// 全是「源码守卫测试全绿但肉眼一看就不对」—— 源码测试只能证明字符串还在，
// 证明不了布局。这个脚本把「看得见」变成可重复的验收动作。
//
// 用法：
//   node scripts/panel-check.mjs                       # 默认 http://127.0.0.1:7999/
//   node scripts/panel-check.mjs --url http://127.0.0.1:7999/ --out ./.panel
//   node scripts/panel-check.mjs --click "text=配置" --click "text=知识卡"
//   退出码非 0 = 发现横向溢出（不该发的版）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, def = '') => { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] ?? '') : def }
const flags = (name) => argv.reduce((acc, a, i) => (a === '--' + name ? [...acc, argv[i + 1]] : acc), [])

const URL_TARGET = flag('url', 'http://127.0.0.1:7999/')
const OUT_DIR = path.resolve(flag('out', '.panel'))
const CLICKS = flags('click')
const PORT = Number(flag('port', '9333'))
const SIZE = flag('size', '')
const CHROME = flag('chrome', process.platform === 'win32'
  ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function launchChrome() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'me-panel-'))
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars=false', '--no-first-run',
    ...(SIZE ? ['--window-size=' + SIZE] : []),
    '--no-default-browser-check', '--disable-extensions', '--mute-audio',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + String(PORT), 'about:blank',
  ], { stdio: 'ignore', windowsHide: true })
  return { child, profile }
}

async function waitForDevtools() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version')
      if (r.ok) return (await r.json()).webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(150)
  }
  throw new Error('Chrome DevTools 没起来（端口 ' + PORT + '）')
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [] }
  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('WebSocket 失败: ' + (e && e.message || e))) })
    const cdp = new Cdp(ws)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && cdp.pending.has(msg.id)) {
        const { res, rej } = cdp.pending.get(msg.id)
        cdp.pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      } else cdp.events.push(msg)
    }
    return cdp
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面脚本异常：' + (r.exceptionDetails.text || ''))
    return r.result && r.result.value
  }
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  }
}

// 每步都跑的断言：任何「可滚动容器的 scrollWidth > clientWidth」都算横向溢出（滚动条异常）
// 页面健康：白屏 / JS 异常 = 比溢出更严重的失败（真实事故：一个 t 之外的 helper 让整页白屏，
// 而「空白页没有横向溢出」会让检查**通过** —— 所以必须先断言页面还活着）。
const PAGE_ALIVE_PROBE = `(() => {
  const txt = (document.body && document.body.innerText || '').trim()
  return { textLen: txt.length, hasRoot: Boolean(document.querySelector('.me-overlay, .mc-card, .mc-grid, .mc-rail')) }
})()`

const OVERFLOW_PROBE = `(() => {
  const out = []
  const root = document.documentElement
  const over0 = root.scrollWidth - root.clientWidth
  if (over0 > 1) out.push({ what: 'html', over: over0 })
  for (const sel of ['.me-dialog', '.me-dialog-body', '.mc-card', '.md-doc', '.mc-toolbar', '.mc-head-actions', '.me-head-actions', '.mc-tags', 'footer']) {
    document.querySelectorAll(sel).forEach((el, i) => {
      const over = el.scrollWidth - el.clientWidth
      if (over <= 1) return
      // 把「谁把它撑宽」也带出来：只报容器不够，修的时候还得猜
      const cw = el.clientWidth
      const kids = [...el.children].map((c) => {
        const r = c.getBoundingClientRect()
        return { tag: c.tagName, cls: String(c.className || '').slice(0, 48), w: Math.round(r.width), right: Math.round(r.right - el.getBoundingClientRect().left), over: c.scrollWidth - c.clientWidth, text: (c.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 56) }
      }).filter((k) => k.right > cw + 1 || k.over > 1)
      out.push({ what: sel + '#' + i, over, cls: String(el.className || '').slice(0, 60), kids })
    })
  }
  return out
})()`

async function clickText(cdp, spec) {
  // 支持 "text=xxx" 与 CSS 选择器
  const isText = spec.startsWith('text=')
  const expr = isText
    ? `(() => { const want = ${JSON.stringify(spec.slice(5))}; const els = [...document.querySelectorAll('button,a,[role=tab],.mc-chip,span,div')]; const hit = els.reverse().find((e) => (e.innerText || '').trim() === want) || els.reverse().find((e) => (e.innerText || '').includes(want)); if (!hit) return false; hit.click(); return true })()`
    : `(() => { const el = document.querySelector(${JSON.stringify(spec)}); if (!el) return false; el.click(); return true })()`
  const ok = await cdp.eval(expr)
  if (!ok) throw new Error('点不到：' + spec)
  await sleep(900)
}

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const { child, profile } = launchChrome()
  let cdp = null
  try {
    // /json/version 给的是**浏览器级** target（只有 Target.* 方法）；要 Page/Runtime 必须新建页面 target。
    await waitForDevtools()
    const created = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(URL_TARGET), { method: 'PUT' })
    if (!created.ok) throw new Error('创建页面 target 失败：HTTP ' + created.status)
    const target = await created.json()
    cdp = await Cdp.connect(target.webSocketDebuggerUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    // 页面抛异常 = 发布阻断项（白屏的根因就在这类异常里）
    cdp.ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data)
        if (m.method === 'Runtime.exceptionThrown') {
          const d = (m.params && m.params.exceptionDetails) || {}
          const desc = (d.exception && d.exception.description) || d.text || 'unknown'
          ;(globalThis.__panelErrors ||= []).push(String(desc).split('\n')[0])
        }
      } catch { /* 非 JSON 消息忽略 */ }
    })
    await cdp.send('Page.navigate', { url: URL_TARGET })
    await sleep(2500)

    const report = []
    let bad = 0
    const jsErrors = []
    const step = async (label) => {
      const alive = await cdp.eval(PAGE_ALIVE_PROBE)
      const over = await cdp.eval(OVERFLOW_PROBE)
      const file = path.join(OUT_DIR, label + '.png')
      await cdp.shot(file)
      const blank = !alive || alive.textLen < 20
      const entry = { label, over, png: file }
      if (blank) entry.blank = true
      if (alive) entry.textLen = alive.textLen
      report.push(entry)
      if (over.length || blank) bad++
    }

    await step('01-list')
    for (let i = 0; i < CLICKS.length; i++) {
      await clickText(cdp, CLICKS[i])
      await step(String(i + 2).padStart(2, '0') + '-' + (CLICKS[i].replace(/^text=/, '').replace(/[^\w\u4e00-\u9fa5-]/g, '_') || 'step'))
    }

    const pageErrors = globalThis.__panelErrors || []
    console.log(JSON.stringify({ url: URL_TARGET, out: OUT_DIR, steps: report, badSteps: bad, pageErrors }, null, 2))
    if (bad || pageErrors.length) {
      if (bad) console.error('✗ ' + bad + ' 个步骤不合格：横向溢出或白屏（见 steps 里的 over / blank）')
      if (pageErrors.length) console.error('✗ 页面抛出 ' + pageErrors.length + ' 个异常：' + pageErrors.slice(0, 3).join(' | '))
      process.exitCode = 1
    } else console.log('✓ 全部步骤：页面存活、无横向溢出、无 JS 异常')
  } finally {
    try { cdp && cdp.ws.close() } catch { /* 无所谓 */ }
    try { child.kill() } catch { /* 已经退出 */ }
    await sleep(300)
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch { /* 临时目录清理失败无妨 */ }
  }
}
main().catch((e) => { console.error('panel-check 失败：' + (e && e.message || e)); process.exitCode = 1 })
