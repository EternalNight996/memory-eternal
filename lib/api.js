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
import { spawn } from 'node:child_process'
import { listCards, countCards, readCard, search, searchAll, graph, graphAll, overview, exportCards, deleteCard, writeCard, parseCard, stats, optimizeCandidates, optimizeApply, addFeedback, dailyCounts, mergeCards, ensureVault, auditQueue, recycleList, purgeExpired, setCardStatus, setCardKind, restoreCard, mainStoreBodies } from './vault.js'
import { compressExcerpt, guessRawKind, DEFAULT_CAPTURE_MAX_TOKENS } from './capture.js'
import { buildDiagnostics } from './feedback.js'
import { getSetupStatus, runSetup, mcpAgentAction } from './setup.js'
import { ledgerSummary } from './ledger.js'
import { backupDb, dbStatus, rebuildGuidance, withDbRetry } from './db.js'
import { createHub } from './sse.js'
import { probeServedVersion, restartResident, currentPkgVersion, readWatchdogLock, isPidAlive, probeLockWritable } from './watchdog.js'

// 独立 web 的 SSE 中心：配置/数据变更即时推给已打开的页面（无需手动刷新）
const hub = createHub()
/** 供 lib/web.js 在检测到共享配置变化时广播。 */
export function broadcast(event, data) { return hub.broadcast(event, data) }

