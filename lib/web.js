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
import { promises as fs, readFileSync, watch, existsSync, mkdirSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { flushAllRecall } from './recall-track.js'
import { createApi, API_PREFIX, LEGACY_API_PREFIX, encodeBody, broadcast, SECURITY_HEADERS } from './api.js'
import { resolveVaultRoot, writeActiveVault, vaultPrefPath } from './vault-pref.js'
import { pruneActivityLogOnBoot, getDb, closeDb, DB_FILE, dbFileIn } from './db.js'
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

/**
 * 静态页/静态资源的统一安全响应头（审计 M1）。
 *
 * 为什么需要：页面（含云端令牌所在的 localStorage）跑在这里，而当时全站**零安全头** ——
 * 一次同源脚本注入就能直取令牌。`X-Content-Type-Options` 挡类型嗅探，
 * `Referrer-Policy` 挡 referer 外泄，CSP 是最后一道兜底（见 api.js 的 SECURITY_HEADERS 说明，
 * 其中 `frame-ancestors` 额外放行 `dsh-app:`，否则 DSH 桌面端的 iframe 面板会被拒载）。
 */
const securityHeaders = (extra = {}) => ({ ...SECURITY_HEADERS, ...extra })

/** CSP nonce（内置自救外壳的内联脚本用）。 */
const cryptoNonce = () => randomBytes(12).toString('base64')

/**
 * **私有模块存在性探测**（不随开源包发布的那几个）。
 *
 * 为什么需要：`package.json` 的 `files` 已经把商用私有件排除在开源包之外
 * （cloud-server / cloud-auth / license / entitlement / oidc / webhook / billing /
 * subscription-sync / subscription-audit）。开源包里动态 import 它们必然 ERR_MODULE_NOT_FOUND，
 * 而「每小时那轮订阅核对」如果每次都 try/catch 打一行日志，开源用户就会每小时看到一条
 * 莫名其妙的「模块不存在」噪音。所以：**一次判定，不存在就静默跳过，一个字都不打**。
 */
const privateModuleCache = new Map()
function hasPrivateModule(name) {
  if (privateModuleCache.has(name)) return privateModuleCache.get(name)
  let ok = false
  try { ok = existsSync(new URL(name, import.meta.url)) } catch { ok = false }
  privateModuleCache.set(name, ok)
  return ok
}

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
export function missingIndexHtml({ missing = [], webRoot = '', version = '', nonce = '' } = {}) {
  const panel = missingAssetsPanel({ missing, webRoot, version })
  // 内置外壳用**内联脚本**自救（探一下 app.js 在不在），CSP 默认会拦掉它。
  // 不走 'unsafe-inline'：给它一个一次性 nonce，既允许这一小段脚本，又不放宽整页策略。
  const nonceAttr = nonce ? ` nonce="${esc(nonce)}"` : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#1e232c" />
<title>记忆核心 · Memory Eternal</title>
<style>${BROKEN_CSS}
  html, body { height: 100%; }
  #root { min-height: 100vh; }
</style>
</head>
<body>
  <div id="root"></div>
  <div id="me-broken-host" style="display:none">${panel}</div>
  <script${nonceAttr}>
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

export function startWebServer({ port = DEFAULT_WEB_PORT, vaultRoot = '', host = '127.0.0.1', webRoot = WEB_ROOT, packageRoot = path.join(__dirname, '..') } = {}) {
  // 动态改端口：真正实现在 listen 成功后赋值（这里先占位，未就绪时调用会得到明确错误）
  let relisten = async () => ({ ok: false, error: 'web server 还没就绪' })
  let scheduleRelisten = () => ({ ok: false, error: 'web server 还没就绪' })
  // 当前库解析优先级：显式传参(--vault) > 共享偏好文件 > 默认路径。
  // 共享偏好让「web 端切了库」与「DSH 插件端」能对齐，不必两边各记一份。
  const vaultResolved = resolveVaultRoot({ explicit: vaultRoot, fallback: defaultVaultDir() })
  vaultRoot = vaultResolved.root
  // 启动时按配置清一次超期日志（保留天数来自 config.logRetentionDays，默认 30）。
  // 放在后台：清理是旁路，不该拖慢端口监听。
  setTimeout(() => {
    try {
      const n = pruneActivityLogOnBoot(vaultRoot)
      if (n > 0) process.stderr.write('[memory-eternal] 已清理 ' + n + ' 条超期操作日志\n')
    } catch { /* 忽略 */ }
  }, 3000)

  // 启动即做一次「灾难自动还原」体检（不阻塞端口监听：放在后台）。
  //
  // 为什么常驻 web 也必须做：本进程是 7×24 一直活着的那个（比 DSH 活得久）。
  // 主库半夜被写坏、DSH 白天才启动 —— 这中间所有面板请求都只能看到空库，而没人去还原。
  // 判定/还原/留证/审计全在 lib/auto-restore.js，与宿主、看门狗共用同一份实现。
  ;(async () => {
    try {
      const { ensureHealthy } = await import('./auto-restore.js')
      const r = await ensureHealthy(vaultRoot)
      if (r && r.action === 'restored') {
        console.error(`[memory-eternal] 记忆库损坏 → 已用备份自动还原：${r.from}（恢复 ${r.cards} 张卡；原现场留证 ${r.movedAside?.length ?? 0} 项）`)
      }
    } catch (error) {
      console.error('[memory-eternal] auto-restore failed:', error?.message || error)
    }
  })()
  /**
   * 运行中热切库（不重启进程、不刷新页面）。
   *
   * 为什么以前只能"重启后生效"：vaultRoot 是启动参数，进程一起来所有 SQL 连接就钉在它上面。
   * 现在把它当成**可变的当前库**：先确认目标库真的打得开（建表 + 写探针），再改指向，
   * 最后把共享偏好一起写掉 —— 本次立即生效，下次重启也还是这个库。
   *
   * 旧库连接**延后 5 秒**再关：可能还有在途请求握着它的语句句柄，立刻 close 会把那些请求炸掉。
   * 多留 5 秒的代价只是一个空闲句柄，划算。
   */
  /**
   * 允许热切的**库根**：当前库 + 当前库的同级目录。
   *
   * 为什么是这两处：本地用户的多库都在 `$DSH_HOME/memory-vault*`（当前库与它的兄弟目录），
   * `/api/vaults` 枚举出来的也正是这些。云端实例（cloud-vaults 下）不暴露热切 ——
   * 租户换库应该走 `/vaults/create` + 服务端拼路径，而不是让请求指定目录。
   */
  const switchAllowedRoots = () => {
    const cur = path.resolve(vaultRoot)
    return [cur, path.dirname(cur)]
  }
  const switchPathAllowed = (abs) => switchAllowedRoots().some((r) => abs === r || abs.startsWith(r + path.sep))

  const switchVault = async (rawTarget) => {
    const target = String(rawTarget || '').trim() ? path.resolve(String(rawTarget).trim()) : ''
    if (!target) return { ok: false, error: '路径为空' }
    const prev = path.resolve(vaultRoot)
    if (target === prev) return { ok: true, hot: true, root: target, prev, isCurrent: true, message: '已经是当前库' }
    // ★ 审计 H6：旧实现先 `mkdirSync(target, {recursive:true})` 再 `ensureVault(target)` ——
    //   等于「请求里的任意路径都能建目录 + 建库」，插件权限下可以在任意位置落地文件。
    //   现在只接受**已存在于允许根内**的记忆库：不建目录、不建库，只切换。
    if (!switchPathAllowed(target)) {
      return {
        ok: false, code: 'PATH_NOT_ALLOWED', error: 'path-not-allowed',
        hint: '只能切到当前库或它的同级记忆库（$DSH_HOME 下的 memory-vault*）',
      }
    }
    let isDir = false
    try { isDir = statSync(target).isDirectory() } catch { isDir = false }
    if (!isDir) {
      return { ok: false, code: 'PATH_NOT_ALLOWED', error: 'path-not-allowed', hint: '目标库不存在：' + target }
    }
    if (!existsSync(path.join(target, dbFileIn(target)))) {
      return { ok: false, code: 'PATH_NOT_ALLOWED', error: 'path-not-allowed', hint: '目标不是记忆库（缺 ' + DB_FILE + '）：' + target }
    }
    // 先开一次目标库：打不开就别切 —— 否则面板会整体落进一个坏库，比不切更糟
    // （动态 import：ensureVault 在 vault.js，静态引进来会把整条 vault 依赖打进 web 启动路径）
    try { getDb(target) } catch (e) {
      return { ok: false, error: '目标库打不开：' + String((e && e.message) || e) }
    }
    vaultRoot = target
    let prefFile = ''
    try { const w = writeActiveVault(target, process.env); if (w && w.ok) prefFile = w.file } catch { /* 偏好写不进去不影响本次切换 */ }
    try { broadcast('vault', { at: Date.now(), root: target, prev }) } catch { /* 没有订阅者也无妨 */ }
    setTimeout(() => { try { closeDb(prev) } catch { /* 已关或从未打开 */ } }, 5000)
    return { ok: true, hot: true, root: target, prev, isCurrent: true, prefFile, message: '已切到 ' + path.basename(target) }
  }

  // ── 跨进程跟随：别处（DSH 内嵌面板 / CLI）切库，本实例跟着切，不用重启 ──────────
  //
  // 为什么需要：DSH 面板的 API 跑在宿主进程里，7999 这个常驻实例是**另一个进程**。
  // 用户在宿主面板里切了库，如果不跟随，本页还在读旧库 —— 两边看到的不是同一份记忆，
  // 用户只会得到「切了库但页面还是旧数据」的结论。
  //
  // 为什么轮询而不是 fs.watch：偏好文件在「从没切过库」时并不存在（watch 直接 ENOENT），
  // 而 Windows 上 watch 父目录在目录被删时会崩。3 秒读一个几百字节的 JSON，代价可以忽略。
  try {
    const prefFile = vaultPrefPath(process.env)
    // 关键：把**启动那一刻**的偏好当作基线，之后只跟随「变化」。
    // 否则显式 --vault 会被一份历史偏好悄悄推翻（"我明明指定了库，它自己跑了"）。
    let last = ''
    try { last = readFileSync(prefFile, 'utf8') } catch { /* 从没切过库：没有文件 */ }
    const timer = setInterval(() => {
      let raw = ''
      try { raw = readFileSync(prefFile, 'utf8') } catch { return }   // 还没切过库：没有文件，正常
      if (raw === last) return
      last = raw
      let next = ''
      try { next = String(JSON.parse(raw).path || '').trim() } catch { return }
      if (!next) return
      const want = path.resolve(next)
      if (want === path.resolve(vaultRoot)) return
      switchVault(want).then((r) => {
        if (r && r.ok && r.prev && r.prev !== r.root) {
          process.stderr.write('[memory-eternal] 跟随共享偏好切库：' + r.prev + ' → ' + r.root + '\n')
        }
      }).catch(() => { /* 跟随失败不影响本实例 */ })
    }, 3000)
    if (typeof timer.unref === 'function') timer.unref()
  } catch { /* 跟随机制起不来也不影响服务 */ }

  const handleApi = createApi({
    vaultDir: () => vaultRoot,
    vaultRoots: () => [{ name: '', root: vaultRoot }],
    switchVault,
    // 本进程监听的就是「常驻实例」本身：/version-check 与 /restart-self 都要钉在这个端口上
    selfPort: port,
        relisten: (pp) => relisten(pp),
        scheduleRelisten: (pp) => scheduleRelisten(pp),
        relisten,
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
    // 监听器的**运行期**错误必须自己吃掉：配置文件后来被删/被换盘（测试清理、用户换 DSH_HOME）
    // 时 fs.watch 会异步抛 EPERM/ENOENT，没人接就是 uncaughtException —— 为了一个「配置变了」的
    // 便利通知把整个 web 进程带走，代价完全不对等。
    try { w.on('error', () => { /* 忽略：客户端操作时仍会重新拉配置 */ }) } catch { /* 老实现没有 on */ }
    if (typeof w.unref === 'function') w.unref()
  } catch { /* 监听失败不影响服务；客户端仍会在操作时重新拉取 */ }

  // 云端多租户：`MEMORY_CLOUD=1` 时，API 请求先按 Authorization 解析租户，
  // 每个租户一个独立 vault（各自一个 SQLite）。默认关闭，单机/本地行为完全不变。
  //
  // **私有组件边界**：`cloud-server.js` / `cloud-auth.js` 属于商用私有部分，不随开源包发布
  // （见 package.json 的 files 与 docs/PRIVATE.md）。所以这里**不能静态 import** ——
  // 开源包里文件不存在会直接让插件启动失败。改成首次请求时动态加载：
  // 私有部署有文件就正常用；开源包装开关打开时给一句明确提示，本地模式完全不受影响。
  const cloudMode = String(process.env.MEMORY_CLOUD || '') === '1' || String(process.env.MEMORY_CLOUD || '').toLowerCase() === 'true'
  let cloudHandler = null
  let cloudLoadError = ''
  const getCloudHandler = async () => {
    // 已确定加载不了（文件不在包里）→ 直接返回，**提示只打一次**，不要每个请求都刷屏
    if (cloudHandler || cloudLoadError) return cloudHandler
    // 开源包里没有这个私有模块：给一句一次性提示（不重复、不每小时重复）
    if (!hasPrivateModule('./cloud-server.js')) {
      cloudLoadError = 'cloud-server.js 不在当前发行包内'
      console.error('[memory-eternal] 云端模块未安装（商用私有组件）：cloud-server.js 不在当前发行包内 —— 当前只有本地模式可用（这条只提示一次）')
      return null
    }
    try {
      const { createCloudServer } = await import('./cloud-server.js')
      cloudHandler = createCloudServer({
        env: process.env,
        version: String(process.env.MEMORY_VERSION || ''),
        onSettings: () => { try { return JSON.parse(readFileSync(configFilePath(process.env), 'utf8')) } catch { return {} } },
      })
      console.error('[memory-eternal] 云端多租户模式已启用（每人一个独立 SQLite；密钥鉴权 + MengBot 授权）')
    } catch (e) {
      cloudLoadError = String((e && e.message) || e)
      console.error('[memory-eternal] 云端模块加载失败：' + cloudLoadError + ' —— 当前只有本地模式可用')
    }
    return cloudHandler
  }

  /** 读一个 cookie（极简实现，够用；不引依赖）。 */
  const readCookie = (header, name) => {
    const raw = String(header || '')
    if (!raw) return ''
    for (const part of raw.split(';')) {
      const i = part.indexOf('=')
      if (i < 0) continue
      if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
    }
    return ''
  }

  /**
   * 校验会话 cookie 是否指向一个有效租户。
   * 用 cloud-auth 的 resolveTenant（与 API 鉴权同一套判断），避免两套逻辑打架。
   */
  const verifyCloudSession = async (token) => {
    try {
      const { resolveTenant } = await import('./cloud-auth.js')
      const r = resolveTenant('Bearer ' + token, process.env)
      return !!(r && r.ok)
    } catch {
      return false
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      // 旧前缀兼容：/memory-eternal/api/xxx → /api/xxx（同一套 handler，行为完全一致）
      // 这样改主路径不会打断：已构建的客户端 bundle、peer/mcp 内部调用、
      // 以及 **MengBot OIDC 白名单里登记的 /memory-eternal/api/cloud/auth/callback**。
      let p = url.pathname
      if (p === LEGACY_API_PREFIX || p.startsWith(LEGACY_API_PREFIX + '/')) {
        p = API_PREFIX + p.slice(LEGACY_API_PREFIX.length)
        url.pathname = p
        // 必须连 req.url 一起改：下游 handleApi / cloudHandler 都是**自己解析 req.url** 的，
        // 只改本地变量等于没改（第一次改就踩了这个坑）。
        req.url = p + (url.search || '')
      }
      // 云端模式先确保私有模块真的在（getCloudHandler 内部只加载/提示一次）。
      // 不在包里 = 静默降级成本地模式：既不去请求 /cloud/*，也不套登录墙 ——
      // 否则开源用户开着 MEMORY_CLOUD=1 会被重定向到一个永远 404 的登录端点。
      const cloudHandlerNow = cloudMode ? await getCloudHandler() : null
      if (cloudMode && p.startsWith(API_PREFIX)) {
        if (cloudHandlerNow) {
          const handled = await cloudHandlerNow(req, res)
          if (handled) return
        }
      }
      if (p.startsWith(API_PREFIX)) return await handleApi(req, res)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, securityHeaders({ 'Content-Type': 'application/json' }))
        return res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
      }
      // 裸路径入口：memory-eternal 的官方地址
      if (p === '/memory-eternal') {
        res.writeHead(302, securityHeaders({ Location: '/memory-eternal/api/login', 'Cache-Control': 'no-store' }))
        return res.end()
      }
      if (p === '/favicon.ico') {
        try {
          const buf = await fs.readFile(path.join(packageRoot, 'assets', 'icon.png'))
          res.writeHead(200, securityHeaders({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }))
          return res.end(buf)
        } catch { /* 没图标就落到后面 404 */ }
      }
      if (p === '/' || p === '/index.html') {
        // 云端模式的登录墙：没有有效会话就先去 MengBot 登录，登录后回跳原地址。
        // 不加这一道的话，公网任何人打开 `https://<域名>/` 都能直接看到客户端界面
        // （API 仍然是 401，但界面本身不该对外暴露）。
        if (cloudMode && cloudHandlerNow) {
          const tok = readCookie(req.headers.cookie, 'me_cloud_token')
          const verified = tok ? await verifyCloudSession(tok) : false
          if (!verified) {
            const host = String(req.headers.host || '').trim()
            // 反代会带 x-forwarded-proto；本地直连（127.0.0.1/localhost）就是 http
            const isLocal = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)
            const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
              || (isLocal ? 'http' : 'https')
            // 进**我们自己的登录页**，而不是直接把用户甩去 MengBot：
            // 登录页里可以让用户选「扫码 / 密码 / 注册」，也有「没有账号？注册」入口。
            // 之前直接 302 到 /cloud/auth/start，浏览器跟随后 MengBot 授权页常返回 400，
            // 用户打开主页第一眼就是个错误页。
            const to = '/memory-eternal/api/login'
            res.writeHead(302, securityHeaders({ Location: to, 'Cache-Control': 'no-store' }))
            return res.end()
          }
        }
        try {
          const buf = await fs.readFile(path.join(webRoot, 'index.html'))
          res.writeHead(200, securityHeaders({ 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }))
          return res.end(buf)
        } catch (error) {
          if (!isMissingFile(error)) throw error
          // 缺 index.html：app.js 还在就自救（内置外壳把 UI 拉起来），否则连它一起报出来
          const appOk = await fileExists(path.join(webRoot, 'app.js'))
          const missing = appOk ? ['index.html'] : ['index.html', 'app.js']
          await noteMissingAssets(missing, webRoot, packageRoot)
          // 自救外壳的内联脚本要靠 nonce 才能在 CSP 下执行（不走 'unsafe-inline'）
          const nonce = cryptoNonce()
          res.writeHead(200, securityHeaders({
            'Content-Type': MIME['.html'],
            'Cache-Control': 'no-store',
            'Content-Security-Policy': SECURITY_HEADERS['Content-Security-Policy']
              .replace("script-src 'self'", "script-src 'self' 'nonce-" + nonce + "'"),
          }))
          return res.end(missingIndexHtml({ missing, webRoot, version: VERSION, nonce }))
        }
      }
      if (p.startsWith('/support/')) {
        const name = p.slice('/support/'.length)
        if (!/^[a-z0-9-]+\.(jpg|jpeg|png)$/i.test(name)) {
          res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }))
          return res.end('not found')
        }
        try {
          const buf = await fs.readFile(path.join(webRoot, 'support', name))
          res.writeHead(200, securityHeaders({
            'Content-Type': /\.png$/i.test(name) ? 'image/png' : 'image/jpeg',
            'Cache-Control': 'public, max-age=3600',
          }))
          return res.end(buf)
        } catch (error) {
          if (!isMissingFile(error)) throw error
          res.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }))
          return res.end('not found')
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
        const headers = securityHeaders({ 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding' })
        const { body: out, encoding } = encodeBody(res, buf)
        if (encoding) headers['Content-Encoding'] = encoding
        headers['Content-Length'] = out.length
        res.writeHead(200, headers)
        return res.end(out)
      }
      res.writeHead(404, securityHeaders({ 'Content-Type': 'application/json' }))
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    } catch (error) {
      // 响应已经发出去之后再抛错（例如业务逻辑在 return 之后还有异步尾巴）：
      // 旧代码无条件 res.end() 会触发 ERR_STREAM_WRITE_AFTER_END，**直接打挂进程** ——
      // 一个请求出错变成整站 502。这里先记日志，只在还能写的时候才补一个 500。
      console.error('[web] 请求处理抛错（headersSent=' + !!res.headersSent + '）：', String(error && error.stack || error).slice(0, 600))
      if (!res.headersSent) {
        res.writeHead(500, securityHeaders({ 'Content-Type': 'application/json' }))
        res.end(JSON.stringify({ ok: false, error: String(error?.message || error) }))
      } else if (!res.writableEnded) {
        try { res.end() } catch { /* 已经关了，忽略 */ }
      }
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
      process.stderr.write(`[memory-eternal] web server on http://${host}:${port} (vault: ${vaultRoot} [${vaultResolved.source}], web: ${webRoot})\n`)
      // ── MEM Pair 发现响应（局域网内其它 memory-eternal 广播 probe 时回一张名片）──
      // 只回名片、不做任何写入；配对永远要人在面板点确认。默认开，MEMORY_PEER=0 可关。
      try {
        if (String(process.env.MEMORY_PEER || '') !== '0') {
          // listen 的回调不是 async —— 用 IIFE 包一层动态 import
          void (async () => {
            const { readIdentity, startDiscoveryResponder } = await import('./peer.js')
            const dport = Number(process.env.MEMORY_PEER_DISCOVERY_PORT) || 7990
            const id = readIdentity()
            startDiscoveryResponder(id, {
              port,
              discoveryPort: dport,
              onLog: (e) => { if (e && e.event === 'probe') process.stderr.write(`[memory-eternal] peer probe from ${e.from} (${e.peer})\n`) },
            })
            process.stderr.write(`[memory-eternal] MEM Pair 发现响应已开（UDP ${dport}，实例 ${id.name}）\n`)
          })().catch((e) => {
            process.stderr.write(`[memory-eternal] MEM Pair 发现响应没起来：${String((e && e.message) || e)}\n`)
          })
        }
      } catch (e) {
        process.stderr.write(`[memory-eternal] MEM Pair 发现响应没起来：${String((e && e.message) || e)}\n`)
      }

      // ── 定时自动体检（默认关闭，用户显式开启才跑）────────────────────────
      // 每小时检查一次是否到了周期；真正的工作在 lib/auto-junk.js 里。
      // 只归档、绝不删除 —— 自动流程不该有不可逆的权力。
      try {
        const tick = async () => {
          try {
            const { tickAutoJunk } = await import('./auto-junk.js')
            const settings = (() => { try { return JSON.parse(readFileSync(configFilePath(process.env), 'utf8')) } catch { return {} } })()
            const r = await tickAutoJunk(vaultRoot, settings)
            if (r.ran) {
              process.stderr.write(`[memory-eternal] 自动体检：归档 ${r.result.archived} 张（候选 ${r.result.candidates}）\n`)
            }
          } catch (e) {
            process.stderr.write(`[memory-eternal] 自动体检失败：${String((e && e.message) || e)}\n`)
          }
        }
        const timer = setInterval(tick, 3600000)
        if (typeof timer.unref === 'function') timer.unref() // 别把进程钉住
        // 启动 3 分钟后先跑一次（避开启动高峰，也让「刚开启」的用户能较快看到效果）
        const first = setTimeout(tick, 180000)
        if (typeof first.unref === 'function') first.unref()
      } catch { /* 调度挂掉不影响 web 服务 */ }

      // ── 每日订阅核对（云端才需要；未配 mbt_ 令牌时自动跳过）──────────────
      // webhook 是推送（对方重试只有 36 秒），按需对账只在有人访问时发生 ——
      // 如果一个付费用户一个月不登录，他的套餐状态就错一个月。这里补一封底：
      // 每小时检查是否到了周期（默认 24h），真跑一轮全量核对。
      // **只记差异、绝不自动改**（批量 force 对账一旦 owner 映射出错会一次性误降级一批人）。
      try {
        let auditing = false
        const auditTick = async () => {
          if (auditing) return
          // 开源包里没有这两个私有模块（依赖已被排除的 entitlement / cloud-auth）：
          // **直接静默返回**，一个字都不打 —— 半发货状态下运行期只会抛 ERR_MODULE_NOT_FOUND。
          if (!hasPrivateModule('./subscription-audit.js') || !hasPrivateModule('./subscription-sync.js')) return
          try {
            const { auditDue, runAudit } = await import('./subscription-audit.js')
            const { syncReady } = await import('./subscription-sync.js')
            if (!syncReady(process.env)) return
            if (!auditDue(process.env)) return
            auditing = true
            const r = await runAudit({ env: process.env })
            if (!r.ok) return
            process.stderr.write(
              `[memory-eternal] 订阅核对：核 ${r.checked}/${r.scanned} 个租户，差异 ${r.diffs.length} 处` +
              (r.diffs.length ? '（详见 GET /cloud/billing/audit，需人工确认，不会自动改）' : '') + '\n',
            )
          } catch (e) {
            process.stderr.write(`[memory-eternal] 订阅核对失败：${String((e && e.message) || e)}\n`)
          } finally {
            auditing = false
          }
        }
        const auditTimer = setInterval(auditTick, 3600000)
        if (typeof auditTimer.unref === 'function') auditTimer.unref()
        // 启动 10 分钟后先跑一次（避开启动高峰与部署重启窗口）
        const auditFirst = setTimeout(auditTick, 600000)
        if (typeof auditFirst.unref === 'function') auditFirst.unref()
      } catch { /* 调度挂掉不影响 web 服务 */ }

      // ── 动态改端口 ────────────────────────────────────────────────────────
      // 面板/CLI 调 POST /web/port 时走这里：先关旧 listener，再在新端口 listen；
      // 新端口起不来 → 退回旧端口并把错误抛回去，服务不会因为改端口而挂掉。
      relisten = async (wantPort) => {
        const target = Number(wantPort)
        if (!Number.isInteger(target) || target < 1 || target > 65535) return { ok: false, error: '端口必须是 1–65535 的整数' }
        if (target === port) return { ok: true, port, url: `http://${host}:${port}`, unchanged: true }
        const closeP = () => new Promise((res) => { try { server.close(() => res()) } catch { res() } })
        const listenP = (pp) => new Promise((res, rej) => {
          const onErr = (e) => { server.removeListener('error', onErr); rej(e) }
          server.once('error', onErr)
          server.listen(pp, host, () => { server.removeListener('error', onErr); res() })
        })
        await closeP()
        try {
          await listenP(target)
        } catch (e) {
          // 回滚到旧端口（尽力而为）
          try { await listenP(port) } catch { /* 端口全丢时只能报错 */ }
          return { ok: false, error: '新端口起不来（' + target + '）：' + String((e && e.message) || e) + '，已退回 ' + port }
        }
        const prev = port
        port = target
        // 锁文件同步（有锁且锁里是我们的旧端口时才改）
        try {
          const { default: fsx } = await import('node:fs')
          const lockPath = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory-eternal-watchdog.json')
          if (fsx.existsSync(lockPath)) {
            const j = JSON.parse(fsx.readFileSync(lockPath, 'utf8'))
            const list = Array.isArray(j.watchdogs) ? j.watchdogs : []
            let touched = false
            for (const w of list) if (Number(w.port) === prev) { w.port = target; w.webPort = target; touched = true }
            if (touched) fsx.writeFileSync(lockPath, JSON.stringify(j, null, 2))
          }
        } catch { /* 锁没改也不影响服务 */ }
        process.stderr.write(`[memory-eternal] web 端口已从 ${prev} 改为 ${target}\n`)
        return { ok: true, port, prev, url: `http://${host}:${port}` }
      }

      // 延迟切换：先让当前请求把响应写回客户端，再关旧 listener / 起新 listener。
      // （直接 close 会把正在处理的这个请求的连接一起关掉，客户端只看到空响应）
      scheduleRelisten = (wantPort) => {
        const target = Number(wantPort)
        if (!Number.isInteger(target) || target < 1 || target > 65535) return { ok: false, error: '端口必须是 1–65535 的整数' }
        setTimeout(() => {
          relisten(target).then((r) => {
            process.stderr.write('[memory-eternal] 改端口结果：' + JSON.stringify(r) + '\n')
          }).catch((e) => {
            process.stderr.write('[memory-eternal] 改端口失败：' + String((e && e.message) || e) + '\n')
          })
        }, 250)
        return { ok: true, pending: true, port: target, prev: port, url: `http://${host}:${target}` }
      }

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
 * 宽松判定：这个端口上是不是**自家的 web**（旧版可能不自报 version / vaultDir，严格探针会判否）。
 *
 * 为什么需要（issue #29）：升级期端口被**自家旧包**的 detached 实例占着时，严格探针认不出它，
 * `ensureWebServer()` 就会向后漂到一个空端口 → 一段窗口里同时存在两个实例、两个端口，
 * 而宿主记录的 `web-info` 指向的可能是随后被自愈收掉的那个。多探几个自家路由即可识别。
 */
export async function looksLikeOurWeb(port = DEFAULT_WEB_PORT, timeoutMs = 600) {
  for (const suffix of ['/overview', '/web-info', '/budget']) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${API_PREFIX}${suffix}`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) continue
      const data = await res.json().catch(() => null)
      if (data && typeof data === 'object' && data.ok === true) return true
    } catch { /* 换下一个探针 */ }
  }
  return false
}

/** 等端口上的自家实例变成「可严格识别」（自愈替换完成）—— 期间它可能被清掉再拉起。 */
async function waitForOurWeb(port, timeoutMs = 6000, intervalMs = 500) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  for (;;) {
    if (await probeWebServer(port)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, Math.max(100, Number(intervalMs) || 500)))
  }
}

/**
 * 确保 web server 存活（默认开启的实现核心）。
 * 已活 → 直接返回 URL；未活 → detached spawn 独立进程并轮询探活。
 * 端口被非本项目进程占用时向后漂移（+1..+10）。
 * @returns {Promise<{url:string, port:number, spawned:boolean}>}
 */
/**
 * 强制接管端口上的**自家旧 web**：收掉它、等端口空出来（issue #30 第四点：锁不可写的机器上
 * 看门狗路径被永久拒绝，只能由**宿主**自己把常驻实例换掉 —— 宿主能写、也能 kill 自己人的进程）。
 *
 * 安全闸门：只对 `looksLikeOurWeb(command)` 为真的占用者下手；别人的进程一个都不许动。
 *
 * @returns {Promise<{took:boolean, pid:number, reason:string}>}
 */
export async function takeoverOwnWeb(port, { findListener, kill, sleep, looksLike, timeoutMs = 4000 } = {}) {
  const p = Number(port) || DEFAULT_WEB_PORT
  const find = findListener || (await import('./watchdog.js')).findPortListener
  const isOurs = looksLike || looksLikeOurWeb
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const killFn = kill || ((pid) => { try { process.kill(pid, 'SIGTERM'); return true } catch { return false } })
  let occ = null
  try { occ = await find(p) } catch { occ = null }
  if (!occ || !occ.pid) return { took: false, pid: 0, reason: '端口上没有占用者' }
  if (!isOurs(occ.command)) return { took: false, pid: Number(occ.pid), reason: '占用者不是本插件的 web（' + (occ.command || '命令行未知') + '）→ 不动它' }
  let alive = true
  try { alive = await isOurs(p) } catch { alive = true }
  void alive
  if (!killFn(occ.pid)) return { took: false, pid: Number(occ.pid), reason: '终止失败（可能无权限）' }
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  while (Date.now() < deadline) {
    await wait(200)
    let left = null
    try { left = await find(p) } catch { left = null }
    if (!left || !left.pid) return { took: true, pid: Number(occ.pid), reason: '已收掉自家旧 web' }
  }
  return { took: false, pid: Number(occ.pid), reason: '已发出终止但端口仍被占用' }
}

export async function ensureWebServer({ port = DEFAULT_WEB_PORT, vaultRoot = defaultVaultDir(), spawnEnv = {}, totalTimeoutMs = 15000, takeoverWaitMs = 6000, forceTakeover = false, deps = {} } = {}) {
  // 探测可用端口：先找「已是我们的服务」的端口，再找空闲端口
  let target = port
  let found = null
  // 强制接管（issue #30 ④）：宿主自管的机器上，先把自家旧实例收掉，再在原端口起新的 ——
  // 不这么做就会走到下面的「让位到 port+1」，于是既换不掉旧的、又多出一个实例。
  if (forceTakeover) {
    try {
      const r = await takeoverOwnWeb(port, { findListener: deps.findListener, kill: deps.kill, sleep: deps.sleep, timeoutMs: Math.max(1500, Math.min(5000, totalTimeoutMs)) })
      process.stderr.write(`[memory-eternal] 强制接管端口 ${port}：${r.reason}${r.pid ? '（pid ' + r.pid + '）' : ''}\n`)
    } catch (e) { process.stderr.write(`[memory-eternal] 强制接管失败：${String((e && e.message) || e)}\n`) }
  }
  for (let p = port; p < port + 10; p++) {
    const alive = await probeWebServer(p)
    if (alive) { found = { url: `http://127.0.0.1:${p}`, port: p, spawned: false }; break }
    // 该端口不是我们的服务：若连不上（空闲）就用它；连得上但不是我们的（被占用）则漂移
    if (await isPortConnectable(p) === false) { target = p; break }
    // issue #29：占用者「像自家的 web、但严格探针认不出」（升级期旧包的 detached 实例）时，
    // **不要立刻漂到 port+1** —— 自愈（restartResident）马上会把配置端口上的实例换成新版，
    // 这时另起一个端口只会多出一个实例、并让 web-info 指向随后被收掉的那个（客户端 iframe
    // 于是「拒绝连接」）。先等它接管；等不到再漂，并留下一条能查的日志。
    if (await looksLikeOurWeb(p)) {
      if (await waitForOurWeb(p, takeoverWaitMs)) { found = { url: `http://127.0.0.1:${p}`, port: p, spawned: false }; break }
      if (await isPortConnectable(p) === false) { target = p; break }
      process.stderr.write(`[memory-eternal] 端口 ${p} 被自家旧实例占着且 ${takeoverWaitMs}ms 内没让位 → 向后找空闲端口（web-info 会实时收敛，issue #29）\n`)
    }
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
  // 不在这里补默认值：留空才能让 resolveVaultRoot 去读共享偏好（否则偏好永远被盖住）
    const vault = argOf('--vault') || ''
  // --host：云端部署时绑到 docker 网桥网关（如 172.17.0.1），既让同机 Caddy 容器反代得到，
  // 又不把端口暴露到公网。默认保持 127.0.0.1（本机专用）。
  const host = argOf('--host') || undefined
  startWebServer({ port, ...(vault ? { vaultRoot: path.resolve(vault) } : {}), ...(host ? { host } : {}) })
  // 常驻：不主动退出；Ctrl+C / 进程被杀即停
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
  // 召回计数是「内存累积 + 批量刷写」（见 lib/recall-track.js）：
  // 退出前同步刷一次，别把最后几秒的计数丢掉。flush 本身同步，exit 钩子里能跑完。
  process.on('exit', () => {
    try { flushAllRecall() } catch { /* 忽略 */ }
  })
}
