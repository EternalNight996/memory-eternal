// 记忆核心 · 知识库 JSON API（与宿主无关的纯 HTTP 层）。
//
// 从 index.js 抽出的 handleApi/json：逻辑原封不动，仅把对 DSH 闭包
// （vaultDir/vaultRoots/settings）的依赖改为通过 createApi(deps) 注入，
// 使 DSH 插件（经 webServer 前缀路由）与独立 Web server（lib/web.js）
// 共用同一份 API 实现。
//
// deps:
// - vaultDir()  → 当前激活 vault 根目录（string）
// - vaultRoots() → [{ name, root }] 全部 profile 根（跨库聚合用）
// - getSettings() → 插件设置对象（/budget /compress 读取；可选，缺省 {}）
// - getCaptureLog() → 自动沉淀运行轨迹（DSH host 注入；独立 web server 无此数据）

import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import os from 'node:os'
import fs, { readFileSync } from 'node:fs'
import path from 'node:path'
import { isIP } from 'node:net'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { listCards, countCards, readCard, search, searchAll, graph, graphAll, graphLevel, topDegreeSubgraph, LEVEL_ERR_PATH, LEVEL_ERR_STALE, overview, exportCards, deleteCard, writeCard, parseCard, stats, optimizeCandidates, optimizeApply, addFeedback, dailyCounts, mergeCards, ensureVault, auditQueue, recycleList, purgeExpired, purgeAllRecycle, setCardStatus, setCardKind, restoreCard, mainStoreBodies, updateCardContent, reviseCard } from './vault.js'
import { compressExcerpt, guessRawKind, DEFAULT_CAPTURE_MAX_TOKENS } from './capture.js'
import { importChunk, extractCards, CHUNK_SIZE, MAX_CHUNK_BYTES } from './import-batch.js'
import { scanJunk, pickByFilter } from './junk.js'
import { buildDiagnostics } from './feedback.js'
import { FOLLOW_DOMAINS, parseFollowIntent, listFollows, saveFollow, removeFollow, refreshFollows, followItems, ensureDefaultFollow } from './news-follows.js'
import { buildDigest, readDigest, digestPrompt } from './news-digest.js'
import { getSetupStatus, runSetup, mcpAgentAction } from './setup.js'
import { ledgerSummary } from './ledger.js'
import { starPromptStatus, markStarAction } from './star-prompt.js'
import { resolvePayBase, resolveDomains } from './domains.js'
import { readWorking, writeWorking, clearWorking, listWorking, archiveWorking } from './working-memory.js'
import { backupDb, dbStatus, dbFileIn, renameDbFile, rebuildGuidance, withDbRetry, listBackupFiles, readBackupState, normalizeRetention, getDb, closeAllDb, DB_FILE, logActivity, localIPv4, ensureCardSequence } from './db.js'
import { listNews, getNews, saveNews, deleteNews, setNewsRead } from './news.js'
import { getNewsFeed, refreshNewsFeed } from './news-feed.js'
import { createHub } from './sse.js'
// MEM Pair（两个 memory-eternal 实例的配对/互推）：独立模块，命中 /peer/* 直接返回
import { handlePeerRoute } from './peer-routes.js'
// Agent MCP 挂载（默认不挂载，必须人工在面板挂）：同一套实现给 CLI 用
import { handleMcpMount } from './mcp-mount-http.js'
// MCP Streamable HTTP 端点（POST /api/mcp）：云端/浏览器 agent 不用装进程也能接
import { handleMcpHttp } from './mcp-http.js'
import { probeServedVersion, restartResident, currentPkgVersion, readWatchdogLock, isPidAlive, probeLockWritable } from './watchdog.js'

// 独立 web 的 SSE 中心：配置/数据变更即时推给已打开的页面（无需手动刷新）
const hub = createHub()
/** 供 lib/web.js 在检测到共享配置变化时广播。 */
export function broadcast(event, data) { return hub.broadcast(event, data) }

export const API_PREFIX = '/api'

/**
 * 旧前缀（兼容别名，唯一用途：接住外部已经登记的地址）。
 *
 * 代码内部已全部统一到 /api，这里保留是为了两件**不由我们控制**的事：
 *   ① MengBot OIDC 客户端白名单里登记的回调：
 *      https://mem.mengbot.vip/memory-eternal/api/cloud/auth/callback
 *      —— 对方没改白名单之前，改成新地址就是登录 400；
 *   ② 用户浏览器书签/扫码进过的旧链接。
 * 由 web.js 在入口重写成 /api，行为与直接访问完全一致。
 */
export const LEGACY_API_PREFIX = '/memory-eternal/api'

/** 用系统默认浏览器打开一个 URL（win: rundll32 / mac: open / linux: xdg-open）。 */
function spawnOpener(href) {
  try {
    let child
    if (process.platform === 'win32') child = spawn('rundll32', ['url.dll,FileProtocolHandler', href], { detached: true, stdio: 'ignore', windowsHide: true })
    else if (process.platform === 'darwin') child = spawn('open', [href], { detached: true, stdio: 'ignore' })
    else child = spawn('xdg-open', [href], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
    return { ok: true, url: href }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

// 浏览器/Electron 里 target=_blank 可能被宿主拦截；由本机 Node 进程调用系统默认浏览器。
// 只允许项目自己的 GitHub 地址，避免变成任意 URL 打开器。
/**
 * 「打开浏览器」类端点的**来源闸门 + 频率限制**。
 *
 * 为什么必须要：/open-web 与 /open-external 都是**无鉴权**端点。
 * 虽然浏览器跨域 fetch 会被 CORS 拦（我们没发 CORS 头），但
 * **<form> 提交不受 CORS 限制** —— 任意恶意页面可以
 *   <form action="http://127.0.0.1:7999/api/open-web" method="POST">
 * 然后用 JS 循环自动提交，把用户机器上的浏览器窗口刷爆。
 *
 * 两道闸：
 *   ① **Origin 校验**：允许无 Origin（服务端/原生客户端调用），
 *      或 Origin 的 host 是本机（127.0.0.1 / localhost / ::1）—— 那才是我们自己的 UI。
 *      其它一律拒（含 null / file:// / 任意公网站点）。
 *   ② **频率限制**：同一来源 3 秒内只允许 1 次。正常人不会连点，恶意循环会立即被挡。
 */
const OPENER_WINDOW_MS = 3000
const openerLastAt = new Map()

export function guardOpenerCall(req, name) {
  // ① Origin：没带（curl / 服务端 / 原生）或本机 UI 才放行
  const origin = String((req.headers && req.headers.origin) || '')
  if (origin && origin !== 'null') {
    let ok = false
    try {
      const h = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '')
      ok = h === '127.0.0.1' || h === 'localhost' || h === '::1'
    } catch { ok = false }
    if (!ok) return { ok: false, code: 'origin_denied', error: '跨域来源被拒绝：这些端点只接受本机 UI 调用' }
  } else if (origin === 'null') {
    // file:// 或沙箱 iframe 会发 Origin: null —— 不是我们的 UI
    return { ok: false, code: 'origin_denied', error: '沙箱来源被拒绝' }
  }

  // ② 频率：按「来源 + 端点」计数
  const key = String((req.socket && req.socket.remoteAddress) || '') + ':' + String((req.socket && req.socket.localPort) || '') + '|' + name
  const now = Date.now()
  const last = openerLastAt.get(key) || 0
  if (now - last < OPENER_WINDOW_MS) {
    return { ok: false, code: 'too_frequent', error: '操作太频繁：请等 ' + Math.ceil((OPENER_WINDOW_MS - (now - last)) / 1000) + ' 秒再试' }
  }
  openerLastAt.set(key, now)
  // 顺手清理过期项，避免 Map 无限增长
  if (openerLastAt.size > 200) {
    for (const [k, v] of openerLastAt) { if (now - v > 60000) openerLastAt.delete(k) }
  }
  return { ok: true }
}


/**
 * 从请求里取来源 IP（写操作日志用）。
 *
 * 本地服务的请求都来自回环，但**云端实例是多租户的** —— 日志里记谁发起才有意义。
 * 优先取反代头（Caddy/Nginx 会带 X-Forwarded-For），退回 socket 地址。
 */
function clientIpOf(req) {
  try {
    const xf = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim()
    if (xf) return xf.slice(0, 64)
    const real = String((req.headers && req.headers['x-real-ip']) || '').trim()
    if (real) return real.slice(0, 64)
    const addr = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '')
    if (addr && addr !== '127.0.0.1' && addr !== '::1') return addr.slice(0, 64)
  } catch { /* 忽略 */ }
  // 回环：退回本机局域网 IP，比 "127.0.0.1" 更能说明是哪台机器
  try { return localIPv4() } catch { return '127.0.0.1' }
}

function openExternalUrl(raw) {
  let u
  try { u = new URL(String(raw || '')) } catch { return { ok: false, error: 'bad url' } }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'url not allowed' }

  const host = String(u.hostname || '').toLowerCase()
  // ① 项目仓库
  const isRepo = (host === 'github.com' && u.pathname.startsWith('/EternalNight996/memory-eternal'))
    || (host === 'gitee.com' && u.pathname.startsWith('/eternal-night/memory-eternal'))
  if (isRepo) return spawnOpener(u.href)

  // ② 当前配置的云端域名（同步读配置，避免 async 化这个函数）。
  //    fs/os/path 都已在文件顶部 import，这里不能再 require（ESM 模块没有 require）。
  try {
    const home = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'memory-eternal-cloud-conn.json'), 'utf8'))
    const cloudHost = new URL(String(cfg.url || '')).hostname.toLowerCase()
    if (cloudHost && cloudHost === host) return spawnOpener(u.href)
  } catch { /* 没配置云端 → 只放仓库 */ }

  return { ok: false, error: 'url not allowed' }
}

/**
 * 「Web 版」入口只允许打开**本机**地址：127.0.0.1 / localhost / ::1 的 http(s)。
 * 这个端点没有鉴权（只监听 127.0.0.1 也不该给任意网页当跳板），所以必须白名单校验，
 * 绝不能退化成通用 URL 打开器。
 */
export function isLocalWebUrl(raw) {
  let u
  try { u = new URL(String(raw || '')) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/**
 * 独立 Web UI（浏览器版）的地址：优先取 watchdog 锁里记录的常驻端口，没有锁就退回 7999。
 * 为什么不是写死 7999：端口会漂移（自愈/占用），锁文件才是「真正在服务的那个实例」。
 */
export function residentWebUrl(portHint) {
  let port = Number(portHint) || 0
  if (!port) {
    try {
      const lock = readWatchdogLock(process.env)
      const list = lock && Array.isArray(lock.watchdogs) ? lock.watchdogs : []
      const alive = list.find((w) => w && w.port && (!w.pid || isPidAlive(w.pid)))
      port = Number((alive && alive.port) || (list[0] && list[0].port)) || 0
    } catch { /* 锁坏了就退回默认端口 */ }
  }
  return `http://127.0.0.1:${port || 7999}/`
}

/** 「Web 版」：用默认浏览器打开本机独立 Web UI（地址必须过本地白名单）。 */
export function openLocalWeb(raw) {
  const url = raw || residentWebUrl()
  if (!isLocalWebUrl(url)) return { ok: false, error: 'url not allowed' }
  return spawnOpener(url)
}

// npm 最新版本缓存（避免每次点「检查更新」都打 registry）
const versionCache = { at: 0, latest: '' }

// 「重启常驻实例」的并发闸门：连点两次不能起两个替换助手（后一个会让位退出，但白折腾一次）
let residentRestarting = false

/** 解析 `x.y.z[-pre]`；解析不出来返回 null。 */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' }
}

/**
 * 比较两个版本号（a>b → 1）。
 *
 * 为什么需要：`latest !== onDisk` 这种判断在**本地跑着未发布版本**时会给出误导性结论
 * （磁盘 v0.10.7、npm 还是 v0.10.6 → 面板提示「有新版本」并让你装回旧的）。
 * 预发布标识按 semver 口径比（点分标识、数字段按数值比）—— `rc.2 < rc.10` 不是字符串比较。
 */
export function compareVersions(a, b) {
  const A = parseVersion(a)
  const B = parseVersion(b)
  if (!A || !B) return 0
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1
  if (A.pre === B.pre) return 0
  if (!A.pre) return 1   // 正式版 > 预发布版
  if (!B.pre) return -1
  const as = A.pre.split('.')
  const bs = B.pre.split('.')
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i]
    const y = bs[i]
    if (x === undefined) return -1   // 前缀相同、标识更少的那个更小
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1
    if (nx !== ny) return nx ? -1 : 1 // 数字标识 < 字母标识
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * 本插件认可的 Host（**DNS rebinding 防护**）。
 *
 * 为什么必须校验 Host：只比 `Origin === Host` 是挡不住 **DNS rebinding** 的 ——
 * 攻击者让 `evil.com` 先解析到自己的服务器、TTL 到期后改解析到 `127.0.0.1`，
 * 浏览器认为请求与页面同源，于是 `Origin: http://evil.com:7999` 与 `Host: evil.com:7999`
 * **必然相等**，闸门放行，且响应对页面可读。结果是任意网页都能打 `/factory-reset`、
 * `/backup/import`、`/config`、`/setup-run`（这些端点本来就无鉴权）。
 *
 * 放行集（精确、可解释）：
 *   · IP 字面量（`127.0.0.1` / `192.168.1.5` / `[::1]`）—— DNS 造不出 IP 字面量，天然安全；
 *   · `localhost`；
 *   · 部署方显式配置的公开域名：`MEMORY_PUBLIC_HOST`、`MEMORY_CLOUD_PUBLIC_URL`、
 *     `MEMORY_PUBLIC_URL`、`MEMORY_TRUSTED_HOSTS`（逗号分隔）。
 * 也就是说：**DNS 名 + 没配置 = 拒绝**，反代/公网部署必须把域名写进上面任一变量。
 *
 * 没有 `Host` 头的请求视为非浏览器调用（curl / CLI / MCP / 内部调用）：浏览器发 HTTP/1.1
 * 请求**一定**带 Host，所以缺 Host 时不需要也不应该拦（拦了只会误伤本机工具链）。
 */
const trustedHosts = (env = process.env) => {
  const out = new Set()
  const add = (raw) => {
    const s = String(raw || '').trim().toLowerCase()
    if (!s) return
    // 值可能是完整 URL（MEMORY_CLOUD_PUBLIC_URL=https://mem.example.com/），也可能是裸主机名
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      try {
        const u = new URL(s)
        if (u.host) out.add(u.host.toLowerCase())
        const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
        if (h) out.add(h)
        return
      } catch { /* 不是合法 URL，按主机名处理 */ }
    }
    out.add(s)
    out.add(s.replace(/:\d+$/, ''))
  }
  for (const v of String(env.MEMORY_TRUSTED_HOSTS || '').split(',')) add(v)
  add(env.MEMORY_PUBLIC_HOST)
  add(env.MEMORY_CLOUD_PUBLIC_URL)
  add(env.MEMORY_PUBLIC_URL)
  return out
}

/** `host[:port]` → 裸主机名（小写、去 IPv6 方括号、去端口）。 */
const hostnameOf = (host) => String(host || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '')

/** 这个 Host 是不是「自己人」。没有 Host 头 = 非浏览器调用 → true（理由见上面注释）。 */
export function hostAllowed(headers, env = process.env) {
  const host = String((headers && headers.host) || '').trim().toLowerCase()
  if (!host) return true
  const name = hostnameOf(host)
  if (!name) return false
  if (isIP(name)) return true
  if (name === 'localhost') return true
  const extra = trustedHosts(env)
  return extra.has(host) || extra.has(name)
}

/**
 * 跨站写入防护：状态变更请求（非 GET/HEAD/OPTIONS）必须与请求自身的 Host **同源**。
 *
 * 为什么需要：插件 API 没有鉴权（本机任意页面都能 POST /config、/audit/approve、/write…）。
 * 浏览器发起跨站请求时**一定**会带 `Origin`，而我们的页面（DSH 设置页/记忆页 = 宿主同源、
 * 独立页 = 自己的 127.0.0.1:7999）带的 Origin 与 Host 同源 —— 于是「比对 Origin 与 Host」
 * 就能挡住恶意网页，同时不误伤局域网访问（LAN 下两者是同源的 192.168.x.x:port）。
 * 非浏览器调用（curl / CLI / MCP / 内部调用）没有 Origin，照常放行。
 *
 * **两道闸**（审计 H1）：
 *   ① Host 本身必须是自己人（IP 字面量 / localhost / 显式配置的公开域名）—— 挡 DNS rebinding；
 *   ② Origin 与 Host 同源，或 Origin 是本机 loopback（本机客户端 → 云端上传的正常链路）。
 *
 * @returns {string} '' = 放行；否则是给人看的原因（调用方回 403）
 */
export function crossOriginError(req) {
  const method = String((req && req.method) || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return ''
  const headers = (req && req.headers) || {}
  const origin = String(headers.origin || '').trim()
  if (!origin) return ''                       // 非浏览器调用（curl / CLI / MCP / 内部）：没有可比对的 Origin
  const host = String(headers.host || '').trim()
  const hostBlocked = 'Host 不在允许列表（DNS rebinding 防护）：' + host +
    ' —— 公网/反代部署请把域名写进 MEMORY_PUBLIC_HOST 或 MEMORY_CLOUD_PUBLIC_URL'
  if (origin === 'null') {
    // file:// 页面 / 沙箱 iframe：不是我们的 UI，只按 Host 闸门判
    return hostAllowed(headers) ? '' : hostBlocked
  }
  let parsed = null
  try { parsed = new URL(origin) } catch { return 'Origin 头不合法：' + origin }
  // 只有 http(s) 的 Origin 可能是**网页**；桌面壳的自定义 scheme（app:// 等）网页伪造不出来，放行
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  const originHost = parsed.host
  // **本机 UI**（Origin 是 loopback）是自家页面：它的正常链路就是「页面跑在 127.0.0.1:7999，
  // 把数据推到 https://<云端域名>」，Host 必然是别的域名 —— 对这类请求不做 Host 白名单，
  // 否则「上传到云端」会恒 403。安全边界没有变松：DNS rebinding 要求**页面 origin 就是那个域名**
  // （Origin==Host==evil.com），它永远不会是 loopback，下面那道闸门照样拦。
  const isLoopbackOrigin = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(originHost)
  if (!isLoopbackOrigin && !hostAllowed(headers)) return hostBlocked
  if (!host) return ''                          // 拿不到 Host 就无法比对，放行（宁可不误伤）
  if (originHost === host) return ''
  // **本机客户端 → 云端** 是产品的正常链路：页面跑在 http://127.0.0.1:<port>，
  // 却要把数据推到 https://mem.mengbot.vip。这时 Origin 与 Host 必然不同源，
  // 一律按"跨站"拒掉会让「上传」永远 403（用户实测：CROSS_ORIGIN_BLOCKED）。
  //
  // 放行 loopback 是安全的：这些请求仍要带 Authorization: Bearer <token>，
  // 而 token 存在用户浏览器的 localStorage 里 —— 别的站的页面跨源读不到，
  // 拿不到 token 就写不进去。恶意网页的 origin 不是 loopback，照旧被拒。
  if (isLoopbackOrigin) return ''
  return '跨站写入被拒（Origin ' + origin + ' 与请求的 Host ' + host + ' 不同源）'
}

/**
 * 找出「数字字段被清空」的键（值是空串 = 用户把数字格子清空了）。
 *
 * 为什么必须按 **schema 的 type** 判定，而不是「空字符串一律可疑 + 一份豁免名单」：
 * 宿主面板提交的是**整张表单**，把任何空串都当成「数字没填」会误伤本来合法的空串字段 ——
 * `secretHint` 的默认值就是 `''`，于是「全新安装 + 什么都不动 + 直接点保存」必然 400
 * 「字段不能为空：secretHint」，**整单被拒**，用户改的数字与开关一个都存不进去（issue #35）。
 * 旧实现正是靠一份硬编码豁免名单（vaultDir / captureProvider / captureModel / recallEmbedding /
 * activeVault），每加一个可空的字符串字段就得记得补一次 —— 现在直接读 schema。
 *
 * @param {object} patch 待写入的字段
 * @param {object} dict  schemastery 的字段表（Config.dict）
 * @returns {string[]} 被清空的数字字段名
 */
export function emptyNumericFields(patch, dict = {}) {
  const numeric = new Set(
    Object.entries(dict || {})
      .filter(([, schema]) => schema && schema.type === 'number')
      .map(([k]) => k),
  )
  return Object.entries(patch || {})
    .filter(([k, v]) => numeric.has(k) && typeof v === 'string' && v.trim() === '')
    .map(([k]) => k)
}

/**
 * **真的会写库**的路由（/card、/cards、/search 这些是读，绝不能拦）。
 * 用途：库不可写时短路径失败；撞锁（SQLITE_BUSY）时做应用层异步重试。
 */
const DB_WRITE_ROUTES = /^\/(delete|peer\/push|merge|write|import|card\/update|card\/revise|refine-apply|refine-goals-keep|refine-junk-purge|optimize-execute|feedback|skills\/sync|audit\/(approve|reject)|recycle\/(restore|purge|purge-expired|purge-all)|backup)$/

/**
 * 解析回收站保留期参数 `?days=`。
 *
 * issue #57 的根因就藏在一行 `Number(query.get('days')) || 30` 里：`Number('0')` 是 0，
 * 而 `0 || 30` 又变回 30 —— 前端「清空回收站」传的 0 被静默升级成 30 天保留期，
 * 刚删的卡一张都不清，用户看到的就是「点了没反应」。
 *
 * 这里把「没传」与「显式传 0」分开；非法输入交给调用方转 400。
 * @param {string|null|undefined} raw
 * @param {number} fallback 未提供时的默认保留天数
 * @returns {number}
 */
export function parseRetentionDays(raw, fallback = 30) {
  if (raw === null || raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error('days 必须是非负数字')
    err.code = 'BAD_DAYS'
    throw err
  }
  return n
}

/** 卡的 status → 对外四态。deleted/archived 一律 missing（可重新提交）。 */
function normalizeState(status) {
  const v = String(status || '').toLowerCase()
  if (v === 'approved') return 'approved'
  if (v === 'pending') return 'pending'
  if (v === 'rejected') return 'rejected'
  return 'missing'
}

/**
 * 读磁盘上 package.json 的版本（不缓存）。
 * 用来判断「插件升级了但宿主没重启」：与进程内固定的运行版本不一致时，
 * /overview 会同时给出 pkgVersion，客户端据此提示用户重启。
 * ⚠ 必须是**模块级 function**（会提升），且下面 overview 里会调用它。
 */
function readPkgVersion() {
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return String(JSON.parse(readFileSync(p, 'utf8')).version || '')
  } catch { return '' }
}

/** 读 schema_version（外部集成方据此判断迁移是否到位）。 */
function readSchemaVersion(db) {
  try {
    const r = db.prepare("SELECT value FROM config WHERE key = 'schema_version'").get()
    return r ? Number(r.value) || 0 : 0
  } catch {
    return 0
  }
}

/** issue #67：面板「查看库」作用域 cookie（值只允许是 vaultProfiles[].name）。 */
const VIEW_SCOPE_COOKIE = 'me_view_vault'

/**
 * 解析面板「查看库」作用域。
 * 只认配置里存在的 profile 名（不接受任意路径），避免这个本机无鉴权 API
 * 被当成「任意目录读取器」；找不到/目录不存在一律回退默认库。
 * @returns {{name:string, root:string}|null}
 */
export function viewScopeOf(req, { getSettings } = {}) {
  try {
    const cookie = String((req && req.headers && req.headers.cookie) || '')
    const m = new RegExp('(?:^|;\\s*)' + VIEW_SCOPE_COOKIE + '=([^;]*)').exec(cookie)
    if (!m) return null
    const name = decodeURIComponent(String(m[1] || '').trim())
    if (!name) return null
    const cfg = typeof getSettings === 'function' ? (getSettings() || {}) : {}
    const hit = (Array.isArray(cfg.vaultProfiles) ? cfg.vaultProfiles : [])
      .find((p) => p && String(p.name || '') === name && String(p.path || '').trim())
    if (!hit) return null
    const root = path.resolve(String(hit.path).trim())
    if (!fs.existsSync(root)) return null
    return { name, root }
  } catch { return null }
}

/** 哪些路由跟随「查看库」作用域：数据面（待审/卡片/日志/健康/图谱），不含 vault 管理 / 配置 / 系统路由。 */
export function isViewScopedRoute(route) {
  const r = String(route || '')
  if (['/overview', '/health', '/cards', '/card', '/write', '/import', '/export', '/logs', '/capture-log', '/search', '/tags', '/stats', '/feedback', '/reindex'].includes(r)) return true
  return r.startsWith('/audit/') || r.startsWith('/cards/') || r.startsWith('/card/') ||
    r.startsWith('/logs/') || r.startsWith('/graph') || r.startsWith('/search') ||
    r.startsWith('/junk') || r.startsWith('/optimize') || r.startsWith('/import') ||
    r.startsWith('/export') || r.startsWith('/write')
}

