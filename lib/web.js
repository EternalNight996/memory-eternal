// 记忆核心 · 独立 Web server（UI 唯一真源）。
//
// 职责：
// - 静态服务 web/index.html + web/app.js（自包含 bundle，react 打入）
// - 同源挂载 /memory-eternal/api/*（复用 lib/api.js，与 DSH 内完全同一实现）
// - iframe 友好：不设 X-Frame-Options（DSH 宿主内嵌加载本页）
//
// 常驻方式：ensureWebServer() 探活 → 未活则 detached spawn 独立进程
// （DSH 插件激活 / MCP server 启动 / CLI 调用都会走它，实现「默认开启」）。
//
// 直接运行：node lib/web.js --port 7999 [--vault <dir>]

import http from 'node:http'
import { promises as fs, readFileSync, watch } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi, API_PREFIX, encodeBody, broadcast } from './api.js'
import { defaultVaultDir, configFilePath } from './capture-run.js'
import { readCaptureLog, deriveHealth, appendCaptureLog } from './capture-log.js'
import { nodeBinary, childEnv } from './node-bin.js'
import { missingWebAssets, missingAssetsReason } from './web-assets.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.join(__dirname, '..', 'web')
export const DEFAULT_WEB_PORT = Number(process.env.MEMORY_WEB_PORT) || 7999
const VERSION = (() => { try { return JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version } catch { return '' } })()
process.env.MEMORY_ETERNAL_VERSION = VERSION

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

// ---- 静态资源缺失兜底（issue #14）--------------------------------------------
// 装坏了的副本（package.json/lib 在、web/ 没落地）以前只会回一页原始
// `{"ok":false,"error":"ENOENT ..."}`。现在分两档：
//   ① 缺 index.html 但 app.js 还在 → 用内置外壳把界面正常拉起来（自救）；
//   ② 缺 app.js（或两个都缺）→ 给一页人话诊断（缺哪个文件 / 绝对路径 / 版本 / 怎么重装）。
// 两种情况都写进自动沉淀日志：缺 app.js 记 fail（健康态亮红），只缺 index.html 记 warn。
const loggedMissingAssets = new Set()

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const BROKEN_CSS = `
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px; font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f6f7f9; color: #1f2937; }
  .me-broken { max-width: 720px; margin: 4vh auto; background: #fff; border: 1px solid #e5e7eb;
               border-radius: 14px; padding: 22px 24px; line-height: 1.65; }
  .me-broken h1 { margin: 0 0 10px; font-size: 18px; }
  .me-broken h2 { margin: 18px 0 8px; font-size: 14px; }
  .me-broken code { background: #f3f4f6; padding: 1px 5px; border-radius: 5px; font-size: 12.5px; }
  .me-broken ul, .me-broken ol { margin: 6px 0; padding-left: 22px; }
  .me-broken .me-dim { color: #6b7280; font-size: 12.5px; }
  @media (prefers-color-scheme: dark) {
    body { background: #111418; color: #e5e7eb; }
    .me-broken { background: #1a1f26; border-color: #2c333c; }
    .me-broken code { background: #22282f; }
    .me-broken .me-dim { color: #9ca3af; }
  }`

/** 诊断页正文（HTML 片段）：内置外壳与 app.js 兜底共用，保证两处说法一致。 */
export function missingAssetsPanel({ missing = [], webRoot = '', version = '' } = {}) {
  const items = missing.map((f) => `<li><code>web/${esc(f)}</code></li>`).join('')
  return `<div class="me-broken">
  <h1>记忆核心 · 插件安装不完整</h1>
  <p>缺少下面这些界面资源，所以「记忆」打不开 —— 不是浏览器问题，也不是你的数据丢了：</p>
  <ul>${items}</ul>
  <p class="me-dim">插件目录：<code>${esc(webRoot)}</code>${version ? `　·　包版本 v${esc(version)}` : ''}</p>
  <h2>怎么修</h2>
  <ol>
    <li>完全退出 DSH（桌面版请确认进程已结束）；</li>
    <li>删掉插件目录的上一级 <code>memory-eternal</code> 整个文件夹；</li>
    <li>重开 DSH →「插件 → 添加插件」重新安装 <code>memory-eternal</code>（或填 <code>github:EternalNight996/memory-eternal</code>）。</li>
  </ol>
  <p class="me-dim">这条也会出现在「设置 → 记忆 → 用量/今日 → 自动沉淀日志」里。</p>
</div>`
}

/**
 * 缺 index.html 时回的内置外壳：app.js 还在就把界面正常拉起来（自救），
 * 拉不起来（app.js 也缺）就把诊断页显示出来。
 */