export const API_PREFIX = '/memory-eternal/api'

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
function openExternalUrl(raw) {
  let u
  try { u = new URL(String(raw || '')) } catch { return { ok: false, error: 'bad url' } }
  const allowed = u.protocol === 'https:' && u.hostname === 'github.com' && u.pathname.startsWith('/EternalNight996/memory-eternal')
  if (!allowed) return { ok: false, error: 'url not allowed' }
  return spawnOpener(u.href)
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
 * 跨站写入防护：状态变更请求（非 GET/HEAD/OPTIONS）必须与请求自身的 Host **同源**。
 *
 * 为什么需要：插件 API 没有鉴权（本机任意页面都能 POST /config、/audit/approve、/write…）。
 * 浏览器发起跨站请求时**一定**会带 `Origin`，而我们的页面（DSH 设置页/记忆页 = 宿主同源、
 * 独立页 = 自己的 127.0.0.1:7999）带的 Origin 与 Host 同源 —— 于是「比对 Origin 与 Host」
 * 就能挡住恶意网页，同时不误伤局域网访问（LAN 下两者是同源的 192.168.x.x:port）。
 * 非浏览器调用（curl / CLI / MCP / 内部调用）没有 Origin，照常放行。
 *
 * @returns {string} '' = 放行；否则是给人看的原因（调用方回 403）
 */
export function crossOriginError(req) {
  const method = String((req && req.method) || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return ''
  const headers = (req && req.headers) || {}
  const origin = String(headers.origin || '').trim()
  if (!origin || origin === 'null') return ''   // 非浏览器调用 / file:// 页面：没有可比对的 Origin
  let parsed = null
  try { parsed = new URL(origin) } catch { return 'Origin 头不合法：' + origin }
  // 只有 http(s) 的 Origin 可能是**网页**；桌面壳的自定义 scheme（app:// 等）网页伪造不出来，放行
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  const originHost = parsed.host
  const host = String(headers.host || '').trim()
  if (!host) return ''                          // 拿不到 Host 就无法比对，放行（宁可不误伤）
  if (originHost === host) return ''
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
const DB_WRITE_ROUTES = /^\/(delete|merge|write|import|refine-apply|refine-goals-keep|refine-junk-purge|optimize-execute|feedback|audit\/(approve|reject)|recycle\/(restore|purge|purge-expired)|backup)$/

export function createApi(deps = {}) {
  const vaultDir = deps.vaultDir ?? (() => '')
  const vaultRoots = deps.vaultRoots ?? (() => [{ name: '', root: vaultDir() }])
  const getSettings = deps.getSettings ?? (() => ({}))
  // DSH 宿主信息（独立 web server 无 DSH 环境时为 null）。head DSH 状态行用。
  const getDshInfo = deps.getDshInfo ?? (() => null)
  // 自动沉淀运行轨迹（最新在前）+ 健康状态（异常时 UI 顶部亮红）。
  const getCaptureLog = deps.getCaptureLog ?? (() => null)
  const getCaptureHealth = deps.getCaptureHealth ?? (() => null)
  // 矛盾扫描（issue #36）要用模型：宿主把 ctx.get('llm') 传进来；独立 web 进程拿不到就如实报错
  const getLlm = deps.getLlm ?? (() => null)
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

  const dispatch = async function handleApi(req, res) {
    // 状态变更请求先过同源闸门（见 crossOriginError）：无鉴权的本机 API 不能让任意网页写配置
    const crossOrigin = crossOriginError(req)
    if (crossOrigin) return json(res, 403, { ok: false, error: crossOrigin, code: 'CROSS_ORIGIN_BLOCKED' })
    const vaultRoot = vaultDir()
    const url = new URL(req.url, 'http://localhost')
    const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/overview'
    const query = url.searchParams
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
      case '/overview': {
        // version = **当前正在服务这个端口的进程**加载的包版本（issue #23）：
        // 磁盘上升级了、端口上跑的还是旧进程时，只有这个字段说得清真相（锁文件里的
        // pkgVersion 是 watchdog 自己写的，与端口上真正服务的代码无关）。
        const servingVersion = (getDshInfo() || {}).version || process.env.MEMORY_ETERNAL_VERSION || ''
        const degraded = (error) => {
          // #33：库/目录不可用时**不再吐 500**。500 会被上层（探针、面板、脚本）读成
          // 「这个端口坏了 / 不是我们的服务」，历史上就是这么引出重启风暴与端口漂移的。
          // 降级成 200 + degraded 标记，身份字段（vaultDir/version）照旧带上 ——
          // 「这是我们、但库有问题」从此可以被分开表达，用户也能看到真实原因。
          const status = { writable: false, error: String(error), ...(dbStatus(vaultRoot) || {}) }
          json(res, 200, {
            ok: true, degraded: true, vaultDir: vaultRoot, version: servingVersion,
            total: 0, byKind: {}, roots: {}, db: status, dbError: status.error,
            guidance: rebuildGuidance(vaultRoot, status),
          })
        }
        try { await ensureVault(vaultRoot) } catch (e) { return degraded((e && e.message) || e) }
        let data
        try { data = await overview(vaultRoot) } catch (e) { return degraded((e && e.message) || e) }
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
        json(res, 200, {
          ok: true,
          vaultDir: vaultRoot,
          version: servingVersion,
          db: dbStatus(vaultRoot),
          backups,
          ...data,
        })
        return
      }
      case '/cards': {
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
        const KNOWN_STATUS = ['all', 'approved', 'pending', 'rejected', 'deleted']
        const want = status === 'all' ? ['approved', 'pending', 'rejected']
          : status === 'pending' ? ['pending']
          : status === 'rejected' ? ['rejected']
          : status === 'deleted' ? ['deleted']
          : ['approved']
        // issue #22：unknown status 以前被静默当成 approved，调用方拿到「看起来正常」的主库内容
        // 却无从察觉（total 与 /recycle/list 打架就是这么来的）。这里回显**实际生效**的 status，
        // 并对无法识别的取值显式置 unknownStatus:true —— 回落行为保留（不破坏老调用方），但不再沉默。
        const appliedStatus = status === 'all' ? 'all'
          : status === 'pending' ? 'pending'
          : status === 'rejected' ? 'rejected'
          : status === 'deleted' ? 'deleted'
          : 'approved'
        const unknownStatus = !KNOWN_STATUS.includes(status)
        // issue #46 后的界面改进：标签筛选（点芯片即筛）。与搜索可叠加。
        const tag = (query.get('tag') || '').trim()
        if (q.trim()) {
          // 检索是相关性排序：先把命中集合取齐，再在内存里分页（保证 total 与顺序一致）
          const hits = await search(vaultRoot, q, { limit: 500 })
          const hitPaths = new Set(hits.map((h) => h.path))
          let cards = (await listCards(vaultRoot, { status: want, kind, agent, tag })).filter((c) => hitPaths.has(c.path))
          const total = cards.length
          json(res, 200, { ok: true, cards: cards.slice(offset, offset + limit), total, offset, limit, appliedStatus, requestedStatus: status, unknownStatus })
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
      case '/search': {
        const q = query.get('q') || ''
        if (!q.trim()) return json(res, 200, { ok: true, hits: [] })
        const all = query.get('all') === '1'
        const semantic = query.get('semantic') === '1'
        let hits
        try { hits = all ? await searchAll(vaultRoots(), q, { limit: 30, semantic }) : await search(vaultRoot, q, { limit: 30, semantic }) }
        catch (e) { hits = await search(vaultRoot, q, { limit: 30, semantic }) }
        json(res, 200, { ok: true, hits })
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
        // 与 /version-check 同一条闸门（#45）：问自己等于开一条递归链 —— 本进程就是那个常驻实例，
        // 直接用自己的版本作答。
        const served = Number(port) === Number(selfPort())
          ? String(loaded || expect || '')
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
        return json(res, 200, openExternalUrl(query.get('url')))
      }
      case '/open-web': {
        // 左侧栏「Web 版」：用系统默认浏览器打开本机独立 Web UI。
        // 只允许 127.0.0.1/localhost/::1，避免这个无鉴权端点变成任意 URL 打开器。
        if (req.method && req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
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
          cards: countsD ? countsD.total : undefined,
          health: healthD,
          captureLog: logD,
          maxTokens: undefined,
        }, homeD)
        json(res, 200, { ok: true, diagnostics: text, repo: 'EternalNight996/memory-eternal', version: (dshD && dshD.version) || envD.MEMORY_ETERNAL_VERSION || '' })
        return
      }
      case '/graph': {
        await ensureVault(vaultRoot)
        const all = query.get('all') === '1'
        let g
        try { g = all ? await graphAll(vaultRoots()) : await graph(vaultRoot) }
        catch (e) { g = await graph(vaultRoot) }
        json(res, 200, { ok: true, ...g })
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
      case '/export': {
        await ensureVault(vaultRoot)
        const cards = await exportCards(vaultRoot)
        // 带上信封元信息：客户端可以直接把整个响应体当备份文件落下（见 /import 的兼容读取）。
        json(res, 200, { ok: true, format: 'memory-eternal-vault', formatVersion: 1, exportedAt: new Date().toISOString(), count: cards.length, cards })
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
        await setCardStatus(vaultRoot, rel, 'approved')
        if (kind === 'core' || kind === 'knowledge') await setCardKind(vaultRoot, rel, kind)
        json(res, 200, { ok: true, path: rel, status: 'approved', kind: kind || undefined })
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
        const days = Number(query.get('days')) || 30
        const r = await purgeExpired(vaultRoot, days)
        json(res, 200, r)
        return
      }
      case '/write': {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const raw = Buffer.concat(chunks).toString('utf8')
        let body
        try { body = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        if (!body.body) return json(res, 400, { ok: false, error: '缺少正文' })
        await ensureVault(vaultRoot)
        const r = await writeCard(vaultRoot, { kind: body.kind || 'knowledge', title: body.title || '无标题', tags: body.tags || [], body: body.body, source: body.source || 'manual', status: 'pending', submittedBy: body.source || 'manual', severity: body.severity || 'info', reason: body.reason || '手动创建' }, { dedup: false })
        json(res, 200, r)
        return
      }
      case '/import': {
        const importChunks = []
        for await (const chunk of req) importChunks.push(chunk)
        const raw = Buffer.concat(importChunks).toString('utf8')
        if (raw.length > 20 * 1024 * 1024) return json(res, 413, { ok: false, error: '文件过大' })
        let payload
        try { payload = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        // 兼容两种备份形状：
        //   ① 顶层就是卡片数组 —— v0.10.0 及以前「导出JSON」写出的 memory-vault.json；
        //   ② 带信封的对象 { format, formatVersion, exportedAt, count, cards: [...] } —— v0.10.1 起。
        // 旧实现只认 payload.cards，于是①被静默当成空备份（imported=0 / skipped=0 / ok=true，
        // UI 只显示「导入完成：0」，看不出是格式不匹配）—— 这是 issue「导出 OK 导入 0 张」的根因。
        const list = Array.isArray(payload) ? payload
          : Array.isArray(payload?.cards) ? payload.cards
          : null
        if (!list) return json(res, 400, { ok: false, error: '文件格式无法识别：应为卡片数组，或含 cards 数组的备份对象（请用本插件「导出JSON」生成的文件）' })
        if (!list.length) return json(res, 200, { ok: true, imported: 0, skipped: 0, quarantined: 0, total: 0, failed: [], warning: '文件里没有任何卡片' })
        // 去重基线取「导入前已存在的主库卡」快照：备份里的近似卡不能在同一批里互相吞掉。
        const baseline = await mainStoreBodies(vaultRoot)
        let imported = 0, skipped = 0, quarantined = 0
        const failed = []
        for (const c of list) {
          if (!c || typeof c !== 'object') { skipped++; failed.push({ reason: '条目不是对象' }); continue }
          const text = c.text || ''
          let kind = c.kind || 'knowledge', title = c.title || '导入记忆', tags = [], body = text, source = '', status = c.status || 'pending', deletedAt = c.deletedAt || ''
          try { const p = parseCard(text); kind = p.meta.kind || kind; title = p.meta.title || title; tags = p.meta.tags || tags; body = p.body; source = p.meta.source || source; status = p.meta.status || status; deletedAt = p.meta.deletedAt || deletedAt } catch {}
          if (!String(body || '').trim()) { skipped++; failed.push({ path: c.path || '', title: String(title).slice(0, 80), reason: '正文为空' }); continue }
          // 两套存储：导入按导出时的状态回填（备份/迁移才完整），但仍过 enforceAudit 这道闸门 ——
          // 校验不过的会被写成 pending 进隔离区，主库永远不会被导入数据绕过。
          const r = await writeCard(vaultRoot, { kind, title, tags, body, source, status, deletedAt }, { dedupAgainst: baseline })
          if (r.ok) { imported++; if (r.store === 'quarantine') quarantined++ }
          else { skipped++; failed.push({ path: c.path || '', title: String(title).slice(0, 80), reason: r.duplicate ? '已存在（内容重复）' : (r.error || '写入被拒') }) }
        }
        json(res, 200, { ok: true, imported, skipped, quarantined, total: list.length, failed: failed.slice(0, 50) })
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
      case '/optimize-execute': {
        // 一键优化执行：合并相似卡 + 可选清理陈旧卡。POST body: {cleanupStale?, simThreshold?, staleDays?, dryRun?}
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: '需 POST' }); return }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let opts = {}
        try { opts = JSON.parse(raw || '{}') } catch { opts = {} }
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
        let opts = {}
        try { let raw = ''; for await (const chunk of req) raw += chunk; opts = JSON.parse(raw || '{}') } catch { opts = {} }
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
        let payload = {}
        try { let raw = ''; for await (const chunk of req) raw += chunk; payload = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        const out = await refineApply(vaultRoot, payload)
        json(res, out.ok ? 200 : 400, out)
        return
      }
      case '/refine-goals': {
        // 「同目标、不同做法」聚类（#36 第三块）：先让模型给每张卡抽一句「解决什么问题」（带缓存），
        // 再按**目标**聚类 —— 正文相似度抓不到这种关系（7z 压缩 / tar 分发 / npm 瘦身 字面差很远）。
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: '需 POST' }); return }
        const { goalScan } = await import('./refine.js')
        let opts = {}
        try { let raw = ''; for await (const chunk of req) raw += chunk; opts = JSON.parse(raw || '{}') } catch { opts = {} }
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
        let payload = {}
        try { let raw = ''; for await (const chunk of req) raw += chunk; payload = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        const out = await markClusterKept(vaultRoot, payload)
        json(res, out.ok ? 200 : 400, out)
        return
      }
      case '/llm-routes': {
        // issue #42 需求 1：把可选的 provider / model 动态列出来（面板用它渲染下拉，不再手填编号）。
        const llm = getLlm()
        // 独立页没有 llm 服务 → 代理给宿主（宿主心跳里有它的端口）
        if (!llm) { json(res, 200, await proxyHost('/memory-eternal/api/llm-routes')); return }
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
        // 先读 body：本地调用与代理都要用
        let rawBody = ''
        try { for await (const chunk of req) rawBody += chunk } catch { rawBody = '' }
        const llm = getLlm()
        if (!llm) {
          // 独立页（桌面版弹窗 iframe）没有 llm：转给宿主真打一次，返回同样的结构
          json(res, 200, await proxyHost('/memory-eternal/api/llm-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody || '{}' }))
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
        let payload = {}
        try { let raw = ''; for await (const chunk of req) raw += chunk; payload = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
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
        try {
          let raw = ''
          for await (const chunk of req) raw += chunk
          const body = JSON.parse(raw || '{}')
          const out = await mcpAgentAction(String(body.agent || ''), String(body.action || ''), { log: () => {} })
          json(res, 200, out)
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message || e) }) }
        return
      }
      case '/setup-status': {
        // 只读查询各 agent MCP 配置状态，不写任何文件
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
        const fbChunks = []
        for await (const chunk of req) fbChunks.push(chunk)
        const raw = Buffer.concat(fbChunks).toString('utf8')
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
          autoCapture: cfg.autoCapture ?? true, autoRecall: cfg.autoRecall ?? true, coreMemoryEnabled: cfg.coreMemoryEnabled ?? true, coreMemoryLimit: cfg.coreMemoryLimit ?? 6, coreMemoryMaxChars: cfg.coreMemoryMaxChars ?? 2000, recallLimit: cfg.recallLimit ?? 5, recallSummaryLen: cfg.recallSummaryLen ?? 130, recallIncludeBody: cfg.recallIncludeBody ?? false, secretHint: cfg.secretHint || '',
          captureMinChars: cfg.captureMinChars ?? 200, captureCooldownMs: cfg.captureCooldownMs ?? 300000, dedupThreshold: cfg.dedupThreshold ?? 0.62, maxCardsPerDay: cfg.maxCardsPerDay ?? 60,
          distillEnabled: cfg.distillEnabled ?? true, dedupByLLM: cfg.dedupByLLM ?? true, captureMaxTokens: cfg.captureMaxTokens ?? DEFAULT_CAPTURE_MAX_TOKENS, recallMinScore: cfg.recallMinScore ?? 2,
          autoWeb: cfg.autoWeb ?? env.MEMORY_AUTO_WEB !== '0', autoWebMode: cfg.autoWebMode || 'init', webPort: Number(cfg.webPort) || Number(env.MEMORY_WEB_PORT) || 7999, webCheckIntervalMs: Number(cfg.webCheckIntervalMs) || 5000, webMaxRestart: Number(cfg.webMaxRestart) || 10, watchdogAutoSpawn: cfg.watchdogAutoSpawn ?? env.MEMORY_WATCHDOG === '1', autoRestartOnDrift: cfg.autoRestartOnDrift ?? true, autoMcpSetup: cfg.autoMcpSetup ?? false,
          auditMode: cfg.auditMode ?? 'all', auditExemptAgents: cfg.auditExemptAgents ?? [], auditExemptKinds: cfg.auditExemptKinds ?? [], recycleRetentionDays: cfg.recycleRetentionDays ?? 30,
          vaultProfiles: Array.isArray(cfg.vaultProfiles) ? cfg.vaultProfiles : [], activeVault: cfg.activeVault || '',
          enabled: cfg.enabled !== false, vaultDir: cfg.vaultDir || '', captureProvider: cfg.captureProvider || '', captureFollowSession: cfg.captureFollowSession === true, captureFirstOnly: cfg.captureFirstOnly === true, captureTimeoutMs: cfg.captureTimeoutMs ?? 45000,
          captureModel: cfg.captureModel || '', recallEmbedding: cfg.recallEmbedding || '', sessionBudgetChars: cfg.sessionBudgetChars ?? 80000,
          webPort: cfg.webPort ?? 7999, webCheckIntervalMs: cfg.webCheckIntervalMs ?? 5000, webMaxRestart: cfg.webMaxRestart ?? 10,
        }
        const NUM_RANGE = {
          dedupThreshold: [0, 1], captureMinChars: [0, 1000000], captureCooldownMs: [0, 1000000000],
          maxCardsPerDay: [0, 1000000], captureMaxTokens: [100, 4000], recallMinScore: [0, 50],
          recallLimit: [1, 20], recallSummaryLen: [40, 400], recycleRetentionDays: [1, 3650],
          webPort: [1, 65535], webCheckIntervalMs: [1000, 600000], webMaxRestart: [1, 1000],
          sessionBudgetChars: [0, 1000000000],
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
          const aliveHost = hostAlive(process.env) ? readHostMarker(process.env) : null
          if (aliveHost && aliveHost.port && aliveHost.token) {
            const call = await triggerHostDrain({ port: aliveHost.port, token: aliveHost.token, timeoutMs: 2500 })
            if (call.ok) outcome = 'applied'
            else if (call.status === 404 || call.status === 405 || call.status === 0) hostDrainError = call.error || ''
            else { outcome = 'failed'; hostDrainError = call.error || '' }
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
          if (outcome === 'queued') {
            if (!hostAlive(process.env)) {
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
        const r = await backupDb(vaultRoot, { maxKeep: 7 })
        json(res, r.ok ? 200 : 500, r)
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

export function json(res, status, body) {
  const payload = JSON.stringify(body)
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Accept-Encoding',
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

/** 读请求体（POST body），返回解析后的 JSON 对象或空。 */
export async function readBody(req) {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