export function createApi(deps = {}) {
  // getCaps：云端由 cloud-server 注入（返回该租户的 caps），本地不传 = 不限
  const { getCaps } = deps
  const vaultDir = deps.vaultDir ?? (() => '')
  const vaultRoots = deps.vaultRoots ?? (() => [{ name: '', root: vaultDir() }])

  // ── 路径作用域（审计 S1）──────────────────────────────────────────────────
  //
  // 为什么必须要有：`/vaults/export`、`/vaults/import-into`、`/vaults/transfer`、
  // `/vaults/switch` 这四个路由的路径**全部来自请求体/查询串**，旧实现直接
  // `path.resolve(用户传的值)` 就开库。云端多租户下这意味着：任何一个合法租户
  //   GET /vaults/export?path=<别人的租户目录>/memory-eternal.db
  // 就能读走别人的全部记忆 —— 多租户物理隔离等于不存在（审计 S1）。
  //
  // 收口成一处：请求里的路径 resolve 之后必须落在某个**允许根**内（等于根，或在其下）。
  //   · cloud 模式（cloud-server 注入 `{ mode:'cloud', roots:[vaultRoot] }`）：
  //     只允许本租户自己的库根（含其下的 vaults/<slug>/），**别人的租户目录一律越界**；
  //   · local 模式（缺省）：当前库 + 当前库的**同级目录** ——
  //     历史库副本都在 `$DSH_HOME/memory-vault*` 同级，这样「把旧库上传到云端」的老能力不受影响。
  const pathScope = deps.pathScope && typeof deps.pathScope === 'object' ? deps.pathScope : null
  const scopeMode = String((pathScope && pathScope.mode) || 'local') === 'cloud' ? 'cloud' : 'local'
  const scopeRoots = () => {
    const injected = pathScope && Array.isArray(pathScope.roots) ? pathScope.roots : []
    const cur = String(vaultDir() || '').trim()
    const raw = scopeMode === 'cloud'
      ? [...(cur ? [cur] : []), ...injected]
      : [...(cur ? [cur, path.dirname(cur)] : []), ...injected]
    const out = []
    for (const r of raw) {
      const s = String(r || '').trim()
      if (!s) continue
      const abs = path.resolve(s)
      if (!out.includes(abs)) out.push(abs)
    }
    return out
  }
  /**
   * 请求里的库路径 → 绝对路径；越界抛 `PATH_NOT_ALLOWED`（调用方转 403 path-not-allowed）。
   * @param {string} raw 来自请求的路径
   * @returns {string} 绝对路径
   */
  const guardPath = (raw) => {
    const want = String(raw || '').trim()
    if (!want) {
      const err = new Error('path 为空')
      err.code = 'PATH_EMPTY'
      throw err
    }
    const abs = path.resolve(want)
    const roots = scopeRoots()
    const ok = roots.some((r) => abs === r || abs.startsWith(r + path.sep))
    if (!ok) {
      const err = new Error('path-not-allowed')
      err.code = 'PATH_NOT_ALLOWED'
      err.path = abs
      throw err
    }
    return abs
  }
  /** 统一的越界响应：403 `{ ok:false, error:'path-not-allowed' }`。 */
  const pathDenied = (res, err) => json(res, 403, {
    ok: false,
    code: 'PATH_NOT_ALLOWED',
    error: 'path-not-allowed',
    path: String((err && err.path) || ''),
    hint: scopeMode === 'cloud'
      ? '云端只能操作本租户自己的记忆库'
      : '只能操作当前库或它的同级记忆库（$DSH_HOME 下的 memory-vault*）',
  })

  /**
   * 读原始 body；超限**就地 413** 并返回 null（调用方 `if (raw === null) return`）。
   *
   * 为什么还要这一层：有些路由要自己回答「JSON 解析失败」的文案（`/import`、`/write`），
   * 所以它们要原始串而不是解析结果；而体积上限必须只有一份口径。这样「怎么解析」和
   * 「能读多大」解耦，谁都绕不过 2MB 默认上限（审计 H2）。
   */
  const readRaw = async (req, res, opts) => {
    try {
      return await readBodyText(req, opts)
    } catch (e) {
      if (e && e.code === 'PAYLOAD_TOO_LARGE') {
        json(res, 413, {
          ok: false, code: 'payload_too_large',
          error: String((e && e.message) || e),
          maxBytes: e.maxBytes || MAX_BODY_BYTES,
        })
        return null
      }
      throw e
    }
  }

  // 运行中热切库（不重启进程）：由**持有可变 vaultRoot 的进程**注入（独立 web）。
  // 宿主形态不注入 —— 它的 vaultDir() 每次请求都重算，写偏好即生效，不需要热切。
  const switchVaultHot = typeof deps.switchVault === 'function' ? deps.switchVault : null
  const getSettings = deps.getSettings ?? (() => ({}))
  // 语义召回的后台任务（建缓存 / 拉模型）状态；按 vault 根隔离，进程内有效。
  const embedJobs = new Map()
/** /embedding/status 的服务探测缓存（3 秒）——面板一次刷新会打两三次，别每次都去连。 */
const probeCache = new Map()
  // DSH 宿主信息（独立 web server 无 DSH 环境时为 null）。head DSH 状态行用。
  const getDshInfo = deps.getDshInfo ?? (() => null)
  // 自动沉淀运行轨迹（最新在前）+ 健康状态（异常时 UI 顶部亮红）。
  const getCaptureLog = deps.getCaptureLog ?? (() => null)
  const getCaptureHealth = deps.getCaptureHealth ?? (() => null)
  // 最近活跃会话（宿主注入）：会话工作区按会话隔离，独立 web 没有会话概念时退化为 anonymous
  const getActiveSession = deps.getActiveSession ?? (() => '')
  // 矛盾扫描（issue #36）要用模型：宿主把 ctx.get('llm') 传进来；独立 web 进程拿不到就如实报错
  const getLlm = deps.getLlm ?? (() => null)
  // 技能卡同步：宿主传入能访问 ctx.skills 的实现；独立 web 没有技能注册表，
  // 走 lib/skill-cards.js 的文件系统兜底（DSH_HOME/skills、profile 插件 skills 等）。
  const syncSkills = deps.syncSkills ?? (async (opts = {}) => {
    const { syncSkillCards } = await import('./skill-cards.js')
    return syncSkillCards(vaultDir(), {
      env: process.env,
      cwd: String(process.env.MEMORY_WORKSPACE || '').trim() || process.cwd(),
      packageRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
      ...opts,
    })
  })
  // ── 宿主代理（issue #47）：桌面版的「记忆」弹窗其实是 iframe 里的**独立页**，
  //    它没有 DSH 的 llm 服务 → /llm-routes 恒为「拿不到 llm」→ 用户只能手填 provider/model，
  //    「无法选择蒸馏模型」就是这么来的。宿主每 15s 会把 web 端口写进 <config>.host.json，
  //    独立页据此把只读查询/试调用的请求**转发给宿主**（仅限 127.0.0.1、只转发这两个路由）。
  const hostBase = async () => {
    try {
      const { readHostMarker } = await import('./host-heartbeat.js')
      const marker = readHostMarker(process.env)
      if (!marker || !marker.port) return ''
      if (Date.now() - marker.at > 120000) return ''   // 心跳过期（宿主可能已退出）
      return 'http://127.0.0.1:' + marker.port
    } catch { return '' }
  }
  const proxyHost = deps.proxyHost
    ? ((route, init) => deps.proxyHost(route, init))
    : (async (route, init = {}) => {
    const base = await hostBase()
    if (!base) return { ok: false, error: '宿主不在线（或心跳过期）：请从 DSH 面板打开设置，或直接手填 provider/model' }
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 8000)
      const r = await fetch(base + route, { ...init, signal: ctl.signal })
      clearTimeout(timer)
      const data = await r.json().catch(() => null)
      if (!data) return { ok: false, error: '宿主返回了非 JSON 响应（HTTP ' + r.status + '）' }
      return { ...data, proxied: true }
    } catch (e) {
      return { ok: false, error: '代理到宿主失败：' + String((e && e.message) || e) }
    }
  })
  // 锁读取可注入：单测不能依赖开发者本机真实的看门狗锁（#30 复测期间就因此翻过车）
  const readLock = deps.readWatchdogLock ?? ((env) => readWatchdogLock(env))
  // 「重启常驻实例」的实现（宿主与独立 web 共用 lib/watchdog.js 的那一份；注入仅为单测）
  const doRestartResident = deps.restartResident ?? restartResident
  const probeResidentVersion = deps.probeServedVersion ?? probeServedVersion
  const pkgVersion = deps.currentPkgVersion ?? currentPkgVersion
  // 本进程自己监听的端口（独立 web 传入；宿主为 0 = 不知道）。用来把「要重启/要看的是哪个
  // 常驻实例」钉死在**本页所连的那个实例**上，而不是配置里的理想端口（web 退让到 port+1 时
  // 两者不同，探错端口会给出错误结论）。
  const selfPort = () => (typeof deps.selfPort === 'function' ? Number(deps.selfPort()) || 0 : Number(deps.selfPort) || 0)

  // ── 容灾（自动备份 / 保留期 / 自动还原）的配置读取与写入 ─────────────────
  //
  // 为什么单独归一：配置里这几个键都有默认值，而「读配置的人」有三个（状态接口、
  // 备份路由、宿主侧定时器），各自 `Number(...) || 24` 一遍就会出现 0 被当默认值、
  // 0 小时被当合法的口径分裂。这里只做一次归一，谁读都用同一份。
  const disasterConfig = () => {
    const cfg = getSettings() || {}
    const hours = Number(cfg.backupIntervalHours)
    const ret = normalizeRetention({ keepDays: cfg.backupKeepDays ?? 30 })
    return {
      enabled: cfg.backupEnabled !== false,
      intervalHours: Number.isFinite(hours) && hours >= 1 ? Math.min(Math.floor(hours), 24 * 365) : 24,
      // 备份时间窗：默认每天 03:00–03:59 备一次（窗口外不动手）
      windowStart: Number.isFinite(Number(cfg.backupWindowStart)) ? Math.max(0, Math.min(23, Math.floor(Number(cfg.backupWindowStart)))) : 3,
      keepDays: ret.keepDays || 30,
      autoRestore: cfg.backupAutoRestore !== false,
    }
  }

  /**
   * 把一份配置 patch 真正落下去。
   *
   * 宿主持有 settings 服务（deps.writeConfig，由 index.js 注入）→ 直接写；
   * 独立 web / CLI / MCP 没有 settings → 走 lib/config-sync.js 的既有协议
   * （待应用文件 + 叫醒宿主；本机没有宿主时直接写共享配置）。**这与 /config 的保存路径一致**，
   * 所以面板上「容灾开关」和「其它设置」不会出现一个能存一个不能存的割裂。
   */
  const persistConfigPatch = async (patch) => {
    if (typeof deps.writeConfig === 'function') {
      const out = (await deps.writeConfig(patch)) || {}
      return { mode: 'host', ...out }
    }
    const { writePendingConfig, clearPendingConfig, applySharedConfigDirect, triggerHostDrain } = await import('./config-sync.js')
    const { hostAlive, readHostMarker } = await import('./host-heartbeat.js')
    const alive = hostAlive(process.env)
    const marker = alive ? readHostMarker(process.env) : null
    writePendingConfig(process.env, patch)
    if (marker && marker.port && marker.token) {
      const call = await triggerHostDrain({ port: marker.port, token: marker.token, timeoutMs: 2500 }).catch(() => ({ ok: false }))
      if (call && call.ok) return { mode: 'host-drain' }
    }
    if (!alive) {
      // 本机没有活着的宿主：直接写共享配置（hooks / MCP / 独立页都读它），并收掉待应用文件
      // —— 与 /config 的同名路径保持一致，免得下次 DSH 启动时把同一份 patch 再应用一遍。
      applySharedConfigDirect(process.env, patch)
      clearPendingConfig(process.env)
      return { mode: 'direct' }
    }
    return { mode: 'queued' }
  }

  /**
   * 把「用户选的库」也写进**配置**（vaultDir / activeVault），而不仅仅是共享偏好文件。
   *
   * 为什么必须有这一步：偏好文件（memory-eternal-active-vault.json）在优先级里排在
   * 「配置里的 vaultDir」「activeVault 命中的 profile」之后 —— 也可能被启动参数 --vault 直接压过
   * （看门狗/宿主就是这么拉起常驻实例的）。只写偏好时，用户切了库、当下生效，**一重启又回到旧库**，
   * 表现成「切库没生效/自己跳回去了」。
   * 所以：切库成功后把选择同步进配置，下次谁拉起进程都是这个库。
   *
   * 落在哪个键上按现有语义决定：
   *   · 路径命中某个 vaultProfiles[].path → 写 activeVault（保留用户原有的 profile 体系，不并排塞一份 vaultDir）
   *   · 否则 → 写 vaultDir，并清掉 activeVault（否则 profile 依然赢，切换等于没做）
   */
  const persistVaultChoice = async (target) => {
    const want = String(target || '').trim() ? path.resolve(String(target)) : ''
    if (!want) return { ok: false, error: '路径为空' }
    // MEMORY_VAULT_DIR 优先级最高：那种部署下写配置改不了「谁被它拉起来的」。但注意
    // **托管部署里这个变量一定存在**（宿主/看门狗拉起 web 时会注入当前库），所以不能只看「有没有」——
    // 只有「它指的不是这个库」才算真的被环境钉住，否则每次切库都会报一句无用的警告。
    const envDir = String(process.env.MEMORY_VAULT_DIR || '').trim()
    const envOverride = !!envDir && path.resolve(envDir) !== want
    try {
      const cfg = getSettings() || {}
      const profiles = Array.isArray(cfg.vaultProfiles) ? cfg.vaultProfiles : []
      const hit = profiles.find((p) => p && p.path && String(p.path).trim() && path.resolve(String(p.path).trim()) === want)
      const patch = hit ? { activeVault: String(hit.name || '') } : { activeVault: '', vaultDir: want }
      // 已经是这个值就别写：每次切库都往配置里塞一遍会白触发一次宿主 drain / 文件同步
      const same = hit
        ? String(cfg.activeVault || '') === String(hit.name || '')
        : (String(cfg.vaultDir || '') === want && !String(cfg.activeVault || ''))
      if (same) return { ok: true, skipped: true, patch, envOverride, envDir: envOverride ? envDir : '' }
      const out = await persistConfigPatch(patch)
      return { ok: true, patch, envOverride, envDir: envOverride ? envDir : '', ...out }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), envOverride }
    }
  }

  /**
   * 沉淀自检：把「为什么没有新卡片」从黑箱变成一行可读结论。
   *
   * 三个卡点在界面上**表现完全一样**（安静地没有新卡），历史上各踩过一次：
   *   ① 发号器（card_sequence）丢了 → 所有写入抛「未初始化」（2026-11-15 真实事故）
   *   ② 蒸馏模型鉴权失败（AUTH/401）→ capture 拿不到正文，只能降级或失败
   *   ③ 噪声门 / 冷却 → 本来就不该写卡，是正常行为（不是故障）
   * 这里只读，不修任何东西（自愈在 nextCardId 里做，不在 GET 里偷偷写）。
   * 5 秒缓存：/overview 被面板高频轮询，别每次都去读一遍日志文件。
   */
  let selfCheckCache = { at: 0, root: '', val: null }
  const captureSelfCheck = async () => {
    const now = Date.now()
    // 注意：vaultRoot 是 dispatch 里的局部变量；这里要自己取一次当前库（切库后自检也要跟着走）
    const root = vaultDir()
    if (selfCheckCache.val && selfCheckCache.root === root && now - selfCheckCache.at < 5000) return selfCheckCache.val
    const out = { cardSeq: null, seqOk: false, lastFail: null, lastCreatedAt: 0, logCount: 0, autoCapture: true }
    try {
      const cfg = getSettings() || {}
      out.autoCapture = cfg.autoCapture !== false
    } catch { /* 配置读不到按默认 */ }
    try {
      const db = getDb(root)
      const row = db.prepare("SELECT seq FROM card_sequence WHERE name = 'card'").get()
      out.seqOk = !!row
      out.cardSeq = row ? (Number(row.seq) || 0) : null
    } catch { /* 库还没建出来 */ }
    try {
      // 独立 web 注入的 getCaptureLog 是 async（读文件），宿主注入的是同步数组 —— 两种都要吃
      let raw = typeof getCaptureLog === 'function' ? getCaptureLog() : null
      if (raw && typeof raw.then === 'function') raw = await raw.catch(() => null)
      const list = (Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : []))
        .filter(Boolean)
        .slice()
        .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0))   // 统一成「最新在前」，不依赖各实现的顺序
      out.logCount = list.length
      for (const e of list) {
        if (String(e.action || '') === 'created') { out.lastCreatedAt = Number(e.time) || 0; break }
      }
      for (const e of list) {
        if (String(e.action || '') !== 'fail') continue
        out.lastFail = { at: Number(e.time) || 0, reason: String(e.reason || '').slice(0, 300) }
        break
      }
    } catch { /* 日志读不到不影响结论 */ }
    selfCheckCache = { at: now, root, val: out }
    return out
  }

  const dispatch = async function handleApi(req, res) {
    // 状态变更请求先过同源闸门（见 crossOriginError）：无鉴权的本机 API 不能让任意网页写配置
    const crossOrigin = crossOriginError(req)
    if (crossOrigin) return json(res, 403, { ok: false, error: crossOrigin, code: 'CROSS_ORIGIN_BLOCKED' })
    // 旧前缀归一化：业务 API 也可能被直接挂载（不经 web.js），
    // 只认 /api 会让 /memory-eternal/api/xxx 算出错误的 route → 404（实测 cloud-multi-vault 六项失败）
    {
      const raw = String(req.url || '')
      const cut = raw.indexOf('?')
      const pathOnly = cut >= 0 ? raw.slice(0, cut) : raw
      const search = cut >= 0 ? raw.slice(cut) : ''
      if (pathOnly === '/memory-eternal/api' || pathOnly.startsWith('/memory-eternal/api/')) {
        req.url = API_PREFIX + pathOnly.slice('/memory-eternal/api'.length) + search
      }
    }
    const url = new URL(req.url, 'http://localhost')
    const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/overview'
    const query = url.searchParams
    const baseVaultRoot = vaultDir()
    // issue #67：面板可以选择「查看哪个库」。作用域只跟随数据面路由（待审/卡片/日志/健康/图谱），
    // 不写 activeVault、不改默认库，也不影响 Agent 的写入路由；cookie 里只放 profile 名。
    const viewScope = isViewScopedRoute(route) ? viewScopeOf(req, { getSettings: deps.getSettings }) : null
    const vaultRoot = viewScope ? viewScope.root : baseVaultRoot
    // MEM Pair：/peer/* 由独立模块处理（不写在这个巨型 switch 里，便于单独审计）
    // Agent MCP 挂载管理：默认不挂载，用户在面板/CLI 里显式选择目标才挂
    if (route.startsWith('/mcp/')) {
      const handled = await handleMcpMount({ req, res, route, json, readRaw, broadcast, logActivity, clientIpOf, vaultRoot })
      if (handled) return
    }
    // MCP Streamable HTTP（route 精确为 /mcp，不误伤 /mcp/status 那套挂载管理）
    if (route === '/mcp') {
      // 把「本实例自己的地址」传进去：工具层用它读写同一个库，而不是硬编码 7999。
      // （独立 web 跑在 7907 / 测试随机端口时，硬编码会把读写打到宿主的 7999 上。）
      const port = (req.socket && req.socket.localPort) || 0
      const baseUrl = port ? 'http://127.0.0.1:' + port : ''
      const handled = await handleMcpHttp({ req, res, vaultRoot, readRaw, baseUrl })
      if (handled) return
    }
    if (route.startsWith('/peer/')) {
      const handled = await handlePeerRoute({
        req, res, route, query, vaultRoot,
        json, broadcast, writeCard, ensureVault, getSettings, readRaw,
        logActivity, clientIpOf,
      })
      if (handled) return
    }
    // 体积闸门（审计 H2）：Content-Length 声明就超限 → 立刻 413，不必先把 body 读进内存
    const bodyLimit = bodyLimitFor(route)
    const declaredBytes = Number(((req && req.headers) || {})['content-length'])
    if (Number.isFinite(declaredBytes) && declaredBytes > bodyLimit) {
      return json(res, 413, {
        ok: false,
        code: 'payload_too_large',
        error: '请求体过大：上限 ' + Math.max(1, Math.round(bodyLimit / 1024 / 1024)) + 'MB',
        maxBytes: bodyLimit,
        declared: declaredBytes,
      })
    }
    // 库不可写时**短路径失败**（issue #33）：这些路由一定会写库，早失败早说清，避免做一半、
    // 也避免每个接口各自把 `attempt to write a readonly database` 原文丢给用户。
    // **只读路由与配置路由不受影响**（配置不经过数据库 —— 用户至少还能改设置）。
    if (DB_WRITE_ROUTES.test(route)) {
      const st = dbStatus(vaultRoot)
      if (st && st.writable === false) {
        return json(res, 503, {
          ok: false,
          code: 'DB_UNAVAILABLE',
          error: '记忆库当前不可写' + (st.error ? '：' + st.error : '') + '（配置仍可保存）',
          db: st,
          guidance: rebuildGuidance(vaultRoot, st),
        })
      }
    }

    switch (route) {
      /**
       * POST /api/factory-reset —— 把**当前库**恢复到刚安装的状态。
       *
       * 范围严格限定在当前 vaultRoot：其它库（备份副本、云端租户库）一个字节都不动。
       *
       * 安全设计（这是删数据的接口，任何一步缺失都可能造成不可逆损失）：
       *   ① **先备份**：清空之前把 .db 整份 copy 成 .db.bak-<时间戳>，并把路径返回给前端；
       *   ② **双重确认**：必须传 confirm 且与 expected 完全一致（前端让用户手打那串字）；
       *   ③ **只清表内容，不删库文件**：schema 保留，等于"空库"而不是"无库"；
       *   ④ 清完重建 schema_version，否则迁移不再跑。
       *
       * 入参: { confirm: '恢复出厂设置', expected: '恢复出厂设置', step?: string }
       *   step 用于前端进度条分段执行（清表 → 重建基础配置），省略则一次做完。
       */
      case '/factory-reset': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const expected = String(body.expected || '恢复出厂设置')
        // ① dryRun：只预览，**不要求**确认文字（用户还没看到清单，没法确认）
        if (body.dryRun === true) {
          const db = getDb(vaultRoot)
          let tables = []
          let cards = 0, quarantined = 0
          try { cards = Number(db.prepare('SELECT COUNT(*) n FROM cards').get().n) || 0 } catch { /* 空库 */ }
          try { quarantined = Number(db.prepare('SELECT COUNT(*) n FROM quarantine').get().n) || 0 } catch { /* 同上 */ }
          try {
            tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name)
          } catch { /* 忽略 */ }
          const dbFile = path.join(vaultRoot, dbFileIn(vaultRoot))
          let sizeMB = 0
          try { sizeMB = Math.round((fs.statSync(dbFile).size / 1024 / 1024) * 10) / 10 } catch { /* 忽略 */ }
          return json(res, 200, {
            ok: true, dryRun: true,
            vault: vaultRoot,
            db: dbFile,
            cards, quarantined,
            tables,
            sizeMB,
            backupWillBe: dbFile + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14),
          })
        }

        // 确认文字：必须在**真正执行**前把关（dryRun 已放行）
        if (String(body.confirm || '') !== expected) {
          return json(res, 400, { ok: false, code: 'confirm_mismatch', error: '确认文字不匹配，未做任何改动', expected })
        }

        // ② 先备份（失败就不清，宁可不清也不能没有退路）
        const dbFile = path.join(vaultRoot, dbFileIn(vaultRoot))
        let backupPath = ''
        try {
          backupPath = dbFile + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
          fs.copyFileSync(dbFile, backupPath)
          if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) {
            return json(res, 500, { ok: false, code: 'backup_failed', error: '备份文件为空，已中止（未清空任何数据）' })
          }
        } catch (e) {
          return json(res, 500, { ok: false, code: 'backup_failed', error: '备份失败，已中止（未清空任何数据）：' + String((e && e.message) || e) })
        }

        // ③ 逐表清空（单事务；只清**当前库**）
        const db = getDb(vaultRoot)
        const cleared = []
        const failed = []
        let tables = []
        try {
          tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name)
        } catch (e) {
          return json(res, 500, { ok: false, error: '读表清单失败：' + String((e && e.message) || e) })
        }
        let inTx = false
        try { db.exec('BEGIN'); inTx = true } catch { inTx = false }
        try {
          for (const t of tables) {
            // FTS5 的**影子表**（*_fts_data / _idx / _docsize / _config）由虚拟表自己维护，
            // 直接 DELETE 会报 "may not be modified"。清虚拟表即可，影子表跟着空。
            if (/_fts_(data|idx|docsize|config|content)$/.test(t)) continue
            // 发号器**不是内容**，不能清：清空后忘了重建，之后所有写卡都会抛
            // 「card_sequence 未初始化」（2026-11-15 的真实事故）。留着它，id 继续单调递增即可。
            if (t === 'card_sequence') continue
            // 只清内容；sqlite_sequence 之类的系统表前面已经过滤
            try {
              db.exec(`DELETE FROM "${t.replace(/"/g, '""')}"`)
              cleared.push(t)
            } catch (e) {
              failed.push({ table: t, error: String((e && e.message) || e).slice(0, 120) })
            }
          }
          if (inTx) db.exec('COMMIT')
        } catch (e) {
          if (inTx) { try { db.exec('ROLLBACK') } catch { /* 已回滚 */ } }
          return json(res, 500, { ok: false, error: '清空失败已回滚（备份在 ' + backupPath + '）：' + String((e && e.message) || e), backupPath })
        }

        // ④ 重建最小基础配置（schema_version 必须回来，否则迁移逻辑不再触发）
        try {
          db.prepare("INSERT INTO config(key, value) VALUES('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value = '2'").run()
        } catch { /* 忽略 */ }
        // ⑤ 发号器兜底：即便库里本来就没有这一行（老库/历史事故），清完也必须有。
        // 否则「恢复到刚安装状态」= 从此再也写不进卡（界面只会安静地没有新卡）。
        const seqAfter = ensureCardSequence(db)

        return json(res, 200, {
          ok: true,
          vault: vaultRoot,
          backupPath,
          cleared,
          failed,
          // 发号器当前值：清完之后它必须是「有值」的状态（0 也算有值），否则写卡会永久失败
          cardSeq: seqAfter,
          message: '已恢复到刚安装状态（只影响当前库）；原库备份在 ' + backupPath,
        })
      }

      /**
       * POST /api/cloud/flush-queue —— 手动补推失败队列。
       *
       * 队列由 capture 推送失败时自动写入（$DSH_HOME/memory-eternal-cloud-queue.jsonl）。
       * 用户切回云端、或网络恢复后点一下就能把积压的卡补上去。
       */
      case '/cloud/flush-queue': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const mod = await import('./cloud-push.js')
        const r = await mod.flushQueue()
        return json(res, r.ok ? 200 : 400, r)
      }

      /**
       * GET /api/logs —— 操作日志查询。
       *
       * query: date=YYYY-MM-DD（默认今天）| from/to（区间，导出用）
       *        q=关键词（只搜标题/智能体/IP）| agent= | action= | limit | offset=0
       *
       * 日志只存标题不含正文，所以这里的搜索是轻量的 LIKE —— 一天几千条也没有压力。
       */
      case '/logs': {
        const db = getDb(vaultRoot)
        const today = (() => {
          const d = new Date()
          return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
        })()
        const date = String(query.get('date') || today).slice(0, 10)
        const from = String(query.get('from') || '').slice(0, 10)
        const to = String(query.get('to') || '').slice(0, 10)
        const q = String(query.get('q') || '').trim()
        const agent = String(query.get('agent') || '').trim()
        const action = String(query.get('action') || '').trim()
        const limit = Math.min(Math.max(Number(query.get('limit')) || 200, 1), 1000)
        const offset = Math.max(Number(query.get('offset')) || 0, 0)

        const where = []
        const args = []
        if (from && to) {
          where.push('day >= ? AND day <= ?'); args.push(from, to)
        } else {
          where.push('day = ?'); args.push(date)
        }
        if (q) {
          where.push('(title LIKE ? OR agent LIKE ? OR ip LIKE ?)')
          const like = '%' + q + '%'
          args.push(like, like, like)
        }
        if (agent) { where.push('agent = ?'); args.push(agent) }
        if (action) { where.push('action = ?'); args.push(action) }
        const sqlWhere = where.length ? 'WHERE ' + where.join(' AND ') : ''
        try {
          const total = Number(db.prepare('SELECT COUNT(*) n FROM activity_log ' + sqlWhere).get(...args).n) || 0
          const rows = db.prepare('SELECT id, at, day, ip, agent, action, title, target FROM activity_log ' + sqlWhere + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...args, limit, offset)
          // 当天各 action 的计数（给前端做分类芯片）
          const byAction = db.prepare('SELECT action, COUNT(*) n FROM activity_log WHERE day = ? GROUP BY action').all(date)
          return json(res, 200, { ok: true, date, from, to, q, agent, action, total, rows, byAction })
        } catch (e) {
          return json(res, 500, { ok: false, error: '查询日志失败：' + String((e && e.message) || e) })
        }
      }

      /**
       * GET /api/logs/stats?days=7 —— 最近 N 天的趋势（给日志页画图用）。
       *
       * 返回：
       *   days:   [{ day, total, byAction: {capture:N, recall:N, ...} }]  按日期升序，缺的天补 0
       *   agents: [{ agent, n }]  这段时间内各智能体的总次数（降序）
       *   actions:[{ action, n }]  各动作总次数（降序）
       *
       * 缺的天要**补 0**：前端画折线图时不能有空洞（否则曲线会在没有日志的那天断掉）。
       */
      case '/logs/stats': {
        const db = getDb(vaultRoot)
        const days = Math.min(Math.max(Number(query.get('days')) || 7, 1), 90)
        try {
          const today = new Date()
          const start = new Date(today.getTime() - (days - 1) * 86400000)
          const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
          const from = fmt(start)
          const to = fmt(today)

          const byDay = db.prepare('SELECT day, action, COUNT(*) n FROM activity_log WHERE day >= ? AND day <= ? GROUP BY day, action').all(from, to)
          // 先铺满每一天（补 0），再把统计塞进去
          const dayMap = new Map()
          for (let i = 0; i < days; i++) {
            const d = new Date(start.getTime() + i * 86400000)
            dayMap.set(fmt(d), { day: fmt(d), total: 0, byAction: {} })
          }
          for (const row of byDay) {
            const slot = dayMap.get(row.day)
            if (!slot) continue
            slot.byAction[row.action] = Number(row.n) || 0
            slot.total += Number(row.n) || 0
          }

          const agents = db.prepare('SELECT agent, COUNT(*) n FROM activity_log WHERE day >= ? AND day <= ? GROUP BY agent ORDER BY n DESC LIMIT 20').all(from, to)
          const actions = db.prepare('SELECT action, COUNT(*) n FROM activity_log WHERE day >= ? AND day <= ? GROUP BY action ORDER BY n DESC LIMIT 20').all(from, to)

          const dayArr = [...dayMap.values()]
          return json(res, 200, {
            ok: true,
            days: dayArr,
            // 柱状图的高度基准：前端在 JSX 里算要套 IIFE，容易写错括号
            maxTotal: Math.max(1, ...dayArr.map((d) => d.total)),
            agents: agents.map((r) => ({ agent: r.agent || '(未知)', n: Number(r.n) || 0 })),
            actions: actions.map((r) => ({ action: r.action || '(未知)', n: Number(r.n) || 0 })),
            from, to,
          })
        } catch (e) {
          return json(res, 500, { ok: false, error: '统计失败：' + String((e && e.message) || e) })
        }
      }

      /**
       * GET /api/logs/export?from=&to= —— 导出日志为 CSV。
       *
       * CSV 而不是 JSON：用户拿去 Excel 看/筛选，比 JSON 实用得多。
       * 字段里的引号与逗号按 RFC 4180 转义。
       */
      case '/logs/export': {
        const db = getDb(vaultRoot)
        const today = (() => {
          const d = new Date()
          return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
        })()
        const from = String(query.get('from') || today).slice(0, 10)
        const to = String(query.get('to') || from).slice(0, 10)
        try {
          const rows = db.prepare('SELECT at, day, ip, agent, action, title, target FROM activity_log WHERE day >= ? AND day <= ? ORDER BY id').all(from, to)
          const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'
          const head = ['时间', '日期', 'IP', '智能体', '动作', '标题', '目标'].map(esc).join(',')
          const body = rows.map((r) => [r.at, r.day, r.ip, r.agent, r.action, r.title, r.target].map(esc).join(',')).join('\n')
          // BOM：Excel 打开中文不乱码
          const csv = '\ufeff' + head + '\n' + body + '\n'
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="memory-eternal-logs-' + from + '_' + to + '.csv"',
          })
          res.end(csv)
          return
        } catch (e) {
          return json(res, 500, { ok: false, error: '导出失败：' + String((e && e.message) || e) })
        }
      }

      /**
       * POST /api/logs/cleanup —— 删除保留期之外的日志（默认 30 天）。
       *
       * 默认 30 天不是硬编码：请求里可以带 days，但前端只给 30 这一个选项
       * （用户需求就是"默认 30 天"，不给太多选择反而省心）。
       */
      case '/logs/cleanup': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const db = getDb(vaultRoot)
        try {
          const { logRetentionDays, pruneActivityLog } = await import('./db.js')
          // 没显式传 days 就用配置的天数（用户配的"保留多少天"）
          const days = Number(body && body.days) > 0 ? Math.min(Math.max(Number(body.days), 1), 3650) : logRetentionDays(db)
          const removed = pruneActivityLog(db, days)
          return json(res, 200, { ok: true, days, removed })
        } catch (e) {
          return json(res, 500, { ok: false, error: '清理失败：' + String((e && e.message) || e) })
        }
      }

      /**
       * GET/POST /api/logs/settings —— 日志保留天数（默认 30）。
       *
       * 存 config 表而不是配置文件：跟着库走，换库就是另一套保留策略，符合直觉。
       */
      case '/logs/settings': {
        const db = getDb(vaultRoot)
        const mod = await import('./db.js')
        if (req.method === 'GET') {
          return json(res, 200, { ok: true, retentionDays: mod.logRetentionDays(db) })
        }
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 GET 或 POST' })
        const body = await readBody(req)
        const days = Math.min(Math.max(Number(body && body.retentionDays) || 30, 1), 3650)
        try {
          db.prepare("INSERT INTO config(key, value, updated_at) VALUES('logRetentionDays', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(String(days))
          // 保存后立刻按新值清一次，让用户马上看到效果
          const removed = mod.pruneActivityLog(db, days)
          return json(res, 200, { ok: true, retentionDays: days, removed })
        } catch (e) {
          return json(res, 500, { ok: false, error: '保存失败：' + String((e && e.message) || e) })
        }
      }

      /**
       * GET/POST /api/cloud/conn —— 云端连接的**服务端副本**。
       *
       * 为什么要有它：前端把连接信息存在 localStorage，Node 侧读不到，
       * 于是「切了云端」只影响浏览器的 fetch，插件自动沉淀照样写本地。
       * 这里把配置落到 $DSH_HOME/memory-eternal-cloud-conn.json，
       * 插件的 capture 就能按它把卡片推到云端。
       */
      case '/cloud/conn': {
        const mod = await import('./cloud-push.js')
        if (req.method === 'GET') {
          const c = mod.readCloudConn()
          // domains：当前生效的域名基座与各角色主机名 —— 前端 placeholder / 提示文案都用它，
          // 切基座（备案域 ↔ 临时域）时界面与支付深链一起换，不再各处写死。
          // **返回完整令牌**（不再脱敏成 ***）。
          // 理由：这是 127.0.0.1 的本机接口，服务端与浏览器在同一台机器上；
          // 脱敏反而让客户端无法在「localStorage 被清 / 换浏览器 / 换端口」时
          // 从服务端恢复连接状态 —— 用户会遇到「明明是个人版却切换不了」。
          return json(res, 200, {
            ok: true,
            conn: c,
            hasToken: !!c.token,
            canPush: mod.shouldPushToCloud(),
            domains: resolveDomains({ cloudUrl: c.url || '' }),
          })
        }
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 GET 或 POST' })
        const body = await readBody(req)
        const w = mod.writeCloudConn(body && body.conn ? body.conn : body)
        if (!w.ok) return json(res, 400, w)
        // POST 也返回**完整令牌**：前端会拿这个响应更新 localStorage，
        // 如果给 ***，下次同步就会把 *** 当成真实令牌写回服务端 ——
        // 一次脱敏，全局脏掉（实测踩到：文件里 token 变成 "***"，云端全 401）。
        return json(res, 200, {
          ok: true,
          path: w.path,
          conn: w.conn,
          canPush: mod.shouldPushToCloud(),
          domains: resolveDomains({ cloudUrl: w.conn.url || '' }),
        })
      }

      /**
       * GET /api/vaults —— 枚举本机所有记忆库。
       *
       * 为什么要枚举：一个人可能有多个库（本地库、备份副本、云端各租户的库）。
       * 上传/下载数据前必须让用户看清「有几个库、哪个是当前用的、各自多少卡」，
       * 否则选错库就把数据搬错地方了。
       *
       * 扫描位置：
       *   · $DSH_HOME/memory-vault*（本地库及其副本，owner 为空 = 没有账号）
       *   · $DSH_HOME/cloud-vaults/<owner>/（云端各租户）
       *   · 当前进程正在服务的 vaultRoot（标 isCurrent）
       */
      case '/vaults': {
        const list = []
        const seen = new Set()
        const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

        const addVault = (root, kind, requireDb = true) => {
          const abs = path.resolve(root)
          if (seen.has(abs)) return
          const dbFile = path.join(abs, dbFileIn(abs))
          // 云端命名库刚建好时只有目录、没有 .db（schema 由首次访问时 ensureVault 建）——
          // 那种情况下也要列出来，否则用户建了库却看不见。
          if (requireDb && !fs.existsSync(dbFile)) return
          if (!requireDb && !fs.existsSync(abs)) return
          seen.add(abs)
          let cards = 0, pending = 0, quarantined = 0
          let owner = ''
          try { owner = fs.readFileSync(path.join(abs, '.owner'), 'utf8').trim() } catch { /* 本地库没有 */ }
          try {
            const db = getDb(abs)
            cards = Number(db.prepare('SELECT COUNT(*) n FROM cards').get().n) || 0
            pending = Number(db.prepare("SELECT COUNT(*) n FROM cards WHERE status='pending'").get().n) || 0
            quarantined = Number(db.prepare('SELECT COUNT(*) n FROM quarantine').get().n) || 0
          } catch { /* 库损坏也照样列出，让用户看得见 */ }
          let sizeMB = 0
          try { sizeMB = Math.round((fs.statSync(dbFile).size / 1024 / 1024) * 10) / 10 } catch { /* 忽略 */ }
          list.push({
            id: Buffer.from(abs).toString('base64url').slice(0, 16),
            path: abs,
            name: path.basename(abs),
            owner: owner || null,
            kind,
            cards, pending, quarantined, sizeMB,
            isCurrent: path.resolve(abs) === path.resolve(vaultRoot),
          })
        }

        // ── 枚举：云端实例与本地实例是**两种完全不同的东西**，不能混着列 ──
        //
        // 踩过的坑（用户截图指出「整个逻辑都混乱了」）：
        //   云端租户实例的 DSH_HOME 是 /var/lib/memory-eternal-cloud，
        //   而那里**恰好有一个 memory-vault 目录**（服务进程的默认库）。
        //   原来的代码不分实例类型，把「本地 memory-vault*」和「cloud-vaults/*」都扫了一遍，
        //   于是租户在自己的面板里看到 memory-vault —— 那是**服务端的默认库**，
        //   不但误导，还可能被切过去读到别的数据。
        const homeCv = path.join(home, 'cloud-vaults')
        const inCloudRoot = path.resolve(vaultRoot).startsWith(path.resolve(homeCv) + path.sep)

        if (inCloudRoot) {
          // 云端租户实例：**只列自己的库**（默认库 + vaults/<slug>/），别的一概不碰
          //
          // ⚠️ 云端支持热切库之后，`vaultRoot` 可能指向**该租户下的某个子库**
          //   （`<租户根>/vaults/<slug>/`）。「本租户有哪些库」必须从**租户根**枚举，
          //   否则一切到子库，列表里就只剩它自己 —— 用户再也点不回默认库/兄弟库。
          //   注入的 pathScope.roots[0] 正是租户根（cloud 模式下它恒为租户根，见 cloud-server.js）。
          const ownerRoot = (scopeMode === 'cloud' && pathScope && Array.isArray(pathScope.roots)
            && String(pathScope.roots[0] || '').trim())
            ? path.resolve(String(pathScope.roots[0]))
            : path.resolve(vaultRoot)
          try {
            const { listOwnerVaults } = await import('./cloud-vaults.js')
            for (const v of listOwnerVaults(ownerRoot)) {
              addVault(v.root, 'cloud', v.kind === 'named' ? false : true)
              if (v.kind === 'named') {
                const last = list[list.length - 1]
                if (last && path.resolve(last.path) === path.resolve(v.root)) {
                  last.name = v.name
                  last.slug = v.slug
                  last.vaultKind = 'named'
                }
              }
            }
          } catch { /* 忽略 */ }
          // 兜底：当前库（热切到子库时它已在上面列过；租户根不在列表里时也要看得见它）
          addVault(vaultRoot, 'cloud')
        } else {
          // 本地单机实例：当前库 + 本机 memory-vault*（含副本）+ 云端各租户库（供本地用户看/搬）
          addVault(vaultRoot, 'local')
          try {
            for (const d of fs.readdirSync(home, { withFileTypes: true })) {
              if (!d.isDirectory()) continue
              if (!/^memory-vault/.test(d.name)) continue
              addVault(path.join(home, d.name), 'local')
            }
          } catch { /* home 读不到就算了 */ }
          // 注意：本地实例**不列** cloud-vaults/*。
          // 那些是「本机的云端副本目录」，和真正的云端实例上的库是两回事；
          // 前端现在有独立的「云端实例上的库」列表，混进"本机记忆库"只会让用户看着重复。
          void homeCv
        }

        // 库数量配额（MengBot 的 caps.vaults）。
        // 本地：没有租户概念，通常不限；云端：由 cloud-server 按租户注入。
        let capVaults = 0
        try {
          const caps = typeof getCaps === 'function' ? (getCaps() || {}) : {}
          const fromCaps = Math.floor(Number(caps && caps.vaults))
          if (Number.isFinite(fromCaps) && fromCaps > 0) capVaults = fromCaps
          else {
            const envV = Math.floor(Number(process.env.MEMORY_CAPS_VAULTS))
            if (Number.isFinite(envV) && envV > 0) capVaults = envV
          }
        } catch { /* 拿不到就不限 */ }

        return json(res, 200, {
          ok: true,
          vaults: list,
          count: list.length,
          current: path.resolve(vaultRoot),
          // 本进程能不能**不重启**就换库：前端据此决定「切换」按钮是即时生效还是要重启。
          hotSwitch: !!switchVaultHot,
          // quota 是 MengBot 联调要的字段：前端据此显示「已用 2 / 上限 3」。
          // limit=0 表示不限（本地单机场景）。
          quota: { limit: capVaults, used: list.length, field: 'vaults', limited: capVaults > 0 },
        })
      }

      /**
       * POST /api/vaults/activate —— 切换「当前库」（写共享偏好，需重启进程生效）。
       *
       * 为什么不直接切：vaultRoot 是启动参数，进程跑起来就钉死了（所有 SQL 连接都挂在它上面）。
       * 运行中硬切会留下一堆指向旧库的缓存与事务。所以这里只**写偏好**并如实告知
       * needRestart，由用户决定何时重启 —— 自动重启可能正好撞上写卡。
       *
       * 偏好写进 $DSH_HOME/memory-eternal-active-vault.json，
       * web 服务与 DSH 插件端启动时都读它，从而实现「一端切库、另一端跟着」。
       */
      case '/vaults/activate': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const target = String(body.path || '').trim()
        if (!target) return json(res, 400, { ok: false, error: 'path 必填' })
        const { writeActiveVault, readActiveVault } = await import('./vault-pref.js')
        const w = writeActiveVault(target, process.env)
        if (!w.ok) return json(res, 400, w)
        // 偏好之外还要写配置：偏好会被「配置里的 vaultDir / 启动参数 --vault」压过去，
        // 只写偏好 = 重启后又回到旧库（见 persistVaultChoice 的说明）。
        const persisted = await persistVaultChoice(w.path)
        const isCurrent = path.resolve(w.path) === path.resolve(vaultRoot)
        return json(res, 200, {
          ok: true,
          path: w.path,
          prefFile: w.file,
          isCurrent,
          needRestart: !isCurrent,
          persisted,
          message: isCurrent ? '已经是当前库' : '已记录。重启服务后生效（DSH 面板与 web 端会一起切换）',
          activeNow: readActiveVault(process.env),
        })
      }

      /**
       * POST /api/vaults/switch —— 运行中换库（**不重启进程、不刷新页面**）。
       *
       * 与 /vaults/activate 的区别就是「什么时候生效」：
       *   · activate：只写偏好，等下次启动生效（老实现，独立 web 的 vaultRoot 是启动参数时唯一可行）
       *   · switch  ：注入热切换的进程里立刻把 vaultRoot 指向新库，同时写偏好保证重启后仍是这个库
       *
       * 没注入热切换（宿主形态）时**不报错**，自动回落成 activate 的语义并把 hot:false 如实带回 ——
       * 前端据此说「已记录，重启后生效」，而不是把用户卡在一个说「不支持」的按钮上。
       */
      case '/vaults/switch': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const target = String((body && body.path) || '').trim()
        if (!target) return json(res, 400, { ok: false, error: 'path 必填' })
        // ★ 只认允许根内的路径（S1）：请求里的路径不许越过作用域
        try { guardPath(target) } catch (e) {
          if (e && e.code === 'PATH_NOT_ALLOWED') return pathDenied(res, e)
          throw e
        }
        if (!switchVaultHot) {
          const { writeActiveVault, readActiveVault } = await import('./vault-pref.js')
          const w = writeActiveVault(target, process.env)
          if (!w.ok) return json(res, 400, w)
          const persisted = await persistVaultChoice(w.path)
          const isCurrent = path.resolve(w.path) === path.resolve(vaultRoot)
          return json(res, 200, {
            ok: true, hot: false, root: w.path, prefFile: w.file,
            isCurrent, needRestart: !isCurrent,
            message: isCurrent ? '已经是当前库' : '已记录。重启服务后生效',
            persisted,
            activeNow: readActiveVault(process.env),
          })
        }
        const out = await Promise.resolve()
          .then(() => switchVaultHot(target))
          .catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
        // 热切成功才写配置：切失败（目标库打不开）时不该把用户的配置改成那个坏路径
        if (out && out.ok) out.persisted = await persistVaultChoice(out.root || target)
        // 越过作用域（例：云端实例不许热切到别人的租户库）如实回 403，不混进「400 打不开」
        if (out && out.code === 'PATH_NOT_ALLOWED') return json(res, 403, out)
        return json(res, out && out.ok ? 200 : 400, out)
      }

      /**
       * POST /api/vaults/create —— 在**当前租户名下**新建一个记忆库。
       *
       * 入参: { name: 'work' }   （a-z 0-9 _ -，1-32 位）
       * 出参: { ok, name, root, created }
       *
       * 两条闸：
       *   ① caps.vaults —— 超限 403 quota_exceeded，带 limit/used 与升级链接
       *   ② 只能在自己的租户目录下建（云端），本地单机不开放建库
       *      （本地库是用户自己在 .dsh 下放的文件，不该由 API 随意创建）
       */
      case '/vaults/create': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
        const cvRoot = path.join(home, 'cloud-vaults')
        const inCloudRoot = path.resolve(vaultRoot).startsWith(path.resolve(cvRoot) + path.sep)
        if (!inCloudRoot) {
          return json(res, 400, { ok: false, error: '只有云端租户实例可以建库；本地库请自行在 .dsh 下创建目录' })
        }
        const body = await readBody(req)
        let mod
        try { mod = await import('./cloud-vaults.js') } catch {
          return json(res, 501, { ok: false, error: '云端多库是商用私有组件：当前开源包不含 cloud-vaults.js（本地库不受影响）' })
        }
        const slug = mod.normalizeVaultSlug(body && body.name)
        if (!slug) return json(res, 400, { ok: false, error: '库名只能用 a-z 0-9 _ -，1-32 位，且不能是 con/prn 等保留名' })

        // ① 配额：先数现有库
        let capVaults = 0
        try {
          const caps = typeof getCaps === 'function' ? (getCaps() || {}) : {}
          const fromCaps = Math.floor(Number(caps && caps.vaults))
          if (Number.isFinite(fromCaps) && fromCaps > 0) capVaults = fromCaps
        } catch { /* 拿不到就不限 */ }
        const existing = mod.listOwnerVaults(vaultRoot)
        // 重名幂等优先：已经存在就直接返回，不该因为"配额满了"而报 403
        const already = existing.find((v) => v.slug === slug)
        if (already) {
          return json(res, 200, { ok: true, name: already.name, root: already.root, created: false, quota: { limit: capVaults, used: existing.length } })
        }
        if (capVaults > 0 && existing.length >= capVaults) {
          return json(res, 403, {
            ok: false, error: 'quota_exceeded', field: 'vaults',
            limit: capVaults, used: existing.length,
            message: '当前套餐最多 ' + capVaults + ' 个记忆库，已用 ' + existing.length + ' 个',
            // 升级链接跟随**当前实例域名**（自建/另一个官方实例不能指向别人的订阅页）
            upgrade: (() => {
              const host = String((req && req.headers && req.headers.host) || '').trim()
              return resolvePayBase({ cloudUrl: host ? 'https://' + host : '' }) + '/subscribe?merchant=memory-eternal'
            })(),
          })
        }

        // ② 建库（幂等）
        const r = mod.createNamedVault(vaultRoot, slug)
        if (!r.ok) return json(res, 400, r)
        return json(res, 200, { ok: true, name: r.name, root: r.root, created: r.created, quota: { limit: capVaults, used: mod.listOwnerVaults(vaultRoot).length } })
      }

      /**
       * GET /api/vaults/export?path=<库> —— 导出**指定库**的卡片（默认当前库）。
       *
       * 为什么需要：/export 只读当前 vaultRoot。而「把某个旧库上传到云端」要先读那个库，
       * 它可能不是当前库（比如 memory-vault-ok 这种历史副本）。
       * 返回体与 /export 同形状（{ ok, format, count, cards }），前端逻辑不用改。
       */
      case '/vaults/export': {
        const want = String(query.get('path') || '').trim()
        // ★ 请求里带的路径必须落在允许根内（S1）；不带则读当前库
        let root
        try {
          root = want ? guardPath(want) : path.resolve(vaultRoot)
        } catch (e) {
          if (e && e.code === 'PATH_NOT_ALLOWED') return pathDenied(res, e)
          throw e
        }
        if (!fs.existsSync(path.join(root, dbFileIn(root)))) {
          return json(res, 400, { ok: false, error: '库不存在：' + root })
        }
        try {
          const db = getDb(root)
          const rows = db.prepare("SELECT title, kind, tags, body, summary, source, status, content_hash, card_key FROM cards").all()
          const cards = rows.map((r) => ({
            title: r.title,
            kind: r.kind,
            tags: r.tags,
            // 备份格式要求整卡 markdown 形状：这里把 frontmatter 拼回去，importChunk 会再拆
            text: '---\ntitle: ' + String(r.title || '').replace(/\n/g, ' ') + '\nkind: ' + (r.kind || 'knowledge') + '\n---\n\n' + (r.body || ''),
            body: r.body,
            summary: r.summary,
            source: r.source,
            status: r.status,
            content_hash: r.content_hash,
            card_key: r.card_key,
          }))
          return json(res, 200, {
            ok: true,
            format: 'memory-eternal-vault',
            formatVersion: 1,
            exportedAt: new Date().toISOString(),
            vault: root,
            count: cards.length,
            cards,
          })
        } catch (e) {
          return json(res, 500, { ok: false, error: '导出失败：' + String((e && e.message) || e) })
        }
      }

      /**
       * POST /api/vaults/import-into —— 把一批卡片写进**指定库**（可以不是当前库）。
       *
       * 场景：云端 → 某个本地库。「云端」在远端机器上，服务端拿不到它的文件，
       * 所以只能前端先把云端 /export 的数据取回来，再让这里写进本地目标库。
       *
       * 入参: { target: '<库路径>', cards: [...], onDuplicate?: 'skip'|'overwrite' }
       * 出参: { ok, imported, skipped, overwritten, failed, total }
       *
       * onDuplicate=skip 走现成的 importChunk（它按 contentHash 去重，天然幂等）；
       * =overwrite 时先把目标库里同 hash 的卡删掉再写，等同"用来源内容更新"。
       */
      case '/vaults/import-into': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        // 整库卡片批量上传：显式放宽到 LARGE（默认 2MB 会让「把大库传到云端」直接 413）
        const body = await readBody(req, { maxBytes: LARGE_BODY_BYTES })
        const target = String(body.target || '').trim()
        const cards = Array.isArray(body.cards) ? body.cards : []
        const onDuplicate = body.onDuplicate === 'overwrite' ? 'overwrite' : 'skip'
        if (!target) return json(res, 400, { ok: false, error: 'target 必填' })
        if (!cards.length) return json(res, 400, { ok: false, error: 'cards 为空' })
        // ★ 目标库必须在允许根内（S1）：不许往别人的租户库/任意目录写卡
        let root
        try {
          root = guardPath(target)
        } catch (e) {
          if (e && e.code === 'PATH_NOT_ALLOWED') return pathDenied(res, e)
          throw e
        }
        if (!fs.existsSync(path.join(root, dbFileIn(root)))) return json(res, 400, { ok: false, error: '目标库不存在：' + root })

        try {
          const db = getDb(root)
          if (onDuplicate === 'overwrite') {
            // 先算出这批卡的 hash，把目标库里已有的同 hash 行删掉（进回收站语义太绕，直接删）
            let removed = 0
            try {
              const hashes = [...new Set(cards.map((c) => {
                // importChunk 用 contentHash(title, body)；这里只做粗筛，真正的判重仍由 importChunk 兜底
                const t = String(c.title || '').trim()
                const b = String(c.body || c.text || '')
                return t + '\u0000' + b
              }))]
              void hashes
              // 保守做法：交给 importChunk 去重，overwrite 只是"允许写入已存在的 hash"
              // —— importChunk 本身没有 overwrite 模式，所以这里用「先删同 hash 再插」的近似：
              // 逐条按 title 找同名卡删掉（不追求完美，宁可多留也不误删）。
              for (const c of cards) {
                const t = String(c.title || '').trim()
                if (!t) continue
                try {
                  const hit = db.prepare('SELECT id, path FROM cards WHERE title = ? LIMIT 1').get(t)
                  if (hit) { db.prepare('DELETE FROM cards WHERE id = ?').run(hit.id); removed++ }
                } catch { /* 单条失败不影响整批 */ }
              }
            } catch { /* 忽略 */ }
            void removed
          }
          const { importChunk } = await import('./import-batch.js')
          const r = await importChunk(root, cards)
          // 上传批次销账：按 title+kind 标记本批条目；全部完成则批次 done
          const _batchId = Number(body && body.batchId) || 0
          if (_batchId) {
            try {
              const bdb = getDb(root)
              const markHash = bdb.prepare("UPDATE upload_items SET state = 'done' WHERE batch_id = ? AND hash = ?")
              const markName = bdb.prepare("UPDATE upload_items SET state = 'done' WHERE batch_id = ? AND (hash = '' OR hash IS NULL) AND title = ? AND kind = ?")
            for (const c of cards) {
              const h = String(c.content_hash || c.contentHash || '')
              if (h) markHash.run(_batchId, h); else markName.run(_batchId, String(c.title || ''), String(c.kind || c.type || ''))
            }
              const done = bdb.prepare("SELECT COUNT(*) n FROM upload_items WHERE batch_id = ? AND state = 'done'").get(_batchId).n
              const total = bdb.prepare('SELECT COUNT(*) n FROM upload_items WHERE batch_id = ?').get(_batchId).n
              bdb.prepare("UPDATE upload_batches SET done = ?, state = CASE WHEN ? >= total THEN 'done' ELSE 'pending' END, updated_at = ? WHERE id = ?").run(done, done, new Date().toISOString(), _batchId)
            } catch { /* 批次销账失败不影响主流程 */ }
          }
          return json(res, 200, {
            ok: true,
            target: root,
            total: cards.length,
            imported: Number(r.imported) || 0,
            skipped: Number(r.skipped) || 0,
            overwritten: onDuplicate === 'overwrite' ? Number(r.imported) || 0 : 0,
            failed: (r.failed || []).length,
            onDuplicate,
          })
        } catch (e) {
          return json(res, 500, { ok: false, error: '写入失败：' + String((e && e.message) || e) })
        }
      }

      /**
       * POST /api/vaults/transfer —— 库之间搬运卡片（上传/下载是同一个操作，只是方向不同）。
       *
       * 入参: { source, target, onDuplicate?: 'skip'|'overwrite', dryRun?: boolean }
       *   任一端可以是当前库路径；云端租户库也在 /api/vaults 的枚举里。
       * 出参: { ok, total, imported, skipped, overwritten, failed, dryRun }
       *
       * 去重靠 content_hash（标题+正文），不是路径 —— 同一张卡换个路径也算重复。
       * onDuplicate=skip 时跳过（默认，安全）；=overwrite 时用源库内容覆盖目标库同 hash 的卡。
       * dryRun 只统计不动数据 —— 用户点「上传」前先看清楚会动多少条。
       */
      /** 上传批次：先登记「标题/类型清单」，再分片上传；中断后云端可见未完成。 */
      case '/vaults/upload/begin': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req, { maxBytes: LARGE_BODY_BYTES })
        const target = String(body.target || '').trim()
        const items = Array.isArray(body.items) ? body.items.slice(0, 20000) : []
        if (!target) return json(res, 400, { ok: false, error: 'target 必填' })
        if (!items.length) return json(res, 400, { ok: false, error: 'items 为空' })
        let root
        try { root = guardPath(target) } catch (e) { if (e && e.code === PATH_NOT_ALLOWED) return pathDenied(res, e); throw e }
        if (!fs.existsSync(path.join(root, dbFileIn(root)))) return json(res, 400, { ok: false, error: '目标库不存在：' + root })
        const db = getDb(root)
        const now = new Date().toISOString()
        // 复用：同目标、同标题集合的 pending 批次（继续上传时不再新建）
        try {
          const prev = db.prepare("SELECT id, total FROM upload_batches WHERE target = ? AND state = 'pending' ORDER BY id DESC LIMIT 1").get(root)
          if (prev && Number(prev.total) === items.length) {
            const prevItems = db.prepare('SELECT title FROM upload_items WHERE batch_id = ?').all(prev.id)
            const a = prevItems.map((x) => String(x.title)).sort().join('\u0000')
            const b = items.map((x) => String(x.title || '')).sort().join('\u0000')
            if (a === b) return json(res, 200, { ok: true, id: prev.id, total: items.length, reused: true })
          }
        } catch { /* 复用失败就新建 */ }
        const out = db.prepare("INSERT INTO upload_batches (target, state, total, done, created_at, updated_at) VALUES (?, 'pending', ?, 0, ?, ?)").run(root, items.length, now, now)
        const batchId = Number(out.lastInsertRowid)
        const ins = db.prepare("INSERT INTO upload_items (batch_id, path, title, kind, hash, state) VALUES (?, ?, ?, ?, ?, 'pending')")
        let inTx = false
        try { db.exec('BEGIN IMMEDIATE'); inTx = true } catch { inTx = false }
        try {
          for (const it of items) ins.run(batchId, String(it.path || ''), String(it.title || ''), String(it.kind || it.type || ''), String(it.hash || ''))
          if (inTx) db.exec('COMMIT')
        } catch (e) { if (inTx) { try { db.exec('ROLLBACK') } catch { /* 忽略 */ } } throw e }
        return json(res, 200, { ok: true, id: batchId, total: items.length })
      }
      case '/vaults/upload/batches': {
        const target = String(query.get('target') || '').trim()
        const state = String(query.get('state') || '').trim()
        const scanDirs = target ? [guardPath(target)] : (() => {
          const out = [vaultRoot]
          try {
            const parent = path.dirname(vaultRoot)
            for (const ent of fs.readdirSync(parent, { withFileTypes: true })) {
              if (!ent.isDirectory()) continue
              const d = path.join(parent, ent.name)
              if (fs.existsSync(path.join(d, dbFileIn(d)))) out.push(d)
            }
          } catch { /* 忽略 */ }
          return [...new Set(out)]
        })()
        const out = []
        for (const dir of scanDirs) {
          try {
            const db = getDb(dir)
            const rows = db.prepare('SELECT * FROM upload_batches ORDER BY id DESC LIMIT 20').all()
            for (const r of rows) {
              if (state && r.state !== state) continue
              const items = db.prepare('SELECT path, title, kind, state, error FROM upload_items WHERE batch_id = ? ORDER BY id LIMIT 200').all(r.id)
              out.push({ ...r, target: dir, items, remaining: items.filter((x) => x.state !== 'done').slice(0, 50), doneCount: items.filter((x) => x.state === 'done').length, totalCount: items.length })
            }
          } catch { /* 单库失败不影响其他库 */ }
        }
        return json(res, 200, { ok: true, batches: out })
      }
      case '/vaults/upload/cancel': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const db = getDb(String(body.target || '').trim() ? guardPath(String(body.target).trim()) : vaultRoot)
        db.prepare("UPDATE upload_batches SET state = 'canceled', updated_at = ? WHERE id = ?").run(new Date().toISOString(), Number(body.id))
        return json(res, 200, { ok: true })
      }
      case '/vaults/upload/finish': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const db = getDb(String(body.target || '').trim() ? guardPath(String(body.target).trim()) : vaultRoot)
        db.prepare("UPDATE upload_batches SET state = 'done', updated_at = ? WHERE id = ?").run(new Date().toISOString(), Number(body.id))
        return json(res, 200, { ok: true })
      }

      case '/vaults/transfer': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const from = String(body.source || '').trim()
        const to = String(body.target || '').trim()
        const onDuplicate = body.onDuplicate === 'overwrite' ? 'overwrite' : 'skip'
        const dryRun = body.dryRun === true
        if (!from || !to) return json(res, 400, { ok: false, error: 'source 与 target 必填' })
        let fromAbs, toAbs
        try {
          fromAbs = guardPath(from)
          toAbs = guardPath(to)
        } catch (e) {
          if (e && e.code === 'PATH_NOT_ALLOWED') return pathDenied(res, e)
          throw e
        }
        if (fromAbs === toAbs) return json(res, 400, { ok: false, error: '源与目标不能是同一个库' })
        for (const [label, p2] of [['source', fromAbs], ['target', toAbs]]) {
          const dbFile = path.join(p2, dbFileIn(p2))
          if (!fs.existsSync(dbFile)) return json(res, 400, { ok: false, error: label + ' 库不存在：' + p2 })
        }

        const srcDb = getDb(fromAbs)
        const dstDb = getDb(toAbs)
        const { tableForStatus } = await import('./db.js')
        let rows = []
        try {
          rows = srcDb.prepare(`SELECT 'cards' AS store, uid, path, title, kind, tags, body, summary, source, status, content_hash, card_key,
              submitted_by, severity, created_at, field_hlc, origin_device, vv FROM cards
            UNION ALL
            SELECT 'quarantine' AS store, uid, path, title, kind, tags, body, summary, source, status, content_hash, card_key,
              submitted_by, severity, created_at, field_hlc, origin_device, vv FROM quarantine`).all()
        } catch (e) {
          return json(res, 500, { ok: false, error: '读源库失败：' + String((e && e.message) || e) })
        }
        // 目标库已有：按 content_hash 与 uid 双键判重（两张表都算）
        const byHash = new Map()
        const byUid = new Map()
        const scan = (table) => { try { for (const r of dstDb.prepare('SELECT id, uid, content_hash, status FROM ' + table).all()) { const v = { ...r, store: table }; if (r.content_hash) byHash.set(r.content_hash, v); if (r.uid) byUid.set(r.uid, v) } } catch { /* 老库没有这些列 */ } }
        scan('cards'); scan('quarantine')

        const parseJ = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v } catch { return d } }
        const cardCols = 'path, kind, title, tags, body, summary, status, source, submitted_by, severity, created_at, updated_at, content_hash, card_key, uid, field_hlc, origin_device, vv'
        const cardPh = '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), ?, ?, ?, ?, ?, ?'
        let imported = 0, skipped = 0, overwritten = 0, failed = 0
        const errs = []
        const changed = []
        if (!dryRun) {
          let inTx = false
          try { dstDb.exec('BEGIN'); inTx = true } catch { inTx = false }
          try {
            const insCards = dstDb.prepare('INSERT INTO cards (' + cardCols + ') VALUES (' + cardPh + ')')
            const insQ = dstDb.prepare('INSERT INTO quarantine (' + cardCols + ', quarantined_at, quarantine_reason) VALUES (' + cardPh + ', datetime(\'now\'), \'\')')
            const updCards = dstDb.prepare("UPDATE cards SET title=?, kind=?, tags=?, body=?, summary=?, source=?, updated_at=datetime('now'), content_hash=?, card_key=?, field_hlc=?, origin_device=?, vv=? WHERE id=?")
            const updQ = dstDb.prepare("UPDATE quarantine SET title=?, kind=?, tags=?, body=?, summary=?, source=?, updated_at=datetime('now'), content_hash=?, card_key=?, field_hlc=?, origin_device=?, vv=? WHERE id=?")
            const upd = (store) => (store === 'quarantine' ? updQ : updCards)
            let seq = 0
            for (const r of rows) {
              const h = r.content_hash || ''
              const dup = (h && byHash.get(h)) || (r.uid && byUid.get(r.uid)) || null
              try {
                if (dup) {
                  if (onDuplicate === 'skip' && h && byHash.has(h)) { skipped++; continue }
                  upd(dup.store).run(r.title, r.kind, r.tags, r.body, r.summary || '', r.source || '', h, r.card_key || null, r.field_hlc || '{}', r.origin_device || '', r.vv || '{}', dup.id)
                  overwritten++
                  changed.push({ uid: dup.uid, r, status: dup.status })
                  continue
                }
                const rel = '99-Import/' + (r.kind || 'knowledge') + '/' + String(r.title || 'card').slice(0, 40).replace(/[\\/:*?"<>|]/g, '_') + '-' + Date.now().toString(36) + '-' + (seq++) + '.md'
                const args = [rel, r.kind || 'knowledge', r.title || '导入卡', r.tags || '[]', r.body || '', r.summary || '', r.status || 'pending', r.source || '', r.submitted_by || '', r.severity || 'info', r.created_at || new Date().toISOString(), h, r.card_key || null, r.uid || null, r.field_hlc || '{}', r.origin_device || '', r.vv || '{}']
                const table = tableForStatus(r.status || 'pending')
                if (table === 'quarantine') insQ.run(...args); else insCards.run(...args)
                imported++
                const row2 = h ? dstDb.prepare('SELECT id, uid, content_hash, status FROM ' + table + ' WHERE content_hash = ? ORDER BY id DESC LIMIT 1').get(h) : null
                if (row2) { const v = { ...row2, store: table }; byHash.set(h, v); if (row2.uid) byUid.set(row2.uid, v) }
                changed.push({ uid: r.uid, r, status: r.status || 'pending' })
              } catch (e) {
                failed++
                if (errs.length < 5) errs.push(String((e && e.message) || e).slice(0, 120))
              }
            }
            if (inTx) dstDb.exec('COMMIT')
          } catch (e) {
            if (inTx) { try { dstDb.exec('ROLLBACK') } catch { /* 已回滚 */ } }
            return json(res, 500, { ok: false, error: '写入目标库失败：' + String((e && e.message) || e) })
          }
        } else {
          for (const r of rows) {
            const h = r.content_hash || ''
            const dup = (h && byHash.get(h)) || (r.uid && byUid.get(r.uid)) || null
            if (dup) { if (onDuplicate === 'overwrite') overwritten++; else skipped++ } else imported++
          }
        }

        let events = 0
        if (!dryRun && changed.length) {
          try {
            const { recordSyncEvent } = await import('./vault.js')
            for (const { uid, r, status } of changed) {
              if (!uid) continue
              recordSyncEvent(dstDb, {
                uid, op: 'update', device: 'transfer',
                patch: { title: r.title, body: r.body, tags: parseJ(r.tags, []), kind: r.kind, summary: r.summary, source: r.source, status },
                fieldHlc: parseJ(r.field_hlc, {}),
              })
              events++
            }
            if (scopeMode === 'cloud' && events) {
              const { publishDeviceEvents } = await import('./sync.js')
              publishDeviceEvents(toAbs, 'transfer')
            }
          } catch { /* 事件失败不阻断搬运 */ }
        }
        return json(res, 200, {
          ok: true, dryRun,
          total: rows.length,
          imported, skipped, overwritten, failed,
          errors: errs,
          events,
          from: path.resolve(from), to: path.resolve(to), onDuplicate,
        })
      }

      /**
       * POST /api/lookup —— 存在性查询（四态），外部集成方核心需求。
       * 存在性是**查表**问题，不是相关性排序；recall 的模糊召回对「在不在库里」零判断力。
       * 入参 { keys:[], filter?:{source?,kind?,prefix?} }，上限 200，走索引。
       * 出参 results 顺序与请求严格一致；state ∈ approved|pending|rejected|missing。
       */
      case '/lookup': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const rawKeys = Array.isArray(body.keys) ? body.keys : []
        const keys = []
        for (const k of rawKeys) { const v = typeof k === 'string' ? k.trim() : ''; if (v) keys.push(v) }
        if (!keys.length) return json(res, 400, { ok: false, error: 'keys 不能为空' })
        if (keys.length > 200) return json(res, 413, { ok: false, error: '一次最多 200 个 key', maxKeys: 200 })
        const filter = body.filter && typeof body.filter === 'object' ? body.filter : {}
        const db = getDb(vaultRoot)
        const uniq = [...new Set(keys)]
        const ph = uniq.map(() => '?').join(',')
        const hit = new Map()
        let fromQuarantine = false
        const collect = (rows, table) => {
          for (const r of rows) {
            if (!r.card_key || hit.has(r.card_key)) continue
            // quarantine 里的条目在等人工处理 → 对外统一算 pending
            hit.set(r.card_key, {
              key: r.card_key,
              state: table === 'quarantine' ? 'pending' : normalizeState(r.status),
              path: r.path || '',
              kind: r.kind || '',
              source: r.source || '',
              content_hash: r.content_hash || '',
              updated_at: r.updated_at || '',
            })
          }
        }
        try { collect(db.prepare(`SELECT card_key, path, kind, source, status, content_hash, updated_at FROM cards WHERE card_key IN (${ph})`).all(...uniq), 'cards') } catch { /* 老库未迁移 */ }
        try { collect(db.prepare(`SELECT card_key, path, kind, source, status, content_hash, updated_at FROM quarantine WHERE card_key IN (${ph})`).all(...uniq), 'quarantine') } catch { /* 同上 */ }
        const results = keys.map((key) => {
          const r = hit.get(key)
          if (!r) return { key, state: 'missing' }
          if (filter.source && String(r.source) !== String(filter.source)) return { key, state: 'missing' }
          if (filter.kind && String(r.kind) !== String(filter.kind)) return { key, state: 'missing' }
          if (filter.prefix && !String(key).startsWith(String(filter.prefix))) return { key, state: 'missing' }
          return r
        })
        return json(res, 200, { ok: true, results, count: results.length, schema_version: readSchemaVersion(db) })
      }

      /**
       * POST /api/upsert —— 按稳定主键写入（幂等）。
       * 同 key 二次提交 = 更新内容 + 重置 pending，不新建卡。
       * 永远进 pending：外部产出的内容未经人工确认，不自动进主库（产品决定）。
       */
      case '/upsert': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const card = body.card && typeof body.card === 'object' ? body.card : {}
        const key = String(card.key || '').trim()
        const title = String(card.title || '').trim()
        const text = String(card.body || card.text || card.content || '').trim()
        const kind = String(card.kind || 'knowledge').trim() || 'knowledge'
        const source = String(card.source || '').trim()
        if (!key) return json(res, 400, { ok: false, error: 'card.key 必填' })
        if (!/^[a-z0-9][a-z0-9._-]{2,64}$/.test(key)) return json(res, 400, { ok: false, error: 'card.key 格式非法', got: key })
        if (!text) return json(res, 400, { ok: false, error: 'card.body 不能为空' })
        if (!title) return json(res, 400, { ok: false, error: 'card.title 必填' })
        const db = getDb(vaultRoot)
        const old = db.prepare('SELECT id, path FROM cards WHERE card_key = ?').get(key)
          || db.prepare('SELECT id, path FROM quarantine WHERE card_key = ?').get(key)
        // 先释放旧行的 key（唯一索引不允许两行同 key），再走 writeCard ——
        // 这样搜索索引/向量同步/去重台账都走同一套副作用，不会「更新了但搜不到」。
        if (old) {
          try { db.prepare('UPDATE cards SET card_key = NULL WHERE card_key = ?').run(key) } catch { /* 忽略 */ }
          try { db.prepare('UPDATE quarantine SET card_key = NULL WHERE card_key = ?').run(key) } catch { /* 忽略 */ }
          try { await deleteCard(vaultRoot, old.path, { permanent: false }) } catch { /* 旧卡可能已删 */ }
        }
        const w = await writeCard(vaultRoot, { kind, title, body: text, source, status: 'pending' }, { dedup: false })
        // 落哪张表由 enforceAudit 决定（pending 可能在 cards，也可能在 quarantine），
        // 两个都试 —— 原来只查 cards，pending 进了 quarantine 就打不上 key（表现为「提交成功但查不到」）。
        const row = db.prepare('SELECT id, path, content_hash FROM cards WHERE path = ?').get(w.path)
          || db.prepare('SELECT id, path, content_hash FROM quarantine WHERE path = ?').get(w.path)
        const store = db.prepare('SELECT 1 AS x FROM cards WHERE path = ?').get(w.path) ? 'cards' : 'quarantine'
        if (row) {
          try { db.prepare(`UPDATE ${store} SET card_key = ? WHERE id = ?`).run(key, row.id) } catch (e) {
            return json(res, 500, { ok: false, error: '写入 card_key 失败：' + String((e && e.message) || e) })
          }
        }
        // 操作日志：外部集成按稳定主键写入也记一条