export function missingIndexHtml({ missing = [], webRoot = '', version = '' } = {}) {
  const panel = missingAssetsPanel({ missing, webRoot, version })
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>记忆核心 · Memory Eternal</title>
<style>${BROKEN_CSS}
  html, body { height: 100%; }
  #root { min-height: 100vh; }
</style>
</head>
<body>
  <div id="root"></div>
  <div id="me-broken-host" style="display:none">${panel}</div>
  <script>
    (function () {
      var host = document.getElementById('me-broken-host')
      var show = function () { host.style.display = 'block'; document.getElementById('root').appendChild(host) }
      fetch('app.js', { method: 'HEAD' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        var s = document.createElement('script')
        s.src = 'app.js'
        s.onerror = show
        document.body.appendChild(s)
      }).catch(show)
    })()
  </script>
</body>
</html>`
}

/** 缺 app.js 时回的一段 JS：让已经加载好的页面把诊断信息画出来（而不是白屏或 raw JSON）。 */
export function missingAppJs({ missing = [], webRoot = '', version = '' } = {}) {
  const panel = missingAssetsPanel({ missing, webRoot, version })
  return `(function(){var r=document.getElementById('root')||document.body;r.innerHTML=${JSON.stringify(panel)};})()`
}

/** 记一条缺资源日志（每个文件每进程只记一次，避免每次请求刷屏）。 */
async function noteMissingAssets(missing, webRoot, packageRoot) {
  for (const f of missing) {
    const key = `${webRoot}|${f}`
    if (loggedMissingAssets.has(key)) continue
    loggedMissingAssets.add(key)
    await appendCaptureLog({
      time: Date.now(),
      sessionId: 'system',
      action: f === 'app.js' ? 'fail' : 'warn',
      // 逐文件算措辞：只缺 index.html 时是「已用内置外壳兜底」，缺 app.js 才是「无法加载」
      reason: missingAssetsReason([f], packageRoot),
    }, process.env)
  }
}

/** 文件在不在（缺资源判定只看「读不到」这一种情况，不吞权限等其它错误）。 */
async function fileExists(file) {
  try { await fs.access(file); return true } catch { return false }
}

/** ENOENT / ENOTDIR 才算「资源缺失」，其它 IO 错误照旧走 500（不要把权限问题说成装坏了）。 */
function isMissingFile(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

export function startWebServer({ port = DEFAULT_WEB_PORT, vaultRoot = defaultVaultDir(), host = '127.0.0.1', webRoot = WEB_ROOT, packageRoot = path.join(__dirname, '..') } = {}) {
  const handleApi = createApi({
    vaultDir: () => vaultRoot,
    vaultRoots: () => [{ name: '', root: vaultRoot }],
    // 本进程监听的就是「常驻实例」本身：/version-check 与 /restart-self 都要钉在这个端口上
    selfPort: port,
    // 读 DSH 写入的共享配置文件 → web 端与 DSH 设置同步（不同步修复）
    getSettings: () => { try { return JSON.parse(readFileSync(configFilePath(process.env), 'utf8')) } catch { return {} } },
    getDshInfo: () => ({ name: 'deepseek-harness', label: 'DeepSeek Harness（当前宿主）', installed: true, memoryRecallTool: true, autoCapture: true, autoRecall: true, vaultDir: vaultRoot, version: VERSION }),
    // 独立 Web 页也能看「自动沉淀日志」：读宿主写的 JSONL（原来这里只能显示"不可用"）
    getCaptureLog: () => readCaptureLog(100, process.env),
    getCaptureHealth: async () => deriveHealth(await readCaptureLog(50, process.env)),
  })

  // 共享配置文件变化 → 即时推给已打开的独立页（DSH 端一保存，这边不用刷新就能看到）
  try {
    // 监听**文件本身**而不是父目录（同 lib/config-sync.js 的说明）：
    // 父目录被删除时 Windows 上 libuv 会断言崩溃，监听文件只会得到 ENOENT。
    const cfgFile = configFilePath(process.env)
    const w = watch(cfgFile, () => {
      broadcast('config', { at: Date.now(), source: 'file' })
    })
    if (typeof w.unref === 'function') w.unref()
  } catch { /* 监听失败不影响服务；客户端仍会在操作时重新拉取 */ }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const p = url.pathname
      if (p.startsWith(API_PREFIX)) return await handleApi(req, res)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
      }
      if (p === '/' || p === '/index.html') {
        try {
          const buf = await fs.readFile(path.join(webRoot, 'index.html'))
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
          return res.end(buf)
        } catch (error) {
          if (!isMissingFile(error)) throw error
          // 缺 index.html：app.js 还在就自救（内置外壳把 UI 拉起来），否则连它一起报出来
          const appOk = await fileExists(path.join(webRoot, 'app.js'))
          const missing = appOk ? ['index.html'] : ['index.html', 'app.js']
          await noteMissingAssets(missing, webRoot, packageRoot)
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
          return res.end(missingIndexHtml({ missing, webRoot, version: VERSION }))
        }
      }
      if (p === '/app.js') {
        let buf
        try {
          buf = await fs.readFile(path.join(webRoot, 'app.js'))
        } catch (error) {
          if (!isMissingFile(error)) throw error
          // 回一段 JS 而不是 raw JSON：页面里能看到人话诊断
          await noteMissingAssets(['app.js'], webRoot, packageRoot)
          buf = Buffer.from(missingAppJs({ missing: ['app.js'], webRoot, version: VERSION }), 'utf8')
        }
        // 自包含 bundle 约 270KB，每次打开独立 Web 页都要重下 —— 协商 gzip 时压缩传输
        const headers = { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding' }
        const { body: out, encoding } = encodeBody(res, buf)
        if (encoding) headers['Content-Encoding'] = encoding
        headers['Content-Length'] = out.length
        res.writeHead(200, headers)
        return res.end(out)
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }))
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const missing = missingWebAssets(packageRoot)
      if (missing.length) {
        // 启动即暴露（别等用户点开「记忆」才发现）：消息与自动沉淀日志里那句一致
        process.stderr.write(`[memory-eternal] ${missingAssetsReason(missing, packageRoot)}\n`)
        void noteMissingAssets(missing, webRoot, packageRoot)
      }
      process.stderr.write(`[memory-eternal] web server on http://${host}:${port} (vault: ${vaultRoot}, web: ${webRoot})\n`)
      resolve({ server, port, host, url: `http://${host}:${port}`, webRoot, missingAssets: missing })
    })
  })
}