try {
          const _k = String((typeof key === 'string' && key) || '')
          const _t = String((typeof title === 'string' && title) || '(无标题)').slice(0, 200)
          logActivity(vaultRoot, { ip: clientIpOf(req), agent: 'upsert', action: 'upsert', title: _t + (_k ? ' [' + _k + ']' : '') })
        } catch { /* 旁路 */ }
        return json(res, 200, {
          ok: true,
          action: old ? 'updated' : 'created',
          key,
          id: row ? row.id : (w.id || null),
          state: 'pending',
          path: w.path || (row && row.path) || '',
          content_hash: (row && row.content_hash) || w.contentHash || '',
          schema_version: readSchemaVersion(db),
        })
      }

      /**
       * GET /api/health —— 健康与版本的**单一来源**。
       * 只给一个 version；alive 以「此刻能不能服务请求」为准。
       */
      case '/health': {
        const db = getDb(vaultRoot)
        const st = dbStatus(vaultRoot) || {}
        let cards = 0, pending = 0, quarantined = 0
        try { cards = Number(db.prepare('SELECT COUNT(*) n FROM cards').get().n) || 0 } catch { /* 库未建 */ }
        try { pending = Number(db.prepare("SELECT COUNT(*) n FROM cards WHERE status = 'pending'").get().n) || 0 } catch { /* 同上 */ }
        try { quarantined = Number(db.prepare('SELECT COUNT(*) n FROM quarantine').get().n) || 0 } catch { /* 同上 */ }
        let dbBytes = 0
        try { dbBytes = fs.statSync(path.join(vaultRoot, dbFileIn(vaultRoot))).size } catch { /* 还没文件 */ }
        const servingVersion = (getDshInfo() || {}).version || process.env.MEMORY_ETERNAL_VERSION || ''
        return json(res, 200, {
          ok: true,
          vault: vaultRoot,
          db: path.join(vaultRoot, dbFileIn(vaultRoot)),
          db_bytes: dbBytes,
          version: servingVersion,
          alive: true,
          writable: st.writable !== false,
          cards,
          pending,
          quarantined,
          schema_version: readSchemaVersion(db),
        })
      }

      case '/overview': {
        // version = **当前正在服务这个端口的进程**加载的包版本（issue #23）：
        // 磁盘上升级了、端口上跑的还是旧进程时，只有这个字段说得清真相（锁文件里的
        // pkgVersion 是 watchdog 自己写的，与端口上真正服务的代码无关）。
        const servingVersion = (getDshInfo() || {}).version || process.env.MEMORY_ETERNAL_VERSION || ''
        const degraded = async (error) => {
          // #33：库/目录不可用时**不再吐 500**。500 会被上层（探针、面板、脚本）读成
          // 「这个端口坏了 / 不是我们的服务」，历史上就是这么引出重启风暴与端口漂移的。
          // 降级成 200 + degraded 标记，身份字段（vaultDir/version）照旧带上 ——
          // 「这是我们、但库有问题」从此可以被分开表达，用户也能看到真实原因。
          const status = { writable: false, error: String(error), ...(dbStatus(vaultRoot) || {}) }
          json(res, 200, {
            ok: true, degraded: true, vaultDir: vaultRoot, dbPath: path.join(vaultRoot, dbFileIn(vaultRoot)), version: servingVersion,
            total: 0, byKind: {}, roots: {}, db: status, dbError: status.error,
            guidance: rebuildGuidance(vaultRoot, status),
            capture: await captureSelfCheck(),
          })
        }
        try { await ensureVault(vaultRoot) } catch (e) { return await degraded((e && e.message) || e) }
        let data
        try { data = await overview(vaultRoot) } catch (e) { return await degraded((e && e.message) || e) }
        // 健康面板要看「最近一次备份多久前」：这里给摘要（最多 5 个文件名，避免把响应撑大）
        let backups = { count: 0, newestAt: 0, files: [] }
        try {
          const dir = path.join(vaultRoot, 'backups')
          const names = fs.readdirSync(dir).filter((n) => /\.db$/i.test(n)).sort()
          let newestAt = 0
          if (names.length) {
            const newest = names[names.length - 1]
            try { newestAt = fs.statSync(path.join(dir, newest)).mtimeMs } catch { newestAt = 0 }
          }
          backups = { count: names.length, newestAt, files: names.slice(-5) }
        } catch { /* 没有备份目录 */ }
        // 本进程是「服务端实例」还是「本地客户端」——产品上是两种东西：
        //   服务端：多账号（owner）、每账号多 db、库在服务器磁盘上
        //   客户端：db **固定**，登录云端只是把数据同步过去，本地库不变
        // 前端据此决定文案与按钮；不能靠"当前库路径里有没有 cloud-vaults"去猜 ——
        // 云端模式下前端 fetch 会被重写，那个路径拿到的是远端的，判断必然错（踩过）。
        const _cvRoot = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'cloud-vaults') : ''
        const _hostRole = (_cvRoot && path.resolve(vaultRoot).startsWith(path.resolve(_cvRoot) + path.sep)) ? 'server' : 'client'
        json(res, 200, {
          ok: true,
          vaultDir: vaultRoot,
          hostRole: _hostRole,
          // 记忆库数据库的**绝对路径**（给「本地私有」模式显示"数据存哪儿"）。
          // 注意 `db` 字段是健康状态对象（journalMode/writable/corrupt），不能拿来拼路径。
          dbPath: path.join(vaultRoot, dbFileIn(vaultRoot)),
          version: servingVersion,
          // 磁盘上的真实版本（每次都读，不缓存）。
          // 与 version（进程启动时固定的运行版本）不一致 = 插件已升级但宿主没重启，
          // 此时所有改动都不会生效 —— 客户端会据此在顶部提示「请重启 DSH」。
          pkgVersion: readPkgVersion(),
          db: dbStatus(vaultRoot),
          backups,
          // 沉淀自检（发号器 / 最近一次蒸馏失败 / 最近一次成功）：见 captureSelfCheck 的注释
          capture: await captureSelfCheck(),
          ...data,
        })
        return
      }
      case '/type-cloud': {
        // 卡片类型云：把 tags 里的「知识类型:x / 技能类型:x」聚合成分组计数，
        // 给面板的「类型芯片行」用（前端不再需要拉 500 张卡自己算）。
        // kind 可选：knowledge / skill；不传 = 两类都返回（每条带 kind 区分）。
        const want = String(query.get('kind') || '').toLowerCase()
        const prefixOf = { knowledge: ['知识类型:'], skill: ['技能类型:'] }
        const prefixes = want && prefixOf[want] ? prefixOf[want] : ['知识类型:', '技能类型:']
        const kindOf = (tag) => (tag.startsWith('技能类型:') ? 'skill' : 'knowledge')
        const items = []
        try {
          await ensureVault(vaultRoot)
          const db = getDb(vaultRoot)
          for (const p of prefixes) {
            const rows = db.prepare(`
              SELECT t.value AS tag, count(*) AS n
              FROM cards, json_each(cards.tags) t
              WHERE t.value LIKE ?
              GROUP BY t.value ORDER BY n DESC
            `).all(p + '%')
            for (const r of rows) {
              items.push({ tag: r.tag, label: String(r.tag).slice(p.length), n: Number(r.n) || 0, kind: kindOf(r.tag) })
            }
          }
        } catch (e) {
          return json(res, 200, { ok: true, items: [], total: 0, error: String((e && e.message) || e) })
        }
        items.sort((a, b) => b.n - a.n)
        json(res, 200, { ok: true, items, total: items.length })
        return
      }
      case '/cards': {
        // ⚠ 这里**只做查询**。写卡是 /card（单数）。
        //   以前没有 method 检查：POST /cards 会一路掉进下面的查询逻辑，
        //   返回 200 + 一个空列表 —— 调用方以为写成功了，实际什么都没发生（实测踩到）。
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return json(res, 405, {
            ok: false, code: 'method_not_allowed',
            error: 'POST 请用 /card（单数）写卡；/cards 只用于查询',
            write: '/card',
          })
        }
        const kind = query.get('kind') || ''
        const q = query.get('q') || ''
        const status = (query.get('status') || 'approved').toLowerCase()
        // 真分页：offset/limit + total（客户端据此判断还有没有下一页）
        const limit = Math.min(Math.max(Number(query.get('limit')) || 200, 1), 500)
        const offset = Math.max(Number(query.get('offset')) || 0, 0)
        const sort = query.get('sort') === 'title' ? 'title' : 'recent'
        const agent = query.get('agent') || '' // 服务端署名过滤（如 agent=deepseek-harness）
        // all = 全部（含 pending/rejected，排除回收站）；默认/approved = 已审核；
        // deleted = 回收站（隔离区里 status=deleted，与 /card、/recycle/list 保持一致，见 issue #22）。
        // 白名单（P0 修复）：除下面四种取值外一律按 approved 处理，未知 status 不再可能越权列未审核卡。
        const KNOWN_STATUS = ['all', 'approved', 'pending', 'rejected', 'deleted', 'archived']
        const want = status === 'all' ? ['approved', 'pending', 'rejected']
          : status === 'pending' ? ['pending']
          : status === 'rejected' ? ['rejected']
          : status === 'deleted' ? ['deleted']
          : status === 'archived' ? ['archived']
          : ['approved']
        // issue #22：unknown status 以前被静默当成 approved，调用方拿到「看起来正常」的主库内容
        // 却无从察觉（total 与 /recycle/list 打架就是这么来的）。这里回显**实际生效**的 status，
        // 并对无法识别的取值显式置 unknownStatus:true —— 回落行为保留（不破坏老调用方），但不再沉默。
        const appliedStatus = status === 'all' ? 'all'
          : status === 'pending' ? 'pending'
          : status === 'rejected' ? 'rejected'
          : status === 'deleted' ? 'deleted'
          : status === 'archived' ? 'archived'
          : 'approved'
        const unknownStatus = !KNOWN_STATUS.includes(status)
        // issue #46 后的界面改进：标签筛选（点芯片即筛）。与搜索可叠加。
        const tag = (query.get('tag') || '').trim()
        if (q.trim()) {
          // 检索是相关性排序：先把命中集合取齐，再在内存里分页（保证 total 与顺序一致）
          const hits = await search(vaultRoot, q, { limit: 500 })
          // 相关性门槛：多词自然语言查询（"怎么防止脚本被卡住"）会靠常见词命中大半个库，
          // 原样返回就是「搜什么都一堆」。这里按**相对分数**收口（相对最高分的一半），
          // 同时给一个绝对下限，避免只有一条命中时把唯一结果也删掉。
          const topScore = hits.length ? Number(hits[0].score) || 0 : 0
          const floor = topScore > 0 ? Math.max(2, topScore * 0.55) : 0
          const kept = floor > 0 ? hits.filter((h) => Number(h.score) >= floor) : hits
          const hitByPath = new Map(kept.map((h) => [h.path, h]))
          const hitPaths = new Set(kept.map((h) => h.path))
          let cards = (await listCards(vaultRoot, { status: want, kind, agent, tag }))
            .filter((c) => hitPaths.has(c.path))
            // 把命中证据（在哪命中、命中词、片段、相关分数）挂回卡片：
            // 混合检索会带出「无语义字面命中」的卡片，前端需要它来解释「为什么这条在结果里」。
            .map((c) => {
              const h = hitByPath.get(c.path)
              return h ? { ...c, score: h.score, _match: h._match } : c
            })
          const total = cards.length
          json(res, 200, { ok: true, cards: cards.slice(offset, offset + limit), total, offset, limit, appliedStatus, requestedStatus: status, unknownStatus, relevanceFloor: Math.round(floor * 10) / 10 })
          return
        }
        const total = await countCards(vaultRoot, { status: want, kind, agent, tag })
        const cards = await listCards(vaultRoot, { status: want, kind, agent, tag, limit, offset, sort })
        json(res, 200, { ok: true, cards, total, offset, limit, appliedStatus, requestedStatus: status, unknownStatus })
        return
      }
      case '/card': {
        const rel = query.get('path') || ''
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        // 默认只能读已审核卡（P0 修复）。审核中心 / 回收站要预览未审核卡时带 ?status=pending|rejected|deleted，
        // 但只放行**确实在审核队列或回收站里**的 path —— 未知 path 不能靠参数把未审核正文读出来。
        const statusParam = (query.get('status') || '').toLowerCase()
        const wantsUnapproved = statusParam === 'pending' || statusParam === 'rejected' || statusParam === 'deleted'
        if (wantsUnapproved) {
          let inQueue = false
          try {
            if (statusParam === 'deleted') {
              inQueue = (await recycleList(vaultRoot)).some((c) => c.path === rel)
            } else {
              const q = await auditQueue(vaultRoot)
              inQueue = (statusParam === 'pending' ? q.pending : q.rejected).some((c) => c.path === rel)
            }
          } catch { inQueue = false }
          if (!inQueue) return json(res, 403, { ok: false, error: '该卡片不在审核队列 / 回收站中，不能以未审核身份读取', code: 'CARD_NOT_APPROVED' })
        }
        const card = await readCard(vaultRoot, rel, { allowUnapproved: wantsUnapproved })
        json(res, 200, { ok: true, path: card.path, status: card.status, text: card.text })
        return
      }
      // ── 多端同步（P2）：事件推送 / 拉取 / 摘要 ───────────────────────
      case '/sync/push': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const { appendRemoteEvents } = await import('./sync.js')
        const out = appendRemoteEvents(vaultRoot, body && body.events)
        return json(res, 200, out)
      }
      case '/sync/pull': {
        const since = Number(query.get('since') || 0) || 0
        const limit = Number(query.get('limit') || 500) || 500
        const { pullEvents } = await import('./sync.js')
        return json(res, 200, { ok: true, ...pullEvents(vaultRoot, since, limit) })
      }
      case '/sync/digest': {
        const { digestOf } = await import('./sync.js')
        return json(res, 200, { ok: true, ...digestOf(vaultRoot) })
      }
      case '/sync/reconcile': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const dev = String(req.headers['x-device-id'] || query.get('device') || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64)
        const { reconcileContentDuplicates } = await import('./sync.js')
        // 云端租户实例：对账事件必须发布（server_seq），否则其他设备 pull 不到
        const publish = !!(pathScope && pathScope.mode === 'cloud')
        return json(res, 200, reconcileContentDuplicates(vaultRoot, dev, { publish }))
      }
      case '/sync/snapshot': {
        const since = String(query.get('since') || '')
        const limit = Number(query.get('limit') || 200) || 200
        const { snapshotOf } = await import('./sync.js')
        return json(res, 200, { ok: true, ...snapshotOf(vaultRoot, since, limit) })
      }
      case '/sync/hello': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const dev = String(req.headers['x-device-id'] || (body && body.device) || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64)
        const { recordDeviceHello } = await import('./sync.js')
        return json(res, 200, recordDeviceHello(vaultRoot, { device: dev, cursor: body && body.cursor, digest: body && body.digest, pending: body && body.pending }))
      }
      case '/sync/tasks': {
        const { listSyncTasks } = await import('./sync.js')
        return json(res, 200, listSyncTasks(vaultRoot, { state: String(query.get("state") || "") }))
      }
      case '/sync/task/done': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const { completeSyncTask } = await import('./sync.js')
        return json(res, 200, completeSyncTask(vaultRoot, body && body.id, { ok: !(body && body.ok === false), error: (body && body.error) || '' }))
      }
      case '/sync/gc': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const { compactEvents } = await import('./sync.js')
        return json(res, 200, compactEvents(vaultRoot, { keepDays: body && body.keepDays, maxPerRun: body && body.maxPerRun }))
      }
      case '/sync/status': {
        const dev = String(req.headers['x-device-id'] || query.get('device') || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64)
        const { syncStatusOf } = await import('./sync.js')
        return json(res, 200, { ok: true, ...syncStatusOf(vaultRoot, dev) })
      }

      case '/search': {
        const q = query.get('q') || ''
        if (!q.trim()) return json(res, 200, { ok: true, hits: [] })
        const all = query.get('all') === '1'
        const semantic = query.get('semantic') === '1'
        // includeArchived=1：把归档卡也翻出来（默认不包含 —— 归档的意义就是不出现在日常检索里）
        const includeArchived = query.get('includeArchived') === '1' || query.get('archived') === '1'
        const limit = Math.min(Number(query.get('limit')) || 30, 200)
        let hits
        try {
          hits = all
            ? await searchAll(vaultRoots(), q, { limit, semantic, includeArchived })
            : await search(vaultRoot, q, { limit, semantic, includeArchived })
        } catch (e) { hits = await search(vaultRoot, q, { limit, semantic, includeArchived }) }
        json(res, 200, { ok: true, hits, includeArchived })
        return
      }
      case '/version-check': {
        // 版本跟踪：运行中（服务本页的进程） vs 磁盘安装 vs npm 最新。
        // 典型场景：磁盘已更新，但端口上的常驻进程仍加载旧版 → UI 显示旧版本号、新接口 404。
        const loaded = (getDshInfo() || {}).version || process.env.MEMORY_ETERNAL_VERSION || ''
        let onDisk = ''
        try {
          const pj = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
          onDisk = String(pj.version || '')
        } catch { onDisk = '' }
        let latest = ''
        let checkError = ''
        const force = query.get('force') === '1'
        try {
          if (force || !versionCache.at || Date.now() - versionCache.at > 10 * 60 * 1000) {
            const ctl = new AbortController()
            const timer = setTimeout(() => ctl.abort(), 4000)
            const resp = await fetch('https://registry.npmjs.org/memory-eternal', { signal: ctl.signal })
            clearTimeout(timer)
            const data = await resp.json()
            latest = String((data && data['dist-tags'] && data['dist-tags'].latest) || '')
            versionCache.at = Date.now()
            versionCache.latest = latest
          } else {
            latest = versionCache.latest
          }
        } catch (e) { checkError = String((e && e.message) || e).slice(0, 120) }
        // 常驻实例（端口上那个进程）自报的版本：宿主面板靠它区分「是本页这个进程旧」还是
        // 「常驻 web 旧」——两者要做的操作不同（重启 DSH vs 重启常驻实例）。独立 web 页里
        // 探到的就是它自己。
        const cfgVc = getSettings() ?? {}
        const residentPort = Number(query.get('port')) || selfPort() || Number(cfgVc.webPort) || Number(process.env.MEMORY_WEB_PORT) || 7999
        // issue #45（严重）：**绝不能向自己发这条请求**。selfPort() 就是本进程自己的端口，
        // 而 probeServedVersion 打的就是 /version-check —— 于是处理器 → 自己 → 处理器 → ……
        // 深度只受超时约束，每层再开一条连接：listen backlog 被打满 → 间歇 ECONNREFUSED（17–37ms）、
        // TIME_WAIT 静置也在涨、served 反而成了空串；0.10.36 的「重试 3 次」把它又乘以 3。
        const probedSelf = Number(residentPort) === Number(selfPort())
        let residentServed = ''
        if (probedSelf) residentServed = String(loaded || '')
        else { try { residentServed = String((await probeResidentVersion(residentPort)) || '') } catch { residentServed = '' } }
        // 「在服务」≠「被托管」：web 可能是宿主 ensureWeb() 直接拉起的、或看门狗被 stop/kill 后残留的孤儿
        // —— 此时锁里没有活着的看门狗，端口上的实例没人保活、也不会随版本升级被替换。
        // #28 的现场就是这一种：host 与端口版本号一致 → 面板认为「无需重启」，而其实该重启（重新托管）。
        let residentManaged = false
        try {
          residentManaged = readLock(process.env).watchdogs
            .some((w) => Number(w.port) === Number(residentPort) && isPidAlive(w.pid))
        } catch { residentManaged = false }
        // 「托管状态」其实有三态（#33 第③层）：确实被托管 / 确实没被托管 / **判不出来**（锁文件写不进去）。
        // 受限环境（沙箱禁写、ACL、非系统盘）里锁写不成 → 老实现一律显示「未托管 / 未运行」，
        // 用户会以为实例坏了、反复重启。这里把「判不出来」单独标出来，并解释原因。
        const lockInfo = probeLockWritable(process.env)
        const managedKnown = residentManaged || lockInfo.writable
        // 「宿主托管」（issue #30 ④）：锁不可写的机器上，宿主自己停旧实例、起新实例并保活 ——
        // 锁里当然没有登记，但不等于「未托管 / 孤儿」。
        let hostManaged = null
        try { const st = await import('./resident-state.js'); hostManaged = st.hostManagedInfo(process.env) } catch { hostManaged = null }
        const managedBy = residentManaged ? 'watchdog' : ((hostManaged && hostManaged.fresh) ? 'host' : '')
        // 「不可替换（环境限制）」的长期状态（issue #30 第五轮复测）：面板据此显示成**环境限制**，
        // 而不是每次开机都当成「漂移 → 替换失败」。
        let replaceBlocked = null
        try { const st = await import('./resident-state.js'); replaceBlocked = st.replaceBlockedInfo(process.env) } catch { replaceBlocked = null }
        json(res, 200, {
          ok: true,
          loaded,
          onDisk,
          latest,
          checkError,
          resident: {
            port: residentPort,
            served: residentServed,
            managed: residentManaged,
            managedKnown,
            managedBy,
            probedSelf: probedSelf === true,
            hostManaged,
            pid: process.pid,
            lock: lockInfo,
            replaceBlocked,
          },
          stale: !!(loaded && onDisk && loaded !== onDisk),
          // 只在 **npm 上确实更新** 时提示升级：本地跑着未发布版本（磁盘 0.10.7 / npm 0.10.6）时
          // 旧的 `latest !== onDisk` 会反过来劝用户装回旧版。
          updateAvailable: !!(latest && onDisk && compareVersions(latest, onDisk) > 0),
          updateCommand: 'dsh plugin --profile <你的 profile> add memory-eternal@latest',
          // 「重启常驻实例」的能力与命令（面板据此给一键按钮 / 手动指引）
          canRestartResident: true,
          restartCommand: `dsh-memory restart --port ${residentPort}`,
        })
        return
      }
      case '/restart-self': {
        // 「运行中还是旧版本」的一键修复：用新代码重启**常驻实例**（端口上那个进程）。
        // 三条硬约束：
        //   ① 本进程很可能就是要被替换的旧 web → 先回响应，再调度替换（助手负责收旧实例）；
        //   ② 常驻实例已经是最新版就别白折腾（宿主面板点这个按钮时最常见）——如实回 alreadyCurrent；
        //   ③ 同一时刻只允许一个替换在跑。
        if (req.method && req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        const cfgR = getSettings() ?? {}
        const port = Number(query.get('port')) || selfPort() || Number(cfgR.webPort) || Number(process.env.MEMORY_WEB_PORT) || 7999
        const expect = pkgVersion()
        // 「本进程正在跑的版本」。/version-check 里那个同名变量作用域在它自己的 case 块内，
        // 这里必须自己取一次 —— 之前直接引用它，导致这条路由 100% 抛 ReferenceError（loaded is not defined），
        // 「重启常驻实例」按钮点了只会得到 500。
        const selfVersion = (getDshInfo() || {}).version || process.env.MEMORY_ETERNAL_VERSION || ''
        // 与 /version-check 同一条闸门（#45）：问自己等于开一条递归链 —— 本进程就是那个常驻实例，
        // 直接用自己的版本作答。
        const served = Number(port) === Number(selfPort())
          ? String(selfVersion || expect || '')
          : await probeResidentVersion(port).catch(() => '')
        // 「版本一致」还不够：还要**有活着的看门狗托管它**。孤儿 web（看门狗被 stop / 被 kill -9 后残留）
        // 版本号可能正好也是新的，但没人保活、也不会被后续升级替换 —— 那时一键重启才是唯一出路（#28）。
        const managed = (() => {
          try { return readLock(process.env).watchdogs.some((w) => Number(w.port) === Number(port) && isPidAlive(w.pid)) } catch { return false }
        })()
        if (served && expect && String(served) === String(expect) && managed) {
          return json(res, 200, {
            ok: true, alreadyCurrent: true, port, served: String(served), expect, managed,
            note: `常驻实例（端口 ${port}）已经在服务 v${served} 且有看门狗保活，无需重启。若「运行中」仍显示旧版本号，说明那一行来自另一个进程（例如 DSH 宿主），需重启桌面版 / DSH。`,
          })
        }
        if (residentRestarting) {
          return json(res, 200, { ok: true, alreadyRunning: true, port, expect, note: `端口 ${port} 的替换已在进行中，请稍候刷新页面。` })
        }
        residentRestarting = true
        json(res, 200, {
          ok: true, scheduled: true, port, served: String(served || ''), expect,
          note: `已调度重启常驻实例（端口 ${port} → v${expect || '?'}）：约 3-8 秒后新进程接管，请稍等再刷新页面（Ctrl+F5）。`,
        })
        setTimeout(() => {
          Promise.resolve()
            .then(() => doRestartResident({
              port, vaultRoot, interval: Number(cfgR.webCheckIntervalMs) || 5000, maxRestart: Number(cfgR.webMaxRestart) || 10,
            }))
            .then(async (out) => {
              // 本进程若正是被替换的旧 web，这里根本不会执行 —— 助手会把结论写进 capture 日志
              try {
                const { appendCaptureLog } = await import('./capture-log.js')
                await appendCaptureLog({
                  // 同上：服务管理失败用 warn（别翻红沉淀健康状态、别冒充「自动沉淀异常」）
                  time: Date.now(), sessionId: 'system', action: out && out.ok ? 'boot' : 'warn',
                  reason: out && out.ok
                    ? `面板一键重启常驻实例成功：端口 ${port} 正在服务 v${out.served}`
                    : `面板一键重启常驻实例未确认生效：${(out && out.error) || '未知原因'}`,
                }, process.env)
              } catch { /* 日志失败不影响替换 */ }
            })
            .catch(() => {})
            .finally(() => { residentRestarting = false })
        }, 300)
        return
      }
      case '/open-external': {
        if (req.method && req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        // 来源 + 频率闸门：防恶意页面用 <form> 循环提交把浏览器刷爆
        const gExt = guardOpenerCall(req, 'external')
        if (!gExt.ok) return json(res, 429, gExt)
        return json(res, 200, openExternalUrl(query.get('url')))
      }
      case '/open-web': {
        // 左侧栏「Web 版」：用系统默认浏览器打开本机独立 Web UI。
        // 只允许 127.0.0.1/localhost/::1，避免这个无鉴权端点变成任意 URL 打开器。
        if (req.method && req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        // 来源 + 频率闸门：防恶意页面用 <form> 循环提交把浏览器刷爆
        const gWeb = guardOpenerCall(req, 'web')
        if (!gWeb.ok) return json(res, 429, gWeb)
        return json(res, 200, openLocalWeb(query.get('url')))
      }
      case '/web-info': {
        // 供前端/诊断查「浏览器版」地址（不打开浏览器）。旧版宿主没有这条路由 → 前端会回退。
        return json(res, 200, { ok: true, url: residentWebUrl(query.get('port')), version: currentPkgVersion() })
      }
      case '/diagnostics': {
        // 「反馈异常」用：返回一段可直接贴进 issue 的**已脱敏**诊断文本。
        // 宿主与独立 web 共用这个实现；home 目录、各类 key/token 全都会被替换掉。
        const cfgD = getSettings() ?? {}
        const dshD = getDshInfo() ?? null
        const envD = typeof process !== 'undefined' ? process.env : {}
        let countsD = null
        try { countsD = await overview(vaultRoot) } catch { countsD = null }
        let healthD = null
        try { healthD = getCaptureHealth() } catch { healthD = null }
        let logD = []
        try {
          const raw = getCaptureLog()
          logD = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : [])
        } catch { logD = [] }
        const homeD = (() => { try { return os.homedir() } catch { return '' } })()
        // 待应用配置的失败状态（#16）：独立 Web 端保存 → pending 文件 → 宿主 drain 的路，
        // 出了问题以前完全无迹可查，现在进诊断（「反馈异常」一键带出）。
        let syncD = null
        try { const { readPendingConfig } = await import('./config-sync.js'); syncD = readPendingConfig(process.env) } catch { syncD = null }
        const text = buildDiagnostics({
          configSync: syncD,
          version: (dshD && dshD.version) || envD.MEMORY_ETERNAL_VERSION || '',
          dshVersion: (dshD && dshD.version) || '',
          host: dshD ? 'deepseek-harness' : 'standalone web',
          os: process.platform + ' ' + process.arch + ' / node ' + process.version,
          vaultDir: vaultRoot,
          vaultSource: dshD && dshD.vaultSource,
          workspace: dshD && dshD.workspace,
          memoryRecallTool: dshD ? !!dshD.memoryRecallTool : undefined,
          cards: countsD ? countsD.total : undefined,
          health: healthD,
          captureLog: logD,
          maxTokens: undefined,
        }, homeD)
        json(res, 200, { ok: true, diagnostics: text, repo: 'EternalNight996/memory-eternal', version: (dshD && dshD.version) || envD.MEMORY_ETERNAL_VERSION || '' })
        return
      }
      case '/graph/level': {
        // 星球分层视图：一次只返回「一层」（根层 kind 折叠 / 卡片层 / 语义簇层）。
        // 10k 规模下客户端绝不再拉全量图 —— 每层图元 ≤1000、payload ≤1MB（见 lib/vault.js 守卫）。
        await ensureVault(vaultRoot)
        const pathStr = query.get('path') || ''
        const allRoots = query.get('all') === '1'
        try {
          const out = await graphLevel(vaultRoot, {
            path: pathStr,
            roots: allRoots ? vaultRoots() : null,
          })
          return json(res, 200, out)
        } catch (e) {
          // 分类失败：路径写错/语义簇过期是「客户端可纠正」的 400；其他未知异常一律 500，
          // 内部细节只进服务端日志（不把 SQL/堆栈原文抛给浏览器）。
          const { status, body } = levelErrorResponse(e, 'path=' + pathStr)
          return json(res, status, body)
        }
      }
      case '/graph': {
        await ensureVault(vaultRoot)
        const all = query.get('all') === '1'
        // limit：只回「度数最高的 N 张」子图（默认 0 = 全量）。大库下全量 JSON 会到几 MB。
        const limit = Number(query.get('limit') || 0)
        let g
        try { g = all ? await graphAll(vaultRoots()) : await graph(vaultRoot) }
        catch (e) { g = await graph(vaultRoot) }
        const out = limit > 0 ? topDegreeSubgraph(g.nodes, g.edges, limit) : { ...g, total: (g.nodes || []).length, shown: (g.nodes || []).length }
        json(res, 200, { ok: true, ...out })
        return
      }
      case '/capture-log': {
        // 最近 100 条自动沉淀运行轨迹（监听 → 判定 → 写入/跳过原因）+ 健康状态。
        // 宿主侧是内存缓冲（同步），独立 Web 侧是从 JSONL 读文件（异步）→ 统一 await。
        const log = await getCaptureLog()
        if (!log) return json(res, 200, { ok: true, available: false, entries: [], health: null })
        json(res, 200, { ok: true, available: true, health: await getCaptureHealth(), entries: log.slice(0, 100) })
        return
      }
      case '/skills/sync': {
        // POST：把「实际技能」同步成待审技能卡（kind=skill）。
        // 不是 agent 沉淀：宿主走 ctx.skills 注册表，独立 web 走文件系统兜底；
        // 生成的卡一律 pending（enforceAudit 对 skill 强制待审），由人在审核中心确认。
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
        const out = await syncSkills({ force: query.get('force') === '1' })
        json(res, out && out.ok ? 200 : 500, out || { ok: false, error: '同步失败' })
        return
      }
      case '/news': {
        // 动态 / 新闻：用户自定义内容，独立于记忆卡（不参与召回/审核/星图）。
        const data = await listNews(vaultRoot, {
          q: query.get('q') || '',
          category: query.get('category') || '',
          unreadOnly: query.get('unread') === '1',
          limit: Math.min(Math.max(Number(query.get('limit')) || 500, 1), 500),
        })
        json(res, 200, { ok: true, ...data })
        return
      }
      case '/news/feed': {
        // 真实 AI 资讯：服务端按固定白名单抓 RSS / HN，缓存 20 分钟；只存摘要与外链。
        // 带 follows=1 时主 feed 允许降级：9 个 RSS 全挂也不该把用户的 GitHub/arXiv 订阅一起吞掉。
        const wantFollows = query.get('follows') === '1'
        try {
          let data
          try {
            data = await getNewsFeed(vaultRoot, {
              period: query.get('period') === 'month' ? 'month' : 'today',
              type: query.get('type') || '',
              q: query.get('q') || '',
              // lang 口径：'' / 'all' = 不过滤（一次请求拿中英全部条目）；zh / en 为显式过滤。
              lang: (() => {
                const raw = String(query.get('lang') == null ? '' : query.get('lang')).trim().toLowerCase()
                if (raw === 'en') return 'en'
                if (raw === 'zh') return 'zh'
                return ''
              })(),
              force: query.get('force') === '1',
            })
          } catch (e) {
            if (!wantFollows) throw e
            // 降级：主 feed 拉不到就返回空集合 + 可读错误，但继续给关注结果。
            data = {
              ok: true, period: 'today', lang: '', ranking: false, degraded: true,
              items: [], types: [], counts: {}, fetchedAt: 0, stale: true,
              errors: ['主 feed 暂不可用：' + String((e && e.message) || e)], sources: [],
            }
          }
          // follows=1：把「关注」命中的条目并进主 feed（同一套 item 形状，前端零改动）。
          // 关注抓取有 30 分钟 TTL，所以这里不会每次都打外网。
          if (wantFollows) {
            const follows = await refreshFollows(vaultRoot)
            const extra = await followItems(vaultRoot, follows)
            const seen = new Set((data.items || []).map((x) => x.url))
            data = {
              ...data,
              items: [...extra.filter((x) => x.url && !seen.has(x.url)), ...(data.items || [])].slice(0, 160),
              follows: follows.map((f) => ({
                id: f.id, label: f.label, query: f.query, domains: f.domains,
                count: (f.cache && f.cache.items ? f.cache.items : []).length,
                errors: (f.cache && f.cache.errors) || [],
                fetchedAt: (f.cache && f.cache.fetchedAt) || 0,
              })),
            }
          }
          json(res, 200, data)
        } catch (e) {
          json(res, 502, { ok: false, error: '资讯源暂不可用：' + String((e && e.message) || e) })
        }
        return
      }
      case '/news/follows': {
        // GET 列表；POST 创建；DELETE 删除。创建只接受「已解析好的」结构化入参，
        // 域必须来自白名单枚举（parseFollowIntent 也只产出枚举内的值）。
        if (req.method === 'DELETE') {
          const id = String(query.get('id') || '').trim()
          if (!id) return json(res, 400, { ok: false, error: '缺少 id' })
          const out = await removeFollow(vaultRoot, id)
          return json(res, 200, { ok: true, ...out })
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          try {
            const out = await saveFollow(vaultRoot, {
              query: body.query, domains: body.domains, label: body.label, sourceIds: body.sourceIds,
            })
            return json(res, 200, { ok: true, ...out, domainsEnum: FOLLOW_DOMAINS })
          } catch (e) {
            return json(res, 400, { ok: false, error: String((e && e.message) || e) })
          }
        }
        const follows = await listFollows(vaultRoot)
        return json(res, 200, {
          ok: true,
          domains: FOLLOW_DOMAINS,
          follows: follows.map((f) => ({
            id: f.id, label: f.label, query: f.query, domains: f.domains, createdAt: f.createdAt, lastRunAt: f.lastRunAt,
            count: (f.cache && f.cache.items ? f.cache.items : []).length,
            errors: (f.cache && f.cache.errors) || [],
          })),
        })
      }
      case '/news/follows/preview': {
        // 只解析、不落库：用户先看到「我理解成了什么」，再决定要不要订阅。
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
        const body = await readBody(req)
        return json(res, 200, { ok: true, parsed: parseFollowIntent(body.text || ''), domainsEnum: FOLLOW_DOMAINS })
      }
      case '/news/follows/refresh': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
        const body = await readBody(req)
        const follows = await refreshFollows(vaultRoot, { force: body && body.force === true })
        return json(res, 200, {
          ok: true,
          follows: follows.map((f) => ({
            id: f.id, label: f.label, query: f.query, domains: f.domains,
            count: (f.cache && f.cache.items ? f.cache.items : []).length,
            errors: (f.cache && f.cache.errors) || [],
          })),
        })
      }
      case '/news/digest': {
        // GET：读当前快照；POST：现在生成一份（配置页「立即生成」按钮用，也是开启前的预览）。
        if (req.method === 'POST') {
          const body = await readBody(req)
          const cfg = (getSettings && getSettings()) || {}
          const intervalMin = Math.max(30, Number(cfg.newsDigestIntervalMinutes) || 720)
          try {
            const digest = await buildDigest(vaultRoot, {
              windowHours: Number(body.windowHours) || Math.max(1, Math.round(intervalMin / 60)),
              maxItems: Number(body.maxItems) || Number(cfg.newsDigestMaxItems) || 5,
              force: body.force === true,
            })
            return json(res, 200, { ok: true, digest, text: digestPrompt(digest, { maxItems: Number(cfg.newsDigestMaxItems) || 5 }) })
          } catch (e) {
            return json(res, 502, { ok: false, error: '生成摘要失败：' + String((e && e.message) || e) })
          }
        }
        const digest = await readDigest(vaultRoot)
        const cfgGet = (getSettings && getSettings()) || {}
        return json(res, 200, { ok: true, digest, text: digest ? digestPrompt(digest, { maxItems: Number(cfgGet.newsDigestMaxItems) || 5 }) : '' })
      }
      case '/news/feed/refresh': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
        try {
          const data = await refreshNewsFeed(vaultRoot, { force: true })
          json(res, 200, { ok: true, fetchedAt: data.fetchedAt, total: (data.items || []).length, errors: data.errors || [] })
        } catch (e) {
          json(res, 502, { ok: false, error: '资讯源暂不可用：' + String((e && e.message) || e) })
        }
        return
      }
      case '/news/item': {
        const item = await getNews(vaultRoot, query.get('id') || '')
        if (!item) return json(res, 404, { ok: false, error: '新闻不存在' })
        json(res, 200, { ok: true, item })
        return
      }
      case '/news/save': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
        const body = await readBody(req)
        const out = await saveNews(vaultRoot, body || {})
        json(res, out.ok ? 200 : 400, out)
        return
      }
      case '/news/read': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
        const body = await readBody(req)
        const out = await setNewsRead(vaultRoot, body?.id || '', body?.read !== false)
        json(res, out.ok ? 200 : 400, out)
        return
      }
      case '/news/delete': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
        const body = await readBody(req)
        const out = await deleteNews(vaultRoot, body?.id || '')
        json(res, out.ok ? 200 : 400, out)
        return
      }
      // 流式导出（NDJSON）：一行一张卡，边查边写。
      //
      // 为什么需要：`/export` 会把全部卡片组装成一个对象再 JSON.stringify ——
      // 几万张卡（几十 MB）会同时占住「查询结果 + 序列化字符串 + 响应体」三份内存，
      // 大库上容易直接 OOM 或超时。NDJSON 是「读一行、写一行、丢掉」，内存恒定。
      //
      // 用法：GET /export/ndjson?status=approved&since=2026-01-01
      //   首行是信封 {format, exportedAt, count?}，之后每行一张卡；客户端按行 split 即可。
      case '/export/ndjson': {
        await ensureVault(vaultRoot)
        const wantStatus = String(query.get('status') || 'all')
        const since = String(query.get('since') || '').trim()
        const db = getDb(vaultRoot)

        let sql = 'SELECT id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at, content_hash FROM cards'
        const args = []
        const where = []
        if (wantStatus === 'approved') where.push("status = 'approved'")
        else if (wantStatus === 'pending' || wantStatus === 'rejected' || wantStatus === 'deleted') {
          // 隔离区状态：从 quarantine 取（主库只有 approved）
          sql = 'SELECT id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at, content_hash FROM quarantine'
          where.push('status = ?')
          args.push(wantStatus)
        }
        if (since) { where.push('updated_at >= ?'); args.push(since) }
        if (where.length) sql += ' WHERE ' + where.join(' AND ')
        sql += ' ORDER BY id'

        let rows = []
        try { rows = db.prepare(sql).all(...args) } catch { rows = [] }

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="memory-eternal-${Date.now()}.ndjson"`,
        })
        // 信封行：客户端据此判断格式与条数，不必先读完整流
        res.write(JSON.stringify({ format: 'memory-eternal-ndjson', formatVersion: 1, exportedAt: new Date().toISOString(), count: rows.length, status: wantStatus, since: since || null }) + '\n')
        // 逐行写：一行一卡，写完即丢，内存恒定
        for (const r of rows) {
          res.write(JSON.stringify(r) + '\n')
        }
        res.end()
        return
      }
      case '/export': {
        await ensureVault(vaultRoot)
        // 几万条请用 /export/ndjson（流式，内存恒定）；这里保持单文件备份形状不变。
        const cards = await exportCards(vaultRoot)
        // 带上信封元信息：客户端可以直接把整个响应体当备份文件落下（见 /import 的兼容读取）。
        json(res, 200, { ok: true, format: 'memory-eternal-vault', formatVersion: 1, exportedAt: new Date().toISOString(), count: cards.length, cards, hint: cards.length > 5000 ? '卡片较多，建议改用 /export/ndjson 流式导出' : undefined })
        return
      }
      case '/delete': {
        const rel = query.get('path') || ''
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        // 软删（进回收站）；?permanent=1 直接永久删除
        const permanent = query.get('permanent') === '1'
        await deleteCard(vaultRoot, rel, { permanent })
        json(res, 200, { ok: true, soft: !permanent })
        return
      }
      case '/reclassify': {
        // 重新识别待审原文卡的类型：修复旧版本「自动沉淀全是 content」的历史数据。
        // 只处理带 raw / 原文卡标记的待审卡，不动人工创建的内容。
        const dryRun = query.get('dry') === '1'
        const { getDb } = await import('./db.js')
        const db = getDb(vaultRoot)
        const rows = db.prepare("SELECT id, path, title, body, tags, reason FROM quarantine WHERE status = 'pending'").all()
        let scanned = 0, changed = 0
        const byKind = {}
        for (const row of rows) {
          let tags = []
          try { tags = JSON.parse(row.tags || '[]') } catch { tags = [] }
          const isRaw = (Array.isArray(tags) && tags.includes('raw')) || /原文卡|自动沉淀/.test(String(row.reason || ''))
          if (!isRaw) continue
          scanned++
          const kind = guessRawKind({ title: row.title, body: row.body })
          if (kind === 'content') continue
          changed++
          byKind[kind] = (byKind[kind] || 0) + 1
          if (!dryRun) db.prepare('UPDATE quarantine SET kind = ?, updated_at = ? WHERE id = ?').run(kind, new Date().toISOString(), row.id)
        }
        json(res, 200, { ok: true, dryRun, scanned, changed, byKind })
        return
      }
      case '/audit/redistill': {
        // 对一个「降级原文卡」重新跑蒸馏（仍留在待审，不自动审批）。
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        const rel = String(body.path || query.get('path') || '').trim()
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        const { getDb } = await import('./db.js')
        const db = getDb(vaultRoot)
        const row = db.prepare("SELECT * FROM quarantine WHERE path = ? AND status = 'pending'").get(rel)
        if (!row) return json(res, 400, { ok: false, error: '待审卡不存在（可能已审批、驳回或删除）' })
        let tags = []
        try { tags = JSON.parse(row.tags || '[]') } catch { tags = [] }
        const isRaw = (Array.isArray(tags) && (tags.includes('raw') || tags.includes('distill-failed'))) || /原文卡|蒸馏无输出/.test(String(row.reason || ''))
        if (!isRaw) return json(res, 400, { ok: false, error: '这不是降级原文卡，无需重新蒸馏' })

        const cap = await import('./capture.js')
        const routeLlm = getLlm() || (await import('./llm-openai.js')).createLlmFromEnv(process.env)
        if (!routeLlm) return json(res, 400, { ok: false, error: '未配置蒸馏模型：在设置里选 captureProvider/captureModel，或设置 MEMORY_LLM_*' })
        const cfg = getSettings() ?? {}
        let route = null
        try {
          const routes = await cap.routeCandidates(routeLlm, { provider: cfg.captureProvider, model: cfg.captureModel })
          route = routes[0] || null
        } catch { route = null }
        if (!route) return json(res, 400, { ok: false, error: '没有可用的蒸馏路由' })

        try {
          const neighbors = await cap.pickNeighbors(vaultRoot, { title: row.title, body: String(row.body).slice(0, 400) }, 8)
          const detailed = await cap.summarizeTurnDetailed(routeLlm, route, String(row.body || ''), { existing: neighbors, signal: AbortSignal.timeout(60000) })
          const result = detailed.card
          // issue #64：append_to 的结果是 {append_to, update}，没有 save 字段 ——
          // 必须先判 append_to，否则永远先命中 422「模型未产出可保存的知识卡」，
          // 后面的 append_to 分支是不可达代码，排查方向也会被误导。
          if (result && result.append_to) {
            // 真的执行合并，而不是只告诉用户"应该合并"。
            // 以前这里直接 return 一条提示，用户还得手动去改目标卡 —— 等于没修。
            const targetRaw = String(result.append_to).trim()
            const update = String(result.update || '').trim()
            const targetAbs = path.resolve(vaultRoot, targetRaw)
            const inVault = targetAbs.startsWith(path.resolve(vaultRoot) + path.sep)
            if (!inVault) {
              return json(res, 400, { ok: false, error: 'append_to 指向库外路径，已拒绝', appendTo: targetRaw })
            }
            if (targetAbs === path.resolve(vaultRoot, rel)) {
              // 指向自己 = 就地更新
              if (!update) return json(res, 422, { ok: false, error: 'append_to 指向本卡但 update 为空' })
              const nextBody = String(row.body || '').trimEnd() + '\n\n' + update + '\n'
              db.prepare('UPDATE quarantine SET body = ?, summary = ?, updated_at = ? WHERE id = ?')
                .run(nextBody, update.slice(0, 200), new Date().toISOString(), row.id)
              db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)')
                .run(rel, 'pending', 'pending', 'redistill', '就地更新（append_to 指向本卡）')
              return json(res, 200, { ok: true, path: rel, mergedInto: rel, mode: 'in-place' })
            }
            if (!fs.existsSync(targetAbs)) {
              // 目标不存在 → 降级：把 update 存成本卡正文，让用户还能用
              const note = '（append_to 目标不存在：' + targetRaw + '，已就地保留）'
              const nextBody = String(row.body || '').trimEnd() + '\n\n' + (update || '') + '\n\n' + note + '\n'
              const nextTags = JSON.stringify([...new Set([...tags, 'append-target-missing'])])
              db.prepare('UPDATE quarantine SET body = ?, tags = ?, summary = ?, updated_at = ? WHERE id = ?')
                .run(nextBody, nextTags, (update || '').slice(0, 200), new Date().toISOString(), row.id)
              return json(res, 200, { ok: true, path: rel, mode: 'target-missing', appendTo: targetRaw, note })
            }
            // 正常合并：把 update 追加到目标卡正文末尾
            try {
              const src = fs.readFileSync(targetAbs, 'utf8')
              const marker = '\n## 追加（' + new Date().toISOString().slice(0, 10) + '）\n'
              fs.writeFileSync(targetAbs, src.trimEnd() + '\n' + marker + (update || '(无内容)') + '\n', 'utf8')
              // 本卡标记为已合并（仍留待审，由用户决定删除）
              const nextTags = JSON.stringify([...new Set([...tags, 'merged'])])
              db.prepare('UPDATE quarantine SET tags = ?, reason = ?, updated_at = ? WHERE id = ?')
                .run(nextTags, '已合并到：' + targetRaw, new Date().toISOString(), row.id)
              db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)')
                .run(rel, 'pending', 'pending', 'redistill', '合并到 ' + targetRaw)
              return json(res, 200, { ok: true, path: rel, mergedInto: targetRaw, mode: 'merged' })
            } catch (e) {
              return json(res, 500, { ok: false, error: '写入目标卡失败：' + String((e && e.message) || e), appendTo: targetRaw })
            }
          }
          if (!result || result.save !== true) {
            return json(res, 422, { ok: false, error: '模型未产出可保存的知识卡', failure: detailed.failure || null })
          }
          const allowed = ['project', 'knowledge', 'mistake', 'tool', 'business', 'content', 'prompt']
          const kind = allowed.includes(result.kind) ? result.kind : cap.guessRawKind({ title: result.title, body: result.body })
          const nextTags = Array.isArray(result.tags) ? result.tags : []
          const now = new Date().toISOString()
          db.prepare('UPDATE quarantine SET kind = ?, title = ?, tags = ?, body = ?, summary = ?, reason = ?, updated_at = ? WHERE id = ?')
            .run(kind, String(result.title || row.title), JSON.stringify(nextTags), String(result.body || '').trim(), String(result.body || '').trim().slice(0, 200), 'AI 重新蒸馏（原降级卡）', now, row.id)
          db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)')
            .run(rel, 'pending', 'pending', 'redistill', '重新蒸馏成功（' + route.provider + '/' + route.model + '）')
          return json(res, 200, { ok: true, path: rel, kind, title: String(result.title || row.title) })
        } catch (e) {
          return json(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
      }
      case '/audit/list': {
        const { pending, rejected } = await auditQueue(vaultRoot)
        json(res, 200, { ok: true, pending, rejected })
        return
      }
      case '/audit/approve': {
        // POST {path, kind?} 或 GET ?path=&kind= → status=approved；kind=core 时同时设为核心
        const body = query.get('path') ? null : await readBody(req)
        const rel = query.get('path') || body?.path || ''
        const kind = String(query.get('kind') || body?.kind || '').trim()
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        const out = await setCardStatus(vaultRoot, rel, 'approved')
        // 修改副本被批准时会覆盖原卡（out.applied），它本身已消失，不能再当独立卡设类型
        if ((kind === 'core' || kind === 'knowledge') && !out.applied) await setCardKind(vaultRoot, rel, kind)
        json(res, 200, { ok: true, path: out.path || rel, status: 'approved', kind: kind || undefined, applied: !!out.applied })
        return
      }
      case '/audit/reject': {
        // POST {path, reason?} 或 GET ?path=&reason= → status=rejected（标记驳回，不删除）
        // issue #50：驳回理由复用 --reason 语义 —— 传了就经 setCardStatus 写进 audit_log，
        // 缺省仍是空串。审核是人的动作，所以 changed_by 记 'user'（原来是缺省的 'system'）。
        const body = await readBody(req)
        const rel = query.get('path') || body.path || ''
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        const reason = String(query.get('reason') || body.reason || '').trim().slice(0, 300)
        await setCardStatus(vaultRoot, rel, 'rejected', { changedBy: 'user', reason })
        json(res, 200, { ok: true, path: rel, status: 'rejected', reason })
        return
      }
      case '/card/revise': {
        // POST {path, title?, tags?, body?, reason?, source?}：agent 提交「审核制修改」——
        // 生成一张待审副本（同 kind、指向原卡），**不动原卡**；只有 /audit/approve 才会覆盖。
        // 这是给智能体用的唯一改卡入口：它不能直接改已入库内容，也不能自己批准。
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const rel = String(query.get('path') || body.path || '').trim()
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        const title = body.title === undefined ? undefined : String(body.title).trim()
        if (title !== undefined && !title) return json(res, 400, { ok: false, error: '标题不能为空' })
        const nextBody = body.body === undefined ? undefined : String(body.body)
        if (nextBody !== undefined && !nextBody.trim()) return json(res, 400, { ok: false, error: '正文不能为空' })
        if (nextBody !== undefined && nextBody.length > 200000) return json(res, 413, { ok: false, error: '正文过长（上限 200000 字符）' })
        const nextTags = Array.isArray(body.tags) ? body.tags.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 30) : undefined
        try {
          const out = await reviseCard(vaultRoot, {
            target: rel, title, tags: nextTags, body: nextBody,
            reason: String(body.reason || '').slice(0, 300),
            source: String(body.source || 'agent'),
            submittedBy: String(body.submittedBy || body.source || 'agent'),
          })
          broadcast('audit', { path: out.path })
          json(res, 200, { ok: true, ...out })
        } catch (e) {
          json(res, 400, { ok: false, error: String(e?.message || e) })
        }
        return
      }
      case '/card/update': {
        // POST {path, title, tags, body}：人工编辑卡片内容（标题 / 标签 / 正文）。
        // 只允许改这三样 —— 状态、类型、来源、审核流转仍由 /audit/*、/card-kind 决定，
        // 避免「手动编辑」成为绕过审核的旁路；本路由只在本机回环 + 同源闸门下可达（见 crossOriginError）。
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const rel = String(query.get('path') || body.path || '').trim()
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        const title = body.title === undefined ? undefined : String(body.title).trim()
        if (title !== undefined && !title) return json(res, 400, { ok: false, error: '标题不能为空' })
        const nextBody = body.body === undefined ? undefined : String(body.body)
        if (nextBody !== undefined && !nextBody.trim()) return json(res, 400, { ok: false, error: '正文不能为空' })
        if (nextBody !== undefined && nextBody.length > 200000) return json(res, 413, { ok: false, error: '正文过长（上限 200000 字符）' })
        const nextTags = Array.isArray(body.tags) ? body.tags.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 30) : undefined
        try {
          const out = await updateCardContent(vaultRoot, rel, { title, tags: nextTags, body: nextBody })
          broadcast('cards', { path: rel, reason: 'edited' })
          json(res, 200, { ok: true, path: out.path, store: out.store, updated: out.updated, title, tags: nextTags })
        } catch (e) {
          json(res, 400, { ok: false, error: String(e?.message || e) })
        }
        return
      }
      case '/card-kind': {
        // POST {path, kind:'core'|'knowledge'|...}：人工把已批准卡片设为核心/取消核心
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const rel = String(query.get('path') || body.path || '').trim()
        const kind = String(body.kind || '').trim()
        if (!rel || !kind) return json(res, 400, { ok: false, error: '缺少 path 或 kind' })
        try {
          const out = await setCardKind(vaultRoot, rel, kind)
          json(res, 200, { ok: true, ...out })
        } catch (e) {
          json(res, 400, { ok: false, error: String(e?.message || e) })
        }
        return
      }
      case '/recycle/list': {
        const items = await recycleList(vaultRoot)
        json(res, 200, { ok: true, items })
        return
      }
      case '/recycle/restore': {
        const rel = query.get('path') || ''
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        await restoreCard(vaultRoot, rel)
        json(res, 200, { ok: true, path: rel })
        return
      }
      case '/recycle/purge': {
        const rel = query.get('path') || ''
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        await deleteCard(vaultRoot, rel, { permanent: true })
        json(res, 200, { ok: true, path: rel, purged: true })
        return
      }
      case '/recycle/purge-expired': {
        // issue #57 根因：过去写的是 `Number(query.get('days')) || 30` —— `Number('0')` 是 0，
        // 而 `0 || 30` 又变回 30，于是前端「清空回收站」传的 days=0 被静默升级成 30 天保留期，
        // 刚删的卡一个都不清 → 用户看到的就是「点了没反应」。
        // 现在区分「没传」与「传了 0」：没传才用默认 30。
        let days
        try { days = parseRetentionDays(query.get('days')) } catch (e) { return json(res, 400, { ok: false, error: String(e.message) }) }
        const r = await purgeExpired(vaultRoot, days)
        json(res, 200, r)
        return
      }
      case '/recycle/purge-all': {
        // 永久清空回收站（deleted + rejected）。危险操作：只收 POST，且走 DB_WRITE_ROUTES 闸门。
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const r = await purgeAllRecycle(vaultRoot)
        broadcast('cards', { reason: 'recycle-purged', purged: r.purged })
        json(res, 200, r)
        return
      }
      /**
       * 动态改「库文件名」：POST { name, move? }
       * 语义：把当前库文件（含 -wal/-shm）改名成 name，然后重开连接；不需要重启、不需要改环境变量。
       */
      case '/db/rename': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const raw = await readRaw(req, res)
        if (raw === null) return
        let body = {}
        try { body = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        const name = String(body.name || '').trim()
        if (!name) return json(res, 400, { ok: false, error: '需要 name（例如 mem-purge.db）' })
        const r = renameDbFile(vaultRoot, name, { move: body.move !== false })
        if (!r.ok) return json(res, 400, r)
        // 记进配置（下次启动也用它）——写不进去不影响这次已经生效
        try {
          const cfg = getSettings() || {}
          if (String(cfg.dbFile || '') !== r.to) await persistConfigPatch({ dbFile: r.to })
        } catch { /* 忽略 */ }
        try { logActivity(vaultRoot, { ip: clientIpOf(req), agent: 'manual', action: 'db-rename', title: r.to, target: r.from + ' → ' + r.to }) } catch { /* 旁路 */ }
        try { broadcast('config', { at: Date.now(), source: 'db-rename' }) } catch { /* 忽略 */ }
        json(res, 200, { ...r, dbPath: path.join(vaultRoot, r.to) })
        return
      }

      /**
       * 动态改端口：POST { port }
       * 注意：改完当前页面的地址就变了，前端需要提示用户跳到新地址。
       */
      case '/web/port': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const raw = await readRaw(req, res)
        if (raw === null) return
        let body = {}
        try { body = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        const want = Number(body.port)
        if (!Number.isInteger(want) || want < 1 || want > 65535) return json(res, 400, { ok: false, error: '端口必须是 1–65535 的整数' })
        const r = deps.scheduleRelisten(want)
        if (!r || !r.ok) return json(res, 400, r || { ok: false, error: '改端口失败' })
        try { await persistConfigPatch({ webPort: r.port }) } catch { /* 忽略 */ }
        try { logActivity(vaultRoot, { ip: clientIpOf(req), agent: 'manual', action: 'port-change', title: String(r.port), target: (r.prev || '') + ' → ' + r.port }) } catch { /* 旁路 */ }
        try { broadcast('config', { at: Date.now(), source: 'port-change', port: r.port }) } catch { /* 忽略 */ }
        json(res, 200, { ...r, note: '当前页面地址已失效，请打开新地址' })
        return
      }

      case '/write': {
        // 体积上限走统一实现（H2）：以前这里是第四份自写的无上限 body 读取
        const raw = await readRaw(req, res)
        if (raw === null) return
        let body
        try { body = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        if (!body.body) return json(res, 400, { ok: false, error: '缺少正文' })
        await ensureVault(vaultRoot)
        const r = await writeCard(vaultRoot, { kind: body.kind || 'knowledge', title: body.title || '无标题', tags: body.tags || [], body: body.body, source: body.source || 'manual', status: 'pending', submittedBy: body.source || 'manual', severity: body.severity || 'info', reason: body.reason || '手动创建' }, { dedup: false })
        // 操作日志：手动写入也记。云端与 web 端共用这份实现，所以两边日志都覆盖。
        try {
          if (r && r.ok) logActivity(vaultRoot, { ip: clientIpOf(req), agent: String(body.source || 'manual'), action: 'write', title: String(body.title || '无标题'), target: r.path || '' })
        } catch { /* 旁路 */ }
        json(res, 200, r)
        return
      }
      case '/import': {
        // 体积上限走**统一实现**（H2）：16MB 一次（几万条请用 /import/chunk）
        let raw = ''
        try {
          raw = await readBodyText(req, { maxBytes: MAX_CHUNK_BYTES })
        } catch (e) {
          if (e && e.code === 'PAYLOAD_TOO_LARGE') {
            return json(res, 413, {
              ok: false, code: 'payload_too_large',
              error: `文件过大（单次上限 ${Math.round(MAX_CHUNK_BYTES / 1024 / 1024)}MB）；几万条请改用分片导入 /import/chunk`,
              maxBytes: MAX_CHUNK_BYTES, chunkSize: CHUNK_SIZE,
            })
          }
          throw e
        }
        let payload
        try { payload = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        // 兼容两种备份形状：
        //   ① 顶层就是卡片数组 —— v0.10.0 及以前「导出JSON」写出的 memory-vault.json；
        //   ② 带信封的对象 { format, formatVersion, exportedAt, count, cards: [...] } —— v0.10.1 起。
        // 旧实现只认 payload.cards，于是①被静默当成空备份（imported=0 / skipped=0 / ok=true，
        // UI 只显示「导入完成：0」，看不出是格式不匹配）—— 这是 issue「导出 OK 导入 0 张」的根因。
        const list = extractCards(payload)
        if (!list) return json(res, 400, { ok: false, error: '文件格式无法识别：应为卡片数组，或含 cards 数组的备份对象（请用本插件「导出JSON」生成的文件）' })
        if (!list.length) return json(res, 200, { ok: true, imported: 0, skipped: 0, quarantined: 0, duplicate: 0, total: 0, failed: [], warning: '文件里没有任何卡片' })
        // 一次性导入也走批量引擎（哈希判重 + 单事务）：比原来逐条 writeCard 快一个量级。
        const r = await importChunk(vaultRoot, list)
        json(res, 200, { ok: true, imported: r.imported, skipped: r.skipped, quarantined: r.quarantined, duplicate: r.duplicate, total: list.length, failed: r.failed })
        return
      }
      // 分片导入：**几万条的正确姿势**。
      // 客户端每片 ≤ CHUNK_SIZE 条循环调用；每片独立事务，失败可带 offset 重试（天然断点续传）。
      // 响应 nextOffset 是下一片起点，done=true 表示最后一片。
      case '/import/chunk': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        // 与 /import 同一套读取实现与上限（H2）
        let raw = ''
        try {
          raw = await readBodyText(req, { maxBytes: MAX_CHUNK_BYTES })
        } catch (e) {
          if (e && e.code === 'PAYLOAD_TOO_LARGE') {
            return json(res, 413, { ok: false, code: 'payload_too_large', error: '单片过大（上限 16MB）', maxBytes: MAX_CHUNK_BYTES })
          }
          throw e
        }
        let payload
        try { payload = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        // 两种入参：
        //   { cards:[...], offset, total }            —— 前端自己切好片
        //   { payload:<完整备份对象>, offset, limit }  —— 服务端切片（前端不必先拆）
        let slice
        let total = 0
        let offset = 0
        if (Array.isArray(payload.cards)) {
          slice = payload.cards
          total = Number(payload.total) > 0 ? Number(payload.total) : slice.length
          offset = Number(payload.offset) >= 0 ? Number(payload.offset) : 0
        } else {
          const all = extractCards(payload.payload)
          if (!all) return json(res, 400, { ok: false, error: '文件格式无法识别：应为卡片数组，或含 cards 数组的备份对象' })
          total = all.length
          offset = Number(payload.offset) >= 0 ? Number(payload.offset) : 0
          const limit = Math.min(Number(payload.limit) > 0 ? Number(payload.limit) : CHUNK_SIZE, CHUNK_SIZE)
          slice = all.slice(offset, offset + limit)
        }
        const r = await importChunk(vaultRoot, slice)
        // 操作日志：每片（默认 200 张）记一条汇总，不是每张一条
        try {
          const _imp = Number(r && r.imported) || 0
          const _dup = Number(r && r.duplicate) || 0
          const _skip = Math.max(0, (Number(r && r.skipped) || 0) - _dup)   // skipped 含 duplicate，这里只算"真跳过"
          if (_imp > 0 || _dup > 0 || _skip > 0) {
            const parts = []
            if (_imp > 0) parts.push('成功 ' + _imp)
            if (_dup > 0) parts.push('重复 ' + _dup)
            if (_skip > 0) parts.push('未通过 ' + _skip)
            // 全是失败时 action 走 import-fail，日志页可以单独筛出来
            logActivity(vaultRoot, { ip: clientIpOf(req), agent: 'import', action: _imp > 0 ? 'import' : 'import-fail', title: '导入：' + parts.join(' · ') })
          }
        } catch { /* 旁路 */ }
        const nextOffset = offset + slice.length
        json(res, 200, {
          ok: true,
          imported: r.imported, skipped: r.skipped, quarantined: r.quarantined, duplicate: r.duplicate,
          chunk: slice.length, offset, nextOffset, total,
          done: nextOffset >= total || slice.length === 0,
          failed: r.failed,
        })
        return
      }
      // 批量处置：把「几百条垃圾一条条点」变成一次调用。
      // 默认 dryRun=true —— 先看会动多少条，确认后才真执行（这个默认值是刻意的：
      // 误删记忆的代价远高于多点一次按钮）。
      case '/cards/bulk': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 POST' })
        const body = await readBody(req)
        const action = String(body.action || '').trim()
        const ACTIONS = ['delete', 'reject', 'restore', 'approve', 'archive']
        if (!ACTIONS.includes(action)) {
          return json(res, 400, { ok: false, error: `action 只能是 ${ACTIONS.join(' / ')}` })
        }
        const dryRun = body.dryRun !== false // 默认 true
        // 两种选法：显式 paths，或 filter（按垃圾扫描的分类挑）
        let paths = Array.isArray(body.paths) ? body.paths.map(String).filter(Boolean) : []
        let matched = paths.length
        if (!paths.length && body.filter && typeof body.filter === 'object') {
          paths = pickByFilter(vaultRoot, body.filter)
          matched = paths.length
        }
        if (!paths.length) return json(res, 200, { ok: true, dryRun, action, matched: 0, done: 0, failed: [], note: '没有匹配的卡片' })

        if (dryRun) {
          // dryRun 里也验证一下每条是否存在，避免"以为能删 500 条实际只有 3 条"
          const exists = []
          const db = getDb(vaultRoot)
          for (const p of paths) {
            try {
              const row = db.prepare('SELECT path FROM cards WHERE path = ? UNION ALL SELECT path FROM quarantine WHERE path = ?').get(p, p)
              if (row) exists.push(p)
            } catch { /* 忽略 */ }
          }
          return json(res, 200, {
            ok: true, dryRun: true, action, matched, existing: exists.length,
            preview: exists.slice(0, 30),
            note: '这是预演，什么都没改；确认后传 dryRun:false 执行',
          })
        }

        let done = 0
        const failed = []
        let i = 0
        for (const p of paths) {
          try {
            let r
            if (action === 'delete') r = await deleteCard(vaultRoot, p)
            else if (action === 'restore') r = await restoreCard(vaultRoot, p)
            else if (action === 'reject') r = await setCardStatus(vaultRoot, p, 'rejected', { changedBy: 'bulk', reason: '批量清理' })
            else if (action === 'archive') r = await setCardStatus(vaultRoot, p, 'archived', { changedBy: 'bulk', reason: '批量归档（不进主库检索，数据保留）' })
            else r = await setCardStatus(vaultRoot, p, 'approved', { changedBy: 'bulk', reason: '批量通过' })
            if (r && r.ok === false) failed.push({ path: p, reason: r.error || '失败' })
            else done++
          } catch (e) {
            failed.push({ path: p, reason: String((e && e.message) || e) })
          }
          // 每 50 条让出一次事件循环：9k 条批量删除会把同步 IO 排满，
          // 看门狗 / 健康检查拿不到响应就会重启进程 —— 删除做到一半、自动沉淀还会撞
          // database is locked（2026-11-23 实测 9565 条删到 5645 条时进程被重启）。
          if (++i % 50 === 0) await new Promise((r) => setImmediate(r))
        }
        json(res, 200, { ok: true, dryRun: false, action, matched, done, failed: failed.slice(0, 50) })
        return
      }
      // 自动体检：状态查询 + 手动触发。
      // 红线：自动流程**只归档、绝不删除**（归档可逆，删除不可逆）。
      case '/junk/auto': {
        const { autoConfigFrom, autoConfigWithFile, autoJunkDue, readAutoState, runAutoJunk } = await import('./auto-junk.js')
        const cfg = autoConfigWithFile(process.env, getSettings() || {})
        if (req.method === 'GET') {
          const st = readAutoState(vaultRoot)
          const due = autoJunkDue(vaultRoot, cfg)
          return json(res, 200, { ok: true, config: cfg, due: due.due, dueReason: due.reason, nextAt: due.nextAt || null, lastRunAt: st.lastRunAt || 0, lastReport: st.lastReport || null })
        }
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需要 GET 或 POST' })
        const body = await readBody(req)
        // 保存体检配置：走**独立文件**，不再经过 /api/config 的白名单与宿主 settings schema。
        // 那条路会把 junkAuto* 静默丢掉（POST 返回 applied，但宿主 sync 时按 schema 过滤），
        // 表现就是用户点了保存、开关照样弹回关。
        if (body && body.save && typeof body.save === 'object') {
          const { writeAutoSettings, readAutoSettings } = await import('./auto-junk.js')
          const w = writeAutoSettings(body.save, process.env)
          if (!w.ok) return json(res, 500, { ok: false, error: '保存失败：' + w.error })
          return json(res, 200, { ok: true, saved: true, config: autoConfigFrom(readAutoSettings(process.env)) })
        }
        const dryRun = body.dryRun !== false
        const r = await runAutoJunk(vaultRoot, { ...cfg, dryRun })
        json(res, 200, { ok: true, ...r, config: cfg })
        return
      }
      case '/merge': {
        const paths = (query.get('paths') || '').split(',').map((p) => p.trim()).filter(Boolean)
        const r = await mergeCards(vaultRoot, paths)
        if (!r.ok) return json(res, 400, r)
        json(res, 200, r)
        return
      }
      case '/stats': {
        await ensureVault(vaultRoot)
        const days = Math.min(Number(query.get('days')) || 30, 90)
        json(res, 200, { ok: true, ...(await stats(vaultRoot)), trend: await dailyCounts(vaultRoot, days) })
        return
      }
      case '/optimize': {
        // 非破坏性：只返回「整理建议」（相似卡对 + 陈旧卡），不自动删改。
        json(res, 200, { ok: true, ...(await optimizeCandidates(vaultRoot)) })
        return
      }
      // 垃圾扫描：把几万条里的「重复 / 过短 / 占位标题 / 陈旧 / 待审积压」自动分类，
      // 每条给理由和建议动作（delete / reject / archive / fix-title）。
      // 纯只读，不动任何数据 —— 处置走 /cards/bulk。
      case '/junk/scan': {
        const r = scanJunk(vaultRoot, {
          shortBodyChars: Number(query.get('shortBodyChars')) || undefined,
          staleDays: Number(query.get('staleDays')) || undefined,
          stalePendingDays: Number(query.get('stalePendingDays')) || undefined,
          nearDupThreshold: Number(query.get('nearDupThreshold')) || undefined,
          limit: Number(query.get('limit')) || undefined,
        })
        json(res, 200, r)
        return
      }
      case '/optimize-execute': {
        // 一键优化执行：合并相似卡 + 可选清理陈旧卡。POST body: {cleanupStale?, simThreshold?, staleDays?, dryRun?}
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: '需 POST' }); return }
        const rawOpt = await readRaw(req, res)
        if (rawOpt === null) return
        let opts = {}
        try { opts = JSON.parse(rawOpt || '{}') } catch { opts = {} }
        const result = await optimizeApply(vaultRoot, opts)
        json(res, 200, result)
        return
      }
      case '/refine': {
        // 矛盾扫描 · 候选预览（**不调模型、不写库**）：宽召回相似度 >= 0.30 的卡片对，含近重复那一段
        const { refineCandidates, readDecisions } = await import('./refine.js')
        const cands = await refineCandidates(vaultRoot)
        json(res, 200, {
          ok: true,
          candidates: cands.map((c) => ({ a: c.a, b: c.b, sim: c.sim })),
          decisions: Object.keys(readDecisions(vaultRoot)).length,
        })
        return
      }
      case '/refine-scan': {
        // 逐对判别（调模型）。POST {limit?, provider?, model?}；**只读**，结论要人来 apply。
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: '需 POST' }); return }
        const { refineScan } = await import('./refine.js')
        const rawScan = await readRaw(req, res)
        if (rawScan === null) return
        let opts = {}
        try { opts = JSON.parse(rawScan || '{}') } catch { opts = {} }
        const out = await refineScan(vaultRoot, {
          llm: getLlm(),
          limit: Number(opts.limit) || 12,
          provider: opts.provider,
          model: opts.model,
        })
        json(res, out.ok ? 200 : 400, out)
        return
      }
      case '/refine-apply': {
        // 人拍板：POST {a, b, action: keepA|keepB|merge|keepBoth, note?, relation?}
        // 只做可恢复动作（keepA/keepB → 另一张进回收站，可还原），并记进 refine-decisions.json
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: '需 POST' }); return }
        const { refineApply } = await import('./refine.js')
        const rawApply = await readRaw(req, res)
        if (rawApply === null) return
        let payload = {}
        try { payload = JSON.parse(rawApply || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        const out = await refineApply(vaultRoot, payload)
        json(res, out.ok ? 200 : 400, out)
        return
      }
      case '/refine-goals': {
        // 「同目标、不同做法」聚类（#36 第三块）：先让模型给每张卡抽一句「解决什么问题」（带缓存），
        // 再按**目标**聚类 —— 正文相似度抓不到这种关系（7z 压缩 / tar 分发 / npm 瘦身 字面差很远）。
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: '需 POST' }); return }
        const { goalScan } = await import('./refine.js')
        const rawGoals = await readRaw(req, res)
        if (rawGoals === null) return
        let opts = {}
        try { opts = JSON.parse(rawGoals || '{}') } catch { opts = {} }
        const out = await goalScan(vaultRoot, {
          llm: getLlm(),
          limit: Number(opts.limit) || 30,
          threshold: Number(opts.threshold) || 0.55,
          provider: opts.provider,
          model: opts.model,
        })
        json(res, out.ok ? 200 : 400, out)
        return
      }
      case '/refine-goals-keep': {
        // 把一组「同目标」标成都保留（记两两决策，避免下次重复提示）
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: '需 POST' }); return }
        const { markClusterKept } = await import('./refine.js')
        const rawKeep = await readRaw(req, res)
        if (rawKeep === null) return
        let payload = {}
        try { payload = JSON.parse(rawKeep || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        const out = await markClusterKept(vaultRoot, payload)
        json(res, out.ok ? 200 : 400, out)
        return
      }
      case '/llm-routes': {
        // issue #42 需求 1：把可选的 provider / model 动态列出来（面板用它渲染下拉，不再手填编号）。
        const llm = getLlm()
        // 独立页没有 llm 服务 → 代理给宿主（宿主心跳里有它的端口）
        if (!llm) { json(res, 200, await proxyHost('/api/llm-routes')); return }
        const providers = []
        try {
          for (const p of (llm.listProviders() || [])) {
            if (!p || !p.id) continue
            let models = []
            try { models = (await llm.listModels(p.id)) || [] } catch { models = [] }
            providers.push({ id: p.id, label: p.label || p.name || p.id, models: models.map((m) => ({ id: m && m.id, label: (m && (m.label || m.name)) || (m && m.id) })).filter((m) => m.id) })
          }
        } catch { /* 列不出来就返回空的，面板显示「取不到」 */ }
        const cfgL = getSettings() || {}
        json(res, 200, { ok: true, providers, current: { provider: cfgL.captureProvider || '', model: cfgL.captureModel || '', followSession: cfgL.captureFollowSession === true, firstOnly: cfgL.captureFirstOnly === true } })
        return
      }
      case '/llm-test': {
        // issue #42 需求 3：用当前配置真打一次，把 provider/model/耗时/错误码原样回显（也是 ①② 的验证手段）。
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: '需 POST' }); return }
        // 先读 body：本地调用与代理都要用（体积上限与其他路由一致，H2）
        const rawBody = await readRaw(req, res)
        if (rawBody === null) return
        const llm = getLlm()
        if (!llm) {
          // 独立页（桌面版弹窗 iframe）没有 llm：转给宿主真打一次，返回同样的结构
          json(res, 200, await proxyHost('/api/llm-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody || '{}' }))
          return
        }
        let opts = {}
        try { opts = JSON.parse(rawBody || '{}') } catch { opts = {} }
        const cfgT = getSettings() || {}
        const { routeCandidates: rc, callLlmJson: call } = await import('./capture.js')
        const routes = await rc(llm, { provider: opts.provider || cfgT.captureProvider, model: opts.model || cfgT.captureModel, firstOnly: opts.firstOnly === true || cfgT.captureFirstOnly === true })
        if (!routes.length) { json(res, 200, { ok: false, error: '取不到候选路由（llm.listProviders 为空）' }); return }
        const route = routes[0]
        const t0 = Date.now()
        let out = null
        try { out = await call(llm, route, { system: '你是连通性测试。只输出 JSON。', user: '输出 {"ok":true}', maxTokens: 64, purpose: 'memory-llm-test' }) } catch (e) { out = { failure: { code: 'EXCEPTION', message: String((e && e.message) || e) } } }
        json(res, 200, {
          ok: !out.failure,
          route: { provider: route.provider, model: route.model },
          candidates: routes.length,
          firstOnly: opts.firstOnly === true || cfgT.captureFirstOnly === true,
          ms: Date.now() - t0,
          text: out.text ? String(out.text).slice(0, 200) : '',
          failure: out.failure || null,
        })
        return
      }
      case '/align': {
        // 版本对齐检查：把「宿主/常驻/npm 的版本差」与「持久接线里的旧路径/旧事件键」一次查清，
        // 每条给可执行动作（重启 DSH / 重启常驻 / 重写接线 / 更新插件）。只读，不改任何东西。
        const { inspectAlignment } = await import('./align.js')
        const cfgV = getSettings() || {}
        const rep = await inspectAlignment({
          hostVersion: (getDshInfo() || {}).version || process.env.MEMORY_ETERNAL_VERSION || '',
          residentPort: selfPort() || Number(cfgV.webPort) || 7999,
          latest: versionCache.latest || '',
          updateCommand: 'dsh plugin --profile <你的 profile> add memory-eternal@latest',
          knownKeys: typeof deps.getConfigKeys === 'function' ? deps.getConfigKeys() : null,
        })
        json(res, 200, rep)
        return
      }
      case '/refine-junk': {
        // 注入垃圾卡的**提议清单**（只读）：正文其实是被注入的运行时文本（技能目录 / system-reminder…）。
        // 新版本已不再生成这类卡，这里负责把**存量**找出来，由人决定是否回收。
        const { findInjectedCards } = await import('./refine.js')
        const items = await findInjectedCards(vaultRoot)
        json(res, 200, { ok: true, count: items.length, items })
        return
      }
      case '/refine-junk-purge': {
        // POST {paths:[...]}：送**回收站**（可还原），不是永久删除
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: '需 POST' }); return }
        const { purgeInjected } = await import('./refine.js')
        const rawPurge = await readRaw(req, res)
        if (rawPurge === null) return
        let payload = {}
        try { payload = JSON.parse(rawPurge || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        const out = await purgeInjected(vaultRoot, payload)
        json(res, out.ok ? 200 : 400, out)
        return
      }
      case '/setup-run': {
        // 「补全 MCP」：真正执行 runSetup（写外部 agent 配置）。共享层（独立 web 也可用）
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
        try {
          const out = await runSetup({ log: () => {}, enabled: true })
          json(res, 200, { ok: true, results: out.results })
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message || e) }) }
        return
      }
      case '/mcp/action': {
        // 单智能体安装/卸载 MCP：POST {agent, action}。共享层（独立 web 可用）
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
        const rawMcp = await readRaw(req, res)
        if (rawMcp === null) return
        try {
          const body = JSON.parse(rawMcp || '{}')
          const out = await mcpAgentAction(String(body.agent || ''), String(body.action || ''), { log: () => {} })
          json(res, 200, out)
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message || e) }) }
        return
      }
      case '/setup-status': {
        // 只读查询各 agent MCP 配置状态，不写任何文件。
        // ⚠ **必须 no-store**：这是本机实时状态（装了哪些宿主、路径是什么），
        // 缓存一次就会一直显示旧数据 —— 云端代理时期留下的 Linux 路径会赖着不走。
        try { res.setHeader('Cache-Control', 'no-store, must-revalidate') } catch { /* 忽略 */ }
        const status = await getSetupStatus()
        // prepend DSH 宿主行（独立 web server 无 DSH 环境时只有外部 agent）
        const dsh = getDshInfo ? getDshInfo() : null
        if (dsh) {
          status.agents = [{ name: 'dsh', label: dsh.label || 'DSH (当前宿主)', installed: true, mcpConfigured: true, isDsh: true, recallTool: dsh.memoryRecallTool, autoCapture: dsh.autoCapture, autoRecall: dsh.autoRecall, vaultDir: dsh.vaultDir }, ...(status.agents || [])]
        }
        // 汇总按「最终展示行」重算（DSH 宿主行也算一个已挂载 Agent）
        const all = status.agents || []
        const installed = all.filter((a) => a.installed)
        const allServers = [...new Set(installed.flatMap((a) => (Array.isArray(a.servers) ? a.servers : [])))]
        status.summary = {
          detectedAgents: installed.length,
          mountedAgents: all.filter((a) => a.mcpConfigured).length,
          totalServers: allServers.length,
          allServers,
        }
        json(res, 200, status)
        return
      }
      case '/feedback': {
        const raw = await readRaw(req, res)
        if (raw === null) return
        let rec
        try { rec = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        if (!rec || !rec.path) return json(res, 400, { ok: false, error: '缺少 path' })
        await addFeedback(vaultRoot, { query: String(rec.query || ''), path: String(rec.path || ''), useful: rec.useful === true })
        json(res, 200, { ok: true })
        return
      }
      case '/ledger': {
        // 记忆账本：近 N 天召回注入 / 蒸馏调用开销 + 召回有用率
        try {
          const days = Number(query.get('days')) || 7
          json(res, 200, { ok: true, ...ledgerSummary(vaultRoot, { days }) })
        } catch (e) { json(res, 200, { ok: false, error: String(e?.message || e) }) }
        return
      }
      case '/star/status': {
        // 价值触发的 star 提示：够不够格问、以及「讲证据」用的数字
        try {
          const env = typeof process !== 'undefined' ? process.env : {}
          json(res, 200, starPromptStatus({ root: vaultRoot, env }))
        } catch (e) { json(res, 200, { ok: false, error: String(e?.message || e) }) }
        return
      }
      case '/star/action': {
        const rawStar = await readRaw(req, res)
        if (rawStar === null) return
        let starBody
        try { starBody = JSON.parse(rawStar || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        const env = typeof process !== 'undefined' ? process.env : {}
        const action = String(starBody?.action || 'later')
        json(res, 200, { ok: markStarAction(env, action), action })
        return
      }
      case '/working': {
        // 会话工作区：按 sessionId 隔离的草稿文件，不写 DB、不进 FTS、不参与召回。
        const sidOf = (raw) => String(raw || '').trim() || String(getActiveSession() || '').trim() || 'anonymous'
        if (req.method === 'POST') {
          const rawW = await readRaw(req, res)
          if (rawW === null) return
          let body = {}
          try { body = JSON.parse(rawW || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
          const sid = sidOf(body.session)
          const mode = String(body.mode || 'replace') === 'append' ? 'append' : 'replace'
          const out = writeWorking(process.env, sid, String(body.text == null ? '' : body.text), { mode })
          json(res, 200, { ...out, session: sid })
          return
        }
        const sid = sidOf(query.get('session'))
        json(res, 200, { ok: true, activeSession: String(getActiveSession() || ''), ...readWorking(process.env, sid) })
        return
      }
      case '/working/list': {
        json(res, 200, { ok: true, items: listWorking(process.env) })
        return
      }
      case '/working/clear': {
        const rawC = await readRaw(req, res)
        if (rawC === null) return
        let body = {}
        try { body = JSON.parse(rawC || '{}') } catch { /* 允许空体 */ }
        const sid = String(body.session || '').trim() || String(getActiveSession() || '').trim() || 'anonymous'
        json(res, 200, { ...clearWorking(process.env, sid), session: sid })
        return
      }
      case '/working/archive': {
        const rawA = await readRaw(req, res)
        if (rawA === null) return
        let body = {}
        try { body = JSON.parse(rawA || '{}') } catch { /* 允许空体 */ }
        const sid = String(body.session || '').trim() || String(getActiveSession() || '').trim() || 'anonymous'
        json(res, 200, { ...archiveWorking(process.env, sid), session: sid })
        return
      }
      case '/working/promote': {
        // 「存为待审卡」：工作区 → 审核队列。这是草稿进入长期记忆的唯一正门。
        const rawP = await readRaw(req, res)
        if (rawP === null) return
        let body = {}
        try { body = JSON.parse(rawP || '{}') } catch { /* 允许空体 */ }
        const sid = String(body.session || '').trim() || String(getActiveSession() || '').trim() || 'anonymous'
        const w = readWorking(process.env, sid)
        if (!w.exists || !w.text.trim()) return json(res, 400, { ok: false, error: '工作区为空，没有可提升的内容' })
        const firstLine = String(w.text.split('\n').find((l) => String(l).trim()) || '会话工作区笔记')
        const title = firstLine.replace(/^#{1,6}\s*/, '').trim().slice(0, 60) || '会话工作区笔记'
        const out = await writeCard(vaultRoot, {
          kind: 'knowledge',
          title,
          body: String(body.text || '').trim() || w.text,
          tags: ['会话工作区'],
          status: 'pending',
          source: 'working:' + sid,
        })
        json(res, 200, { ok: true, ...out, session: sid })
        return
      }
      case '/budget': {
        try {
          const cfg = getSettings() ?? {}
          const env = typeof process !== 'undefined' ? process.env : {}
          json(res, 200, {
            ok: true,
            budgetChars: cfg.sessionBudgetChars ?? 80000,
            recallLimit: cfg.recallLimit ?? 5,
            embedding: cfg.recallEmbedding || '',
            // 服务自管理配置（DSH host 从 settings 读；独立 web server 从 env 兜底）
            autoWeb: cfg.autoWeb ?? env.MEMORY_AUTO_WEB !== '0',
            autoWebMode: cfg.autoWebMode || 'init',
            webPort: Number(cfg.webPort) || Number(env.MEMORY_WEB_PORT) || 7999,
            webCheckIntervalMs: Number(cfg.webCheckIntervalMs) || 5000,
            webMaxRestart: Number(cfg.webMaxRestart) || 10,
            watchdogAutoSpawn: cfg.watchdogAutoSpawn ?? env.MEMORY_WATCHDOG === '1',
            autoRestartOnDrift: cfg.autoRestartOnDrift ?? true,
            autoMcpSetup: cfg.autoMcpSetup ?? false,
          })
        } catch (e) {
          // 配置读取异常时降级返回默认值，避免面板整块红屏
          json(res, 200, { ok: true, budgetChars: 80000, recallLimit: 5, embedding: '', autoWeb: true, autoWebMode: 'init', webPort: 7999, webCheckIntervalMs: 5000, webMaxRestart: 10, watchdogAutoSpawn: true, autoRestartOnDrift: true, autoMcpSetup: false })
        }
        return
      }
      case '/events': {
        // SSE 长连接（不 end），EventSource 会自动重连
        hub.add(res)
        return
      }
      case '/config': {
        // 独立 web server（无 DSH settings）的配置读取兜底：env + 默认值。DSH host 的 /config 在其 webServer handler 拦截实现（可写），此处只读。
        const cfg = getSettings() ?? {}
        const env = typeof process !== 'undefined' ? process.env : {}
        const safe = {
          autoCapture: cfg.autoCapture !== false, autoRecall: cfg.autoRecall ?? true, coreMemoryEnabled: cfg.coreMemoryEnabled ?? true, workingMemoryEnabled: cfg.workingMemoryEnabled ?? true, coreMemoryLimit: cfg.coreMemoryLimit ?? 6, coreMemoryMaxChars: cfg.coreMemoryMaxChars ?? 2000, uiScale: cfg.uiScale || 'normal', theme: cfg.theme || 'default', recallLimit: cfg.recallLimit ?? 5, recallSummaryLen: cfg.recallSummaryLen ?? 130, recallIncludeBody: cfg.recallIncludeBody ?? false, secretHint: cfg.secretHint || '',
          captureMinChars: cfg.captureMinChars ?? 120, captureCooldownMs: cfg.captureCooldownMs ?? 60000, dbFile: cfg.dbFile || '', mcpAutoMount: cfg.mcpAutoMount !== false, cloudWriteMode: cfg.cloudWriteMode === 'both' ? 'both' : 'cloud', dedupThreshold: cfg.dedupThreshold ?? 0.62, maxCardsPerDay: cfg.maxCardsPerDay ?? 1000,
          distillEnabled: cfg.distillEnabled ?? true, dedupByLLM: cfg.dedupByLLM ?? true, captureMaxTokens: cfg.captureMaxTokens ?? DEFAULT_CAPTURE_MAX_TOKENS, recallMinScore: cfg.recallMinScore ?? 2,
          autoWeb: cfg.autoWeb ?? env.MEMORY_AUTO_WEB !== '0', autoWebMode: cfg.autoWebMode || 'init', webPort: Number(cfg.webPort) || Number(env.MEMORY_WEB_PORT) || 7999, webCheckIntervalMs: Number(cfg.webCheckIntervalMs) || 5000, webMaxRestart: Number(cfg.webMaxRestart) || 10, watchdogAutoSpawn: cfg.watchdogAutoSpawn ?? env.MEMORY_WATCHDOG === '1', autoRestartOnDrift: cfg.autoRestartOnDrift ?? true, autoMcpSetup: cfg.autoMcpSetup ?? false,
          auditMode: cfg.auditMode ?? 'all', auditExemptAgents: cfg.auditExemptAgents ?? [], auditExemptKinds: cfg.auditExemptKinds ?? [], recycleRetentionDays: cfg.recycleRetentionDays ?? 30,
          vaultProfiles: Array.isArray(cfg.vaultProfiles) ? cfg.vaultProfiles : [], activeVault: cfg.activeVault || '',
          enabled: cfg.enabled !== false, vaultDir: cfg.vaultDir || '', captureProvider: cfg.captureProvider || '', captureFollowSession: cfg.captureFollowSession !== false, captureFirstOnly: cfg.captureFirstOnly === true, captureTimeoutMs: cfg.captureTimeoutMs ?? 60000,
          captureModel: cfg.captureModel || '', recallEmbedding: cfg.recallEmbedding || '', sessionBudgetChars: cfg.sessionBudgetChars ?? 80000,
          skillCardsAutoSync: cfg.skillCardsAutoSync ?? true, skillCardLanguage: cfg.skillCardLanguage || 'auto', captureLanguage: cfg.captureLanguage || 'auto', newsDigestEnabled: cfg.newsDigestEnabled === true, newsDigestIntervalMinutes: cfg.newsDigestIntervalMinutes ?? 720, newsDigestMaxItems: cfg.newsDigestMaxItems ?? 5,
          // 容灾 / 自动备份 / 自动还原（默认全开，缺省即可用）
          backupEnabled: cfg.backupEnabled !== false, backupIntervalHours: cfg.backupIntervalHours ?? 24, backupKeepDays: cfg.backupKeepDays ?? 30, backupAutoRestore: cfg.backupAutoRestore !== false,
          // 定时自动体检（实验性页那颗开关）。**必须收进白名单** ——
          // 之前漏了，用户点保存也写不进配置文件，开关永远弹回关。
          junkAutoEnabled: cfg.junkAutoEnabled === true,
          junkAutoAction: cfg.junkAutoAction === 'both' ? 'both' : 'archive',
          junkAutoIntervalHours: cfg.junkAutoIntervalHours ?? 24,
          junkAutoMaxPerRun: cfg.junkAutoMaxPerRun ?? 200,
          junkAutoNeverRecalledDays: cfg.junkAutoNeverRecalledDays ?? 90,
          junkAutoStaleDays: cfg.junkAutoStaleDays ?? 180,
          webPort: cfg.webPort ?? 7999, webCheckIntervalMs: cfg.webCheckIntervalMs ?? 5000, webMaxRestart: cfg.webMaxRestart ?? 10,
        }
        const NUM_RANGE = {
          dedupThreshold: [0, 1], captureMinChars: [0, 1000000], captureCooldownMs: [0, 1000000000],
          maxCardsPerDay: [0, 1000000], captureMaxTokens: [100, 4000], recallMinScore: [0, 50],
          recallLimit: [1, 20], recallSummaryLen: [40, 400], recycleRetentionDays: [1, 3650],
          webPort: [1, 65535], webCheckIntervalMs: [1000, 600000], webMaxRestart: [1, 1000],
          sessionBudgetChars: [0, 1000000000],
          // 容灾（整张表单一起提交时也要按同一口径校验）
          backupIntervalHours: [1, 8760], backupKeepDays: [1, 3650],
          // 定时自动体检：周期最长 30 天；单次归档上限 2000（auto-junk.js 里也会再夹一次）
          junkAutoIntervalHours: [1, 720], junkAutoMaxPerRun: [1, 2000],
          junkAutoNeverRecalledDays: [1, 3650], junkAutoStaleDays: [1, 3650],
        }
        // POST：独立 web 没有 DSH settings 服务，改成写「待应用」文件，由 DSH 端自动应用
        // （否则这里的保存按钮永远是死的 —— issue #12 的一半就栽在这）
        if (req.method === 'POST') {
          const body = await readBody(req)
          const patch = body && typeof body.patch === 'object' && body.patch ? body.patch : null
          if (!patch) return json(res, 400, { ok: false, error: '缺少 patch' })
          const allowed = new Set(Object.keys(safe))
          const clean = {}
          const bad = []
          for (const [k, v] of Object.entries(patch)) {
            if (!allowed.has(k)) continue
            const base = safe[k]
            if (Array.isArray(base)) { if (!Array.isArray(v)) bad.push(k); else clean[k] = v; continue }
            if (typeof base === 'number') {
              const n = typeof v === 'number' ? v : Number(v)
              const rng = NUM_RANGE[k] || [-Infinity, Infinity]
              const lo = rng[0], hi = rng[1]
              if (v === '' || v === null || v === undefined || !Number.isFinite(n)) bad.push(k + ' 需要数字')
              else if (n < lo || n > hi) bad.push(k + ' 需要 ' + lo + '-' + hi + '，当前 ' + n)
              else clean[k] = n
              continue
            }
            if (typeof base === 'boolean') { if (typeof v !== 'boolean') bad.push(k); else clean[k] = v; continue }
            if (typeof v !== 'string') bad.push(k); else clean[k] = v
          }
          if (bad.length) return json(res, 400, { ok: false, error: '字段值不合法：' + bad.join('、'), fields: bad })
          if (!Object.keys(clean).length) return json(res, 400, { ok: false, error: '没有可写入的字段' })
          const { writePendingConfig, readPendingConfig, waitPendingOutcome, clearPendingConfig, applySharedConfigDirect, describeApplyFailure, triggerHostDrain } = await import('./config-sync.js')
          const { hostAlive, readHostMarker } = await import('./host-heartbeat.js')
          // #16 建议 4：上一份改动是否已被判定失败？是的话这次不能再报「一切正常」——
          // 否则用户第 N 次点击保存，看到的仍是成功，而问题一直在（其实是 settings.update 在报错）。
          const before = readPendingConfig(process.env)
          const out = writePendingConfig(process.env, clean)
          hub.broadcast('config', { at: out.at, source: 'standalone', applied: Object.keys(clean) })
          // 方案 A（首选）：宿主活着、且心跳里带了端口 + 令牌时，**直接请宿主在 HTTP 请求上下文里
          // 应用**。为什么不继续等宿主自己 drain：宿主那条 drain 挂在回调上下文（setInterval /
          // fs.watch），在带 activation 守卫的宿主上必然被拒（实测与 patch 内容无关）—— 等不来结果。
          // 叫醒失败（旧宿主没这条路由 / 端口对不上 / 超时）不是错误：退回 issue #21 的等待路径。
          let outcome = 'queued'
          let hostDrainError = ''
          let hostGuardBlocked = false
          let tokenMismatch = false
          const aliveHost = hostAlive(process.env) ? readHostMarker(process.env) : null
          if (aliveHost && aliveHost.port && aliveHost.token) {
            const call = await triggerHostDrain({ port: aliveHost.port, token: aliveHost.token, timeoutMs: 2500 })
            if (call.ok) outcome = 'applied'
            else if (call.status === 404 || call.status === 405 || call.status === 0) hostDrainError = call.error || ''
            else {
              // 401 /「令牌不匹配」不是「宿主应用失败」，而是**这台 web 与宿主之间的通道对不上**：
              // 心跳文件里的 token 是某个更早实例写的，宿主内存里的是另一个。旧宿主不会自愈这条，
              // 于是保存永远报失败（用户看到的就是顶部红条「保存失败 · 宿主侧未应用」）。
              // 这种情况按「宿主无关」处理：直写共享配置让它当场生效，并如实告知重启宿主后完全同步。
              // DSH 宿主的 HTTP 门禁（"Browser access is disabled"）挡掉的不是令牌问题，
              // 而是「插件 → 宿主」这条 HTTP 加速通道：文件监听通道仍然可用。
              // 这种不能判 failed，否则用户看到「保存失败」但配置其实会由宿主文件监听生效。
              const hostBlocked = call.status === 403 || /browser access is disabled/i.test(String(call.error || ''))
              hostGuardBlocked = hostBlocked
              tokenMismatch = call.status === 401 || /令牌|token/i.test(String(call.error || ''))
              outcome = (tokenMismatch || hostGuardBlocked) ? 'queued' : 'failed'
              hostDrainError = call.error || ''
            }
          }
          // 回落（issue #21 建议 3）：别急着报「一切正常」。宿主对 pending 文件有 fs.watch（毫秒级），
          // 稍等一下回读，就能分清「真的应用了」还是「只是排上队了」。
          if (outcome === 'queued') outcome = await waitPendingOutcome(process.env, { timeoutMs: 800 })
          // issue #21 的宿主无关路径：**本机没有活着的 DSH 宿主**时（Codex / Claude Code /
          // 只跑 dsh-memory serve 的用户），没有任何进程会来 drain pending 文件 —— 那句
          // 「DSH 未运行时下次启动生效」在那类环境下永远不会兑现。这时直接原子写共享配置
          // （hooks / MCP / 独立页都读这个文件），让保存当场生效。
          // 宿主活着时绝不走这条：共享文件是宿主的派生镜像，绕过它直写会被下一次 syncConfigFile 盖掉。
          let appliedDirect = false
          // 直写的两个条件：
          //   ① 本机没有活着的宿主（旧逻辑）；
          //   ② 宿主活着但**令牌对不上**（见上面 tokenMismatch）—— 这条通道永久不通，
          //      再不直写就等于「保存永远失败」。直写后由下一次宿主启动同步覆盖掉，语义是安全的。
          if (outcome === 'queued') {
            if (!hostAlive(process.env) || tokenMismatch) {
              try {
                applySharedConfigDirect(process.env, clean)
                clearPendingConfig(process.env)
                outcome = 'applied-direct'
                appliedDirect = true
              } catch { /* 直写失败 → 保持 queued，如实回报，改动仍留在 pending 文件里 */ }
            }
          }
          const stale = before && (before.dropped || before.lastError)
          const advice = describeApplyFailure(before && before.lastError)
          const hostGuard = advice.kind === 'host-guard'
          // 上一份已经被这个宿主的守卫判死（dropped + host-guard）→ 这次也不能再空头承诺
          // 「DSH 端会自动同步」：直说去哪儿改，否则用户会一直看到一个永远不会生效的「已排队」。
          const knownGuard = Boolean(before && before.dropped && hostGuard)
          const note = outcome === 'applied'
            ? '宿主已在请求上下文里应用该改动（点保存即生效）。'
            : outcome === 'applied-direct'
              ? '本机没有 DSH 宿主在运行，已直接写入共享配置（hooks / MCP / 独立页立即生效）。'
            : hostGuardBlocked
              ? '宿主拒绝 HTTP 回调（Browser access is disabled）：改动已排队，会由 DSH 的文件监听自动应用（插件 ≥0.54.1）；若 1 分钟内未生效，请升级/重启 DSH。'
              : outcome === 'failed'
                ? '改动已写入，但宿主侧应用失败：' + (hostDrainError || (hostGuard ? advice.hint : '详见「反馈异常」里的诊断信息。'))
                : knownGuard
                  ? '这个宿主不允许插件从回调上下文写配置（与配置内容无关）：请到「DSH 设置 → 记忆」里改同一项。本次改动已在独立端重新排队，宿主升级/重启后仍会自动应用。'
                  : '已写入待应用：DSH 端会自动同步（DSH 未运行时下次启动生效）'
          return json(res, 200, {
            ok: true, applied: Object.keys(clean), pending: (appliedDirect || outcome === 'applied') ? [] : Object.keys(clean), retried: false, at: out.at,
            pendingOutcome: outcome,
            appliedDirect,
            // 方案 A 的现场：宿主叫醒失败的原因（旧宿主没路由 / 令牌不匹配 / 应用报错）如实回给界面
            hostDrainError: hostDrainError || undefined,
            hostGuard: hostGuard || undefined,
            hint: hostGuard ? advice.hint : undefined,
            warning: stale
              ? '上一次写入待应用时连续失败（' + (before.lastError || '原因未记录') + '）；本次已重新写入并重试，如仍不生效请查看「反馈异常」里的诊断信息'
              : undefined,
            note,
          })
        }
        let pendingD = null
        try { const { readPendingConfig } = await import('./config-sync.js'); pendingD = readPendingConfig(process.env) } catch { pendingD = null }
        json(res, 200, {
          ok: true, config: safe, revision: 0, writable: true, readonly: false, viaPending: true,
          pendingConfig: pendingD ? { at: pendingD.at, tries: pendingD.tries, dropped: pendingD.dropped, lastError: pendingD.lastError } : null,
          version: env.MEMORY_ETERNAL_VERSION || '',
        })
        return
      }
      // ---- 可选语义召回：状态 / 配置 / 建缓存 / 拉模型（本地 Ollama，默认 7997） ----
      case '/embedding/status': {
        const { publicEmbeddingConfig, readEmbeddingConfig } = await import('./embedding-config.js')
        const { settingsFor, probeService, vectorStats } = await import('./embeddings.js')
        // 默认就探测（本地请求 ~10ms，带 3 秒缓存）：早先只有 ?probe=1 才探，
        // 面板忘带参数时就会把「服务明明在跑」显示成「服务不可达」——用户据此去点启动服务，越点越乱。
        // 需要抑制探测时显式传 probe=0。
        const probeParam = new URLSearchParams(query).get('probe')
        const wantProbe = probeParam !== '0'
        const nowMs = Date.now()
        if (!probeCache.has(vaultRoot) || nowMs - probeCache.get(vaultRoot).at > 3000) probeCache.delete(vaultRoot)
        const cfg = settingsFor(vaultRoot)
        let service = probeCache.get(vaultRoot)?.service || null
        if (wantProbe && !service) {
          // 未启用时也用已保存的地址/模型做探测：用户先「检测连接」再决定是否启用
          let probeCfg = cfg
          if (!probeCfg) {
            const saved = readEmbeddingConfig(process.env)
            if (saved.mode === 'builtin') {
              // 内置通道没有 baseUrl（配置层只接受 http(s)），探测也必须走 builtin 分支，
              // 否则面板会把「内置语义」显示成「服务不可达」。
              const { BUILTIN_MODEL } = await import('./builtin-embed.js')
              probeCfg = { mode: 'builtin', baseUrl: 'builtin://local', apiKey: '', model: saved.model || BUILTIN_MODEL }
            } else if (saved.baseUrl && saved.model) {
              probeCfg = { baseUrl: saved.baseUrl.replace(/\/+$/, ''), apiKey: saved.apiKey || '', model: saved.model }
            }
          }
          try { service = probeCfg ? await probeService(probeCfg) : { reachable: false, kind: '', models: [], error: '未启用' } }
          catch (e) { service = { reachable: false, kind: '', models: [], error: String((e && e.message) || e) } }
          probeCache.set(vaultRoot, { at: nowMs, service })
        }
        const coverage = cfg ? vectorStats(vaultRoot, cfg.model) : { vectors: 0, cards: 0, model: '' }
        json(res, 200, { ok: true, enabled: !!cfg, source: cfg?.source || '', config: publicEmbeddingConfig(process.env), coverage, service, job: embedJobs.get(vaultRoot) || null })
        return
      }
      case '/embedding/config': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        try {
          const { writeEmbeddingConfig, publicEmbeddingConfig } = await import('./embedding-config.js')
          const patch = {}
          for (const k of ['enabled', 'mode', 'baseUrl', 'model', 'apiKey']) if (body[k] !== undefined) patch[k] = body[k]
          const written = writeEmbeddingConfig(patch, process.env)
          // 配置一改，之前那次探测结论就作废（否则 3 秒缓存会把「刚切到在线」显示成旧通道）
          probeCache.delete(vaultRoot)
          // corrected：保存时被纠正的项（例如 local 模式写了公网地址），面板据此提示用户
          json(res, 200, { ok: true, config: publicEmbeddingConfig(process.env), corrected: written.corrected || [] })
        } catch (e) { json(res, 400, { ok: false, error: String((e && e.message) || e) }) }
        return
      }
      case '/embedding/backfill': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        const limit = Math.min(Math.max(Number(body.limit) || 200, 1), 20000)
        const running = embedJobs.get(vaultRoot)
        if (running && running.state === 'running') return json(res, 200, { ok: true, job: running })
        const { settingsFor, backfill, vectorStats } = await import('./embeddings.js')
        const cfg = settingsFor(vaultRoot)
        if (!cfg) return json(res, 400, { ok: false, error: '语义召回未启用：先保存并开启配置' })
        const job = { kind: 'backfill', state: 'running', done: 0, total: limit, model: cfg.model, startedAt: Date.now(), error: '' }
        embedJobs.set(vaultRoot, job)
        ;(async () => {
          try {
            const r = await backfill(vaultRoot, cfg, { limit, batch: 16, onProgress: (d, t) => { job.done = d; job.total = t } })
            const st = vectorStats(vaultRoot, cfg.model)
            Object.assign(job, { state: 'done', done: r.embedded, total: r.embedded, coverage: st, finishedAt: Date.now() })
          } catch (e) {
            Object.assign(job, { state: 'failed', error: String((e && e.message) || e), finishedAt: Date.now() })
          }
        })()
        json(res, 200, { ok: true, job })
        return
      }
      case '/embedding/pull': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        const running = embedJobs.get(vaultRoot)
        if (running && running.state === 'running') return json(res, 200, { ok: true, job: running })
        const { settingsFor, probeService, pullModel } = await import('./embeddings.js')
        const { readEmbeddingConfig } = await import('./embedding-config.js')
        let cfg = settingsFor(vaultRoot)
        if (!cfg) {
          const saved = readEmbeddingConfig(process.env)
          if (!saved.baseUrl) return json(res, 400, { ok: false, error: '先填写本地服务地址' })
          cfg = { baseUrl: saved.baseUrl.replace(/\/+$/, ''), apiKey: saved.apiKey || '', model: saved.model }
        }
        const model = String(body.model || cfg.model || '').trim()
        const job = { kind: 'pull', state: 'running', model, status: '', completed: 0, total: 0, startedAt: Date.now(), error: '' }
        embedJobs.set(vaultRoot, job)
        ;(async () => {
          try {
            const probe = await probeService(cfg)
            if (!probe.reachable) throw new Error('服务不可达：' + (probe.error || '请先启动本地服务'))
            if (probe.kind !== 'ollama') throw new Error('当前端点不是 Ollama，无法一键拉取；请手动下载模型')
            await pullModel(cfg, model, {
              onProgress: (p) => {
                if (p.status) job.status = String(p.status)
                if (p.completed != null) job.completed = Number(p.completed) || 0
                if (p.total != null) job.total = Number(p.total) || 0
              },
            })
            Object.assign(job, { state: 'done', status: 'success', finishedAt: Date.now() })
          } catch (e) {
            Object.assign(job, { state: 'failed', error: String((e && e.message) || e), finishedAt: Date.now() })
          }
        })()
        json(res, 200, { ok: true, job })
        return
      }
      case '/embedding/models': {
        const { MODEL_CATALOG, VENDORS, ollamaStatus, systemInfo, installedModelNames } = await import('./embedding-catalog.js')
        const { publicEmbeddingConfig, readEmbeddingConfig } = await import('./embedding-config.js')
        const { settingsFor, probeService, vectorStats } = await import('./embeddings.js')
        const saved = readEmbeddingConfig(process.env)
        const active = settingsFor(vaultRoot)
        const baseUrl = active?.baseUrl || saved.baseUrl
        const installed = await installedModelNames({ baseUrl, apiKey: saved.apiKey || '' })
        let probe = null
        if (new URLSearchParams(query).get('probe') === '1') {
          try { probe = await probeService({ baseUrl, apiKey: saved.apiKey || '', model: saved.model }) } catch { probe = null }
        }
        // 双重判定：装没装（文件）+ 跑没跑（/api/tags）。只看文件会在服务未启动时误报「未安装」。
        let ollama = await ollamaStatus(process.env)
        const svc = probe || await probeService({ baseUrl, apiKey: saved.apiKey || '', model: saved.model }, { timeoutMs: 1500 }); 
        const serviceReachable = Boolean(svc?.reachable)
        if (serviceReachable && !ollama.installed) ollama = { installed: true, path: '', version: 'service' }
        json(res, 200, {
          ok: true,
          catalog: MODEL_CATALOG,
          vendors: VENDORS,
          installed,
          ollama: { ...ollama, serviceReachable },
          setupPath: process.env.MEMORY_OLLAMA_SETUP || '',
          system: await systemInfo(),
          config: publicEmbeddingConfig(process.env),
          coverage: vectorStats(vaultRoot, saved.model),
          service: svc,
          job: embedJobs.get(vaultRoot) || null,
        })
        return
      }
      case '/embedding/install-ollama': {
        // 三个入口，按能力递进：
        //   GET  /  {action:'status'} → 安装任务进度（phase/bytes/total/exe）
        //   {action:'auto'}           → 一键闭环：下载官方安装器 → 静默安装 → 等 exe 出现
        //   {action:'run'}            → 执行**运维显式配置**的安装器（只认 MEMORY_OLLAMA_SETUP）
        //
        // ★ 审计 S3：旧实现的 `run` 直接吃 `body.path` 并交给 `execFile` —— 本端点无鉴权、
        //   不在云端管理面里，等于「任意租户/任意网页 POST 一个路径就能以插件权限起进程」
        //   （`{"action":"run","path":"C:\\Windows\\System32\\cmd.exe"}`）。现在请求里的 path
        //   **一律忽略**，只认环境变量里那个已存在的绝对路径安装器。
        const { installState, autoInstall, runSilentInstall, waitInstalled, validateInstallerPath } = await import('./ollama-install.js')
        const method = String(req.method || 'GET').toUpperCase()
        const body = req.method === 'POST' ? (await readBody(req)) : {}
        const action = String(body.action || (req.method === 'POST' ? 'auto' : 'status')).toLowerCase()
        if (action === 'status') return json(res, 200, { ok: true, ...installState(), setupPath: process.env.MEMORY_OLLAMA_SETUP || '', downloadUrl: 'https://ollama.com/download' })

        const { ollamaStatus } = await import('./embedding-catalog.js')
        const st0 = await ollamaStatus(process.env)
        if (st0.installed) return json(res, 200, { ok: true, already: true, path: st0.path })

        if (action === 'run') {
          const ignoredPath = String(body.path || '').trim()
          const setup = String(process.env.MEMORY_OLLAMA_SETUP || '').trim()
          const check = validateInstallerPath(setup)
          if (!check.ok) {
            return json(res, 403, {
              ok: false,
              code: 'path_not_allowed',
              error: check.error + '；请用 action="auto" 走官方下载流程',
              ignoredPath: ignoredPath ? { requested: ignoredPath, note: '请求里的 path 已被忽略：只认服务端环境变量 MEMORY_OLLAMA_SETUP' } : undefined,
              setupPath: setup,
            })
          }
          const run = await runSilentInstall(check.path, { env: process.env })
          const exe = run.ok ? await waitInstalled({ timeoutMs: 90 * 1000 }) : ''
          const extra = ignoredPath ? { ignoredPath: { requested: ignoredPath, note: '请求里的 path 已被忽略：只认服务端环境变量 MEMORY_OLLAMA_SETUP' } } : {}
          return json(res, 200, run.ok && exe
            ? { ok: true, exe, path: check.path, ...extra }
            : { ok: false, ...extra, path: check.path, error: run.error || '安装后未检测到可执行文件' })
        }

        // 默认 auto：不阻塞响应，后台跑，前端轮询 status 看进度
        if (installState().phase === 'downloading' || installState().phase === 'installing') {
          return json(res, 200, { ok: false, busy: true, ...installState() })
        }
        ;(async () => { try { await autoInstall({ env: process.env }) } catch { /* 状态里已记错 */ } })()
        return json(res, 202, { ok: true, started: true, ...installState() })
      }
      case '/embedding/service': {
        // 本地嵌入服务的启停：面板上一个按钮就能拉起/关掉 Ollama，不用开终端敲命令。
        // 只操作本插件启动的那个进程（pid 记在 $DSH_HOME/ollama-service.json），用户自启的不碰。
        const { serviceStatus, startService, stopService } = await import('./ollama-service.js')
        const method = String(req.method || 'GET').toUpperCase()
        if (method === 'GET') {
          try { return json(res, 200, { ok: true, ...(await serviceStatus(process.env)) }) }
          catch (e) { return json(res, 200, { ok: false, error: String((e && e.message) || e) }) }
        }
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'GET / POST only' })
        const body = await readBody(req)
        const action = String(body.action || '').toLowerCase()
        if (!['start', 'stop', 'restart'].includes(action)) return json(res, 400, { ok: false, error: 'action 只能是 start / stop / restart' })
        try {
          if (action === 'stop') return json(res, 200, await stopService({ env: process.env }))
          if (action === 'restart') { await stopService({ env: process.env }); return json(res, 200, await startService({ env: process.env })) }
          return json(res, 200, await startService({ env: process.env }))
        } catch (e) {
          return json(res, 200, { ok: false, error: String((e && e.message) || e) })
        }
      }
      case '/embedding/deploy': {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
        const body = await readBody(req)
        try {
          const { writeEmbeddingConfig } = await import('./embedding-config.js')
          const { BUILTIN_MODEL } = await import('./builtin-embed.js')
          const { settingsFor, backfill, vectorStats } = await import('./embeddings.js')
          const saved = (await import('./embedding-config.js')).readEmbeddingConfig(process.env)
          const mode = ['local', 'builtin', 'online'].includes(body.mode) ? body.mode : (body.baseUrl && /127\.0\.0\.1|localhost/.test(body.baseUrl) ? 'local' : (body.baseUrl ? 'online' : saved.mode || 'local'))
          const model = String(body.model || saved.model || '').trim()
          const baseUrl = String(body.baseUrl || saved.baseUrl || 'http://127.0.0.1:7997/v1').trim()
          if (mode === 'builtin') {
            // 内置语义是**真能用**的本地通道（字符 n-gram + 内置近义归一），不是「选中即关闭」：
            // 写 enabled:true + 固定模型名，让它和外部模型一样走 backfill / denseSearch。
            // 注意：**不能**写 baseUrl —— 配置层只接受 http(s)://，`builtin://` 会被校验拒掉；
            // 运行时的 baseUrl 由 settingsFor 的 builtin 分支给（内置通道根本不发网络请求）。
            writeEmbeddingConfig({ enabled: true, mode: 'builtin', model: BUILTIN_MODEL }, process.env)
          } else {
            if (!model) return json(res, 400, { ok: false, error: '缺少模型名' })
            writeEmbeddingConfig({ enabled: true, mode, baseUrl, model, apiKey: body.apiKey !== undefined ? body.apiKey : saved.apiKey }, process.env)
          }
          // 切换通道后旧的探测结论作废（缓存 3 秒，否则面板会短暂显示上一个通道的状态）
          probeCache.delete(vaultRoot)
          const cfg = settingsFor(vaultRoot)
          if (!cfg) return json(res, 400, { ok: false, error: '配置未生效' })
          const running = embedJobs.get(vaultRoot)
          if (running && running.state === 'running') return json(res, 200, { ok: true, mode, model: cfg.model, job: running })
          const job = { kind: 'backfill', state: 'running', done: 0, total: 0, model, startedAt: Date.now(), error: '' }
          embedJobs.set(vaultRoot, job)
          ;(async () => {
            try {
              const r = await backfill(vaultRoot, cfg, { limit: 20000, batch: 16, onProgress: (d, t) => { job.done = d; job.total = t } })
              Object.assign(job, { state: 'done', done: r.embedded, total: r.embedded, coverage: vectorStats(vaultRoot, cfg.model), finishedAt: Date.now() })
            } catch (e) {
              Object.assign(job, { state: 'failed', error: String((e && e.message) || e), finishedAt: Date.now() })
            }
          })()
          json(res, 200, { ok: true, mode, model: cfg.model, job })
        } catch (e) { json(res, 400, { ok: false, error: String((e && e.message) || e) }) }
        return
      }
      case '/compress': {
        // 记忆侧「压缩产物」接口：供 harness 在会话内压缩旧轮次时调用，返回一段可注入的摘要。
        const cfg = getSettings() ?? {}
        const body = new URLSearchParams(query)
        const text = body.get('text') || ''
        const maxChars = Math.min(Number(body.get('max')) || 2400, 6000)
        if (!text.trim()) return json(res, 400, { ok: false, error: '缺少 text' })
        const compressed = await compressExcerpt(text, maxChars)
        json(res, 200, { ok: true, compressed, budgetChars: cfg.sessionBudgetChars ?? 80000 })
        return
      }
      case '/backup': {
        // 立即备份。保留期与自动备份同一份配置（keepDays），不再写死 7 份。
        const { keepDays } = disasterConfig()
        const r = await backupDb(vaultRoot, { keepDays })
        json(res, r.ok ? 200 : 500, r)
        return
      }
      case '/backup/export': {
        // 导出一份可直接存档的库文件：先做一次当场备份（走同一套校验/保留策略），再把文件流回去。
        // 为什么先备份而不是直接读主库：主库可能正被写，`VACUUM INTO` 出来的才是自洽快照。
        try {
          const { keepDays } = disasterConfig()
          const r = await backupDb(vaultRoot, { keepDays })
          if (!r || !r.ok) return json(res, 500, { ok: false, error: (r && r.error) || '备份失败' })
          const file = r.path
          const { statSync, readFileSync } = await import('node:fs')
          const { basename } = await import('node:path')
          const size = statSync(file).size
          const buf = readFileSync(file)
          const name = basename(file)
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${name}"`,
            'Content-Length': String(buf.length),
            'Cache-Control': 'no-store',
          })
          res.end(buf)
          console.error('[memory-eternal] backup export: ' + name + ' (' + Math.round(size / 1048576) + 'MB)')
        } catch (e) {
          json(res, 500, { ok: false, error: String((e && e.message) || e) })
        }
        return
      }
      case '/backup/import': {
        // 导入还原：上传一个 .db（base64）→ 校验 → 现场备份当前库留证 → 替换主库。
        // 校验三件事：SQLite 魔数、quick_check、必须有 cards 表。任何一步不过都不动主库。
        if (String(req.method || '').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: 'POST only' })
        // ★ 私有临时目录（审计 H3）：旧实现把上传内容写进 `os.tmpdir()/me-import-<Date.now()>.db` ——
        //   路径可预测、共享 tmp、默认权限、无 O_EXCL。多用户主机上别人可以**预置同名符号链接**，
        //   让高权限的 web 进程覆盖任意文件；默认权限还等于把整库 dump 短暂公开可读。
        const pathMod = await import('node:path')
        const fsMod = await import('node:fs')
        const osMod = await import('node:os')
        let tmpDir = ''
        try {
          const body = await readBody(req, { maxBytes: LARGE_BODY_BYTES })
          const b64 = String(body.data || body.base64 || '').replace(/^data:[^,]+,/, '')
          if (!b64) return json(res, 400, { ok: false, error: '缺少文件内容（data/base64）' })
          // base64 长度先做上限判断，别等 Buffer.from 把内存翻倍再说
          const maxB64 = Math.ceil(LARGE_BODY_BYTES / 3) * 4
          if (b64.length > maxB64) {
            return json(res, 413, {
              ok: false, code: 'payload_too_large',
              error: '导入文件超过上限（' + Math.round(LARGE_BODY_BYTES / 1024 / 1024) + 'MB）',
              maxBytes: LARGE_BODY_BYTES,
            })
          }
          const raw = Buffer.from(b64, 'base64')
          if (raw.length < 4096) return json(res, 400, { ok: false, error: '文件太小，不像是题库文件' })
          if (raw.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
            return json(res, 400, { ok: false, error: '不是 SQLite 数据库（缺少文件头）' })
          }
          const { DatabaseSync } = await import('node:sqlite')
          // mkdtemp 生成**随机且独占**的目录（0700），再把文件以 wx + 0600 写进去
          tmpDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'me-import-'))
          const tmp = pathMod.join(tmpDir, 'upload.db')
          fsMod.writeFileSync(tmp, raw, { flag: 'wx', mode: 0o600 })
          // 校验临时文件
          let probe
          try {
            probe = new DatabaseSync(tmp, { readOnly: true })
            const qc = String(probe.prepare('PRAGMA quick_check').get().quick_check)
            if (qc !== 'ok') throw new Error('数据库自检失败：' + qc)
            const has = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cards'").get()
            if (!has) throw new Error('这个库里没有 cards 表，不像记忆库文件')
            probe.close()
            probe = null
          } catch (e) {
            if (probe) { try { probe.close() } catch { /* 忽略 */ } }
            return json(res, 400, { ok: false, error: String((e && e.message) || e) })
          }
          // 存进 backups/ 再走**统一的还原路径**（restoreFromBackup：留证改名 + 重试 rename +
          // 校验 + 复核），不要在这里另写一套替换逻辑 —— 那套已经处理过 Windows 的 EBUSY 坑。
          const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
          const backupDir = pathMod.join(vaultRoot, 'backups')
          mkdirSync(backupDir, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const importFile = pathMod.join(backupDir, 'import-' + stamp + '.db')
          writeFileSync(importFile, raw, { mode: 0o600 })
          try { closeAllDb() } catch { /* 忽略 */ }
          const { restoreFromBackup } = await import('./db.js')
          const restored = await restoreFromBackup(vaultRoot, { from: importFile, force: true })
          // 导入成功就把这份临时导入文件从备份清单里收掉（它只是搬运介质，不是备份的一份）
          if (restored && restored.ok) { try { rmSync(importFile, { force: true }) } catch { /* 忽略 */ } }
          if (!restored || !restored.ok) {
            const e = String((restored && restored.error) || '还原失败')
            return json(res, 500, {
              ok: false,
              error: /EBUSY|busy or locked/i.test(e)
                ? '主库被别的进程占着（多半是 DSH 宿主还在用旧插件）。请完全退出 DSH 桌面端后再导入，或重启后重试。原错误：' + e
                : e,
            })
          }
          json(res, 200, {
            ok: true,
            imported: { cards: restored.cards, bytes: raw.length },
            previous: (restored.movedAside || []).length,
            note: '已用导入文件替换主库；原库已改名留证（*.corrupt-*）。刷新页面即生效。',
          })
        } catch (e) {
          if (e && e.code === 'PAYLOAD_TOO_LARGE') {
            return json(res, 413, { ok: false, code: 'payload_too_large', error: String((e && e.message) || e), maxBytes: e.maxBytes || LARGE_BODY_BYTES })
          }
          json(res, 500, { ok: false, error: String((e && e.message) || e) })
        } finally {
          // 成功/失败都清掉临时目录（含校验用的库文件）
          if (tmpDir) { try { fsMod.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 忽略 */ } }
        }
        return
      }
      case '/backup/status': {
        // 容灾面板的唯一数据源：配置 + 上次成功备份 + 现有备份清单 + 下次计划时间。
        // 只读：不触发备份、不碰主库（库坏着也要能看）
        const config = disasterConfig()
        const files = await listBackupFiles(vaultRoot)
        const state = readBackupState(vaultRoot)
        const newest = files[0] || null
        // 「上次成功备份时间」优先状态文件（那是真备份成功的时刻），没有就退回最新备份文件的时间
        const lastAtMs = state.atMs || (newest ? newest.atMs : 0)
        const lastBackup = newest
          ? {
            name: newest.name,
            at: new Date(lastAtMs || newest.atMs).toISOString(),
            // 卡片数只有状态文件记得（备份自己那份清单）；其它来源的备份不去逐个开库数，如实给 null
            cards: state.name && state.name === newest.name ? state.cards : null,
            sizeMB: newest.sizeMB,
          }
          : null
        // nextAt 要落在**备份时间窗**里（默认次日 03:00），不是「上次 + 24h」——
        // 后者会显示成白天 10:57 这种「下次备份」，而实际窗口外根本不会动手。
        const { nextBackupAt } = await import('./backup-window.js')
        const nextAt = config.enabled
          ? new Date(nextBackupAt({ lastAt: lastAtMs, intervalHours: config.intervalHours, windowStart: config.windowStart }, Date.now())).toISOString()
          : null
        json(res, 200, {
          ok: true,
          config,
          lastBackup,
          backups: files.slice(0, 50).map((f) => ({ name: f.name, at: f.at, sizeMB: f.sizeMB })),
          nextAt,
          retentionDays: config.keepDays,
        })
        return
      }
      case '/backup/config': {
        // 容灾配置写入：非法值一律 400 + 可读原因（**不抛 500**，面板要能显示到底哪个值不对）
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
        const body = await readBody(req)
        const patch = {}
        const bad = []
        if (body && body.enabled !== undefined) {
          if (typeof body.enabled !== 'boolean') bad.push('enabled 需要布尔值')
          else patch.backupEnabled = body.enabled
        }
        if (body && body.autoRestore !== undefined) {
          if (typeof body.autoRestore !== 'boolean') bad.push('autoRestore 需要布尔值')
          else patch.backupAutoRestore = body.autoRestore
        }
        if (body && body.intervalHours !== undefined) {
          const n = typeof body.intervalHours === 'number' ? body.intervalHours : Number(body.intervalHours)
          if (body.intervalHours === '' || body.intervalHours === null || !Number.isFinite(n)) bad.push('intervalHours 需要数字')
          else if (n < 1 || n > 24 * 365) bad.push('intervalHours 需要 1-' + (24 * 365) + '，当前 ' + n)
          else patch.backupIntervalHours = Math.floor(n)
        }
        if (body && body.keepDays !== undefined) {
          const n = typeof body.keepDays === 'number' ? body.keepDays : Number(body.keepDays)
          if (body.keepDays === '' || body.keepDays === null || !Number.isFinite(n)) bad.push('keepDays 需要数字')
          else if (n < 1 || n > 3650) bad.push('keepDays 需要 1-3650，当前 ' + n)
          else patch.backupKeepDays = Math.floor(n)
        }
        if (bad.length) return json(res, 400, { ok: false, error: '字段值不合法：' + bad.join('、'), fields: bad })
        if (!Object.keys(patch).length) {
          return json(res, 400, { ok: false, error: '没有可写入的字段（enabled / intervalHours / keepDays / autoRestore）' })
        }
        try {
          const wrote = await persistConfigPatch(patch)
          json(res, 200, { ok: true, config: disasterConfig(), applied: Object.keys(patch), mode: wrote.mode })
        } catch (e) {
          // 写配置失败是**可解释的业务错误**（宿主守卫 / 只读配置），不是服务器崩了
          json(res, 400, { ok: false, error: '容灾配置写入失败：' + String((e && e.message) || e) })
        }
        return
      }
      default:
        json(res, 404, { ok: false, error: '未知接口' })
    }
  }

  /**
   * 对外入口：把**任何**未预判到的数据库故障翻译成可读的 503（issue #33）。
   * 入口处的 DB_WRITE_ROUTES 已覆盖主要写路由，这里兜住剩下的（不同接口各自吐
   * `attempt to write a readonly database` 原文对用户毫无意义），并带上恢复指引。
   */
  return async function handleApi(req, res) {
    const routePath = (() => { try { return new URL(req.url, 'http://localhost').pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/overview' } catch { return '' } })()
    const isWriteRoute = DB_WRITE_ROUTES.test(routePath)
    try {
      // 写路由：撞锁（SQLITE_BUSY / database is locked）做**应用层异步重试** ——
      // 不阻塞事件循环（`busy_timeout` 是同步忙等，评审已否），且只在**还没发出响应**时重试，
      // 避免重复写；SQLite 在 BUSY 时事务已回滚，重试是安全的。
      if (isWriteRoute) {
        return await withDbRetry(async () => {
          try { return await dispatch(req, res) } catch (e) {
            // 响应已经发出（writeHead 过了）→ 不能再重试，否则可能写两遍
            if (res && res.headersSent) { e.noRetry = true; throw e }
            throw e
          }
        }, { tries: 3, delayMs: 120 })
      }
      return await dispatch(req, res)
    } catch (e) {
      const msg = String((e && e.message) || e)
      // 请求体超限（H2）：所有 readBody/readBodyText 的抛错统一在这里落成 413
      if (e && e.code === 'PAYLOAD_TOO_LARGE') {
        if (!res.headersSent) {
          return json(res, 413, { ok: false, code: 'payload_too_large', error: msg, maxBytes: e.maxBytes || MAX_BODY_BYTES })
        }
        return
      }
      if (/readonly|read-only|只读|database is locked|malformed|not a database/i.test(msg)) {
        const st = dbStatus(vaultDir()) || { writable: false, error: msg }
        return json(res, 503, {
          ok: false,
          code: 'DB_UNAVAILABLE',
          error: '记忆库当前不可用：' + msg + '（配置仍可保存）',
          db: st,
          guidance: rebuildGuidance(vaultDir(), st),
        })
      }
      // 非数据库故障：**原样抛**，保持「业务错误由调用方处理」的既有契约
      // （宿主有外层 try/catch，测试也用它来判断"请求是否真的走到了业务逻辑"）
      throw e
    }
  }
}

/**
 * 分层接口的错误 → HTTP 响应（纯函数，便于单测）。
 *   LEVEL_PATH / LEVEL_STALE：客户端可以自己纠正（路径写错 / 卡片增删让簇 id 过期）→ 400 + 原文案；
 *   其他未知异常：500 + 通用文案，**内部细节只写服务端日志**，不回给浏览器。
 * 无论哪种，客户端都会显示「显式报错 + 保留当前层 + 重试」。
 */
export function levelErrorResponse(err, context = '') {
  const code = err && err.code
  if (code === LEVEL_ERR_PATH || code === LEVEL_ERR_STALE) {
    return {
      status: 400,
      body: { ok: false, code, error: String((err && err.message) || err) },
    }
  }
  try {
    console.error('[memory-eternal] /graph/level 内部错误' + (context ? '（' + context + '）' : '') + '：', err)
  } catch { /* console 不可用时彻底静默（日志失败不能反过来影响响应） */ }
  return {
    status: 500,
    body: { ok: false, code: 'LEVEL_FAILED', error: '知识图谱层级暂时不可用，请稍后重试' },
  }
}

export function json(res, status, body) {
  const payload = JSON.stringify(body)
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Accept-Encoding',
    // 安全响应头：API 响应也带上（nosniff 让浏览器不猜类型，其余是兜底）
    ...SECURITY_HEADERS,
  }
  const { body: out, encoding } = encodeBody(res, Buffer.from(payload, 'utf8'))
  if (encoding) headers['Content-Encoding'] = encoding
  headers['Content-Length'] = out.length
  res.writeHead(status, headers)
  res.end(out)
}

/** 请求方的 Accept-Encoding（`res.req` 由 Node 的 http server 挂上；取不到当不支持）。 */
export function acceptEncoding(res) {
  try {
    const req = res && (res.req || res.__meReq)
    return String((req && req.headers && req.headers['accept-encoding']) || '').toLowerCase()
  } catch { return '' }
}

/** 请求方是否接受 gzip。 */
export function acceptsGzip(res) {
  return acceptEncoding(res).includes('gzip')
}

/**
 * 协商压缩大响应体：
 * - 支持 brotli 就优先 br（质量 4 = 在线压缩的速度/体积平衡点，比 gzip 再小约 30%）
 * - 否则退 gzip
 * - 都不支持、体积太小、或压完反而更大 → 明文
 */
export function encodeBody(res, buf) {
  if (buf.length <= 2048) return { body: buf, encoding: '' }
  const ae = acceptEncoding(res)
  const wantBr = /(^|[,\s])br($|[,\s;])/.test(ae)
  const wantGzip = ae.includes('gzip')
  // 大响应体同时压 br + gzip 取更小的那个：br q5 在图谱这种高重复 JSON 上比 gzip 小 35%，
  // 但在高熵的 JS/小 JSON 上偶尔略大 —— 取小者保证永不劣化（成本仅几毫秒）。
  if (buf.length >= 16 * 1024) {
    let br = null
    if (wantBr) {
      try { br = brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length } }) } catch { br = null }
    }
    let gz = null
    if (wantGzip) { try { gz = gzipSync(buf) } catch { gz = null } }
    const best = [br && { body: br, encoding: 'br' }, gz && { body: gz, encoding: 'gzip' }]
      .filter(Boolean)
      .filter((x) => x.body.length < buf.length)
      .sort((a, b) => a.body.length - b.body.length)[0]
    if (best) return best
    return { body: buf, encoding: '' }
  }
  if (wantBr) {
    try {
      const out = brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
      if (out.length < buf.length) return { body: out, encoding: 'br' }
    } catch { /* 落到 gzip */ }
  }
  if (wantGzip) {
    const out = gzipSync(buf)
    if (out.length < buf.length) return { body: out, encoding: 'gzip' }
  }
  return { body: buf, encoding: '' }
}