/** 探测某端口是否已是本项目的 web server（响应 /api/overview 且带 vaultDir 标记）。 */
export async function probeWebServer(port = DEFAULT_WEB_PORT, timeoutMs = 800) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${API_PREFIX}/overview`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const data = await res.json()
    if (data && data.ok === true && typeof data.vaultDir === 'string') return data
    return null
  } catch {
    return null
  }
}

/**
 * 确保 web server 存活（默认开启的实现核心）。
 * 已活 → 直接返回 URL；未活 → detached spawn 独立进程并轮询探活。
 * 端口被非本项目进程占用时向后漂移（+1..+10）。
 * @returns {Promise<{url:string, port:number, spawned:boolean}>}
 */
export async function ensureWebServer({ port = DEFAULT_WEB_PORT, vaultRoot = defaultVaultDir(), spawnEnv = {}, totalTimeoutMs = 15000 } = {}) {
  // 探测可用端口：先找「已是我们的服务」的端口，再找空闲端口
  let target = port
  let found = null
  for (let p = port; p < port + 10; p++) {
    const alive = await probeWebServer(p)
    if (alive) { found = { url: `http://127.0.0.1:${p}`, port: p, spawned: false }; break }
    // 该端口不是我们的服务：若连不上（空闲）就用它；连得上但不是我们的（被占用）则漂移
    const isFree = await probeWebServer(p, 300) === null && await isPortConnectable(p) === false
    if (isFree) { target = p; break }
    target = p + 1
  }
  if (found) return found

  // detached spawn：独立进程，父进程退出不影响（常驻）；stdio ignore 防阻塞。
  // 注意用 nodeBinary() 而不是 process.execPath：在 Electron 宿主里后者是
  // Electron 主程序，spawn 出来不会执行 web.js（见 lib/node-bin.js）。
  const { spawn } = await import('node:child_process')
  const child = spawn(
    nodeBinary(),
    [path.join(__dirname, 'web.js'), '--port', String(target), '--vault', vaultRoot],
    { detached: true, stdio: 'ignore', env: childEnv({ ...spawnEnv, MEMORY_VAULT_DIR: vaultRoot }), windowsHide: true },
  )
  // spawn 失败（ENOENT/EACCES/...）默认是静默的，这里显式暴露出来
  child.on('error', (error) => {
    process.stderr.write(`[memory-eternal] web server spawn failed (${nodeBinary()}): ${error?.message || error}\n`)
  })
  child.unref()

  const deadline = Date.now() + totalTimeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400))
    const alive = await probeWebServer(target)
    if (alive) return { url: `http://127.0.0.1:${target}`, port: target, spawned: true }
  }
  throw new Error(`[memory-eternal] web server 未能在 ${totalTimeoutMs}ms 内就绪 (port ${target})`)
}

async function isPortConnectable(port) {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const s = new net.Socket()
    s.setTimeout(300)
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('timeout', () => { s.destroy(); resolve(false) })
    s.once('error', () => resolve(false))
    s.connect(port, '127.0.0.1')
  })
}

// -- 脚本入口 -----------------------------------------------------------------
const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
}
if (process.argv[1] && /[\\/]web\.js$/.test(process.argv[1])) {
  const port = Number(argOf('--port')) || DEFAULT_WEB_PORT
  const vault = argOf('--vault') || defaultVaultDir()
  startWebServer({ port, vaultRoot: path.resolve(vault) })
  // 常驻：不主动退出；Ctrl+C / 进程被杀即停
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}