// ── 请求体读取（审计 H2）─────────────────────────────────────────────────────
//
// 旧实现有三套：`readBody` **完全没有上限**、cloud-server 自己写的 8MB、
// `/import` 的 16MB 循环。而 `readBody` 被 30+ 个路由使用，云端模式下它们跑在
// **同一个服务进程**里 —— 一个租户 POST 一个几 GB 的 body 就能把进程内存打满，
// 影响的是所有租户。这里收敛成唯一实现 + 唯一口径。

/** 默认请求体上限：2MB（写卡、改配置、批量操作都远小于它）。 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024
/** 大体积上传（整库 base64 导入 / 整库卡片上传）的上限：256MB。 */
export const LARGE_BODY_BYTES = 256 * 1024 * 1024

/** 按路由给上限：只有明确需要大体积的几条才放宽，其余一律 2MB。 */
const BODY_LIMITS = new Map([
  ['/backup/import', LARGE_BODY_BYTES],      // base64 整库上传
  ['/vaults/import-into', LARGE_BODY_BYTES], // 整库卡片批量写进另一库
  ['/import', MAX_CHUNK_BYTES],              // 与分片导入的既有承诺保持一致（16MB / 片）
  ['/import/chunk', MAX_CHUNK_BYTES],
])

/** 某条路由的 body 上限（未注册 = MAX_BODY_BYTES）。 */
export function bodyLimitFor(route) {
  return BODY_LIMITS.get(String(route || '')) || MAX_BODY_BYTES
}

const bodyTooLarge = (maxBytes) => {
  const err = new Error('请求体过大（上限 ' + Math.max(1, Math.round(maxBytes / 1024 / 1024)) + 'MB）')
  err.code = 'PAYLOAD_TOO_LARGE'
  err.status = 413
  err.maxBytes = maxBytes
  return err
}

/**
 * 把请求体读成 Buffer：声明长度超限**立刻**拒绝，流式读取超限也立刻拒绝并销毁请求。
 * 抛出的错误 `code = 'PAYLOAD_TOO_LARGE'`，调用方转 413。
 *
 * 同时吃两种 req 形状：真实 `IncomingMessage`（async iterable）与只实现了 `on()` 的单测桩
 * —— 后者以前会让「云端管理面」读不到 body，现在统一走这里，两个形状行为一致。
 */
async function readBodyBuffer(req, maxBytes) {
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : MAX_BODY_BYTES
  const headers = (req && req.headers) || {}
  // ① Content-Length 预检：声明就超了，不必先读进内存
  const declared = Number(headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    try { if (typeof req.destroy === 'function') req.destroy() } catch { /* 忽略 */ }
    throw bodyTooLarge(limit)
  }
  // ② 流式累加：不信 Content-Length（可能缺失或撒谎），边读边数
  const chunks = []
  let total = 0
  const take = (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buf.length
    if (total > limit) {
      try { if (typeof req.destroy === 'function') req.destroy() } catch { /* 忽略 */ }
      throw bodyTooLarge(limit)
    }
    chunks.push(buf)
  }
  if (req && typeof req[Symbol.asyncIterator] === 'function') {
    for await (const chunk of req) take(chunk)
  } else if (req && typeof req.on === 'function') {
    // 事件式 req（单测桩 / 老式流）：同样按字节计数，超限即收口
    await new Promise((resolve, reject) => {
      let done = false
      const finish = (fn, v) => { if (done) return; done = true; fn(v) }
      req.on('data', (c) => {
        try { take(c) } catch (e) { finish(reject, e) }
      })
      req.on('end', () => finish(resolve))
      req.on('error', () => finish(resolve))
      req.on('close', () => finish(resolve))
    })
  } else {
    return Buffer.alloc(0)
  }
  return Buffer.concat(chunks)
}

/**
 * 读请求体（POST body），返回解析后的 JSON 对象或空。
 * @param {object} req
 * @param {{maxBytes?: number}} [opts] 上限，缺省 MAX_BODY_BYTES
 * @throws 超限时抛 `code==='PAYLOAD_TOO_LARGE'`（调用方/外层统一转 413）
 */
export async function readBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  let buf
  try {
    buf = await readBodyBuffer(req, maxBytes)
  } catch (e) {
    if (e && e.code === 'PAYLOAD_TOO_LARGE') throw e
    return {}   // 请求体不是可迭代流（单测桩）/ 读流出错：仍按空 body 处理（既有契约）
  }
  const raw = buf.toString('utf8')
  try { return raw ? JSON.parse(raw) : {} } catch { return {} }
}

/**
 * 读请求体成**原始字符串**（需要自己决定「JSON 解析失败」怎么回答的路由用，例如 /import）。
 * 超限同样抛 `PAYLOAD_TOO_LARGE`；其它读错返回空串。
 */
export async function readBodyText(req, { maxBytes = MAX_BODY_BYTES } = {}) {
  try {
    return (await readBodyBuffer(req, maxBytes)).toString('utf8')
  } catch (e) {
    if (e && e.code === 'PAYLOAD_TOO_LARGE') throw e
    return ''
  }
}

// ── 统一安全响应头（审计 M1）────────────────────────────────────────────────
//
// 为什么要有：云端令牌明文放在 localStorage（见 src/client/index.tsx 的说明），
// 任何一次同源脚本注入都能直取 ---- 而当时全站**零安全响应头**，连兜底都没有。
//
// frame-ancestors 里额外放行 `dsh-app:`：DSH 桌面端用自定义协议（Electron 渲染进程
// 的页面 origin 是 `dsh-app://app`）把本页嵌进 iframe 当「记忆」面板，只写 'self'
// 会把主功能打死（页面直接拒载）。connect-src 放行 https 与任意本机端口：客户端页
// 要推数据到云端实例（https://…）也要连本地 7999。
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    // script-src 必须允许 inline：管理端（/api/admin/users 等）与云端控制台的交互脚本
    // 都是**服务端拼进 HTML 的内联 script**（用 nonce 需要改二十多处模板，收益不抵成本）。
    // 风险边界：这些页面只有管理员/登录用户能打开，且所有用户输入都经过 esc() 转义。
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
    "frame-ancestors 'self' dsh-app:",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; '),
}
