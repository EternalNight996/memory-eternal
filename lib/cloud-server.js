// 多租户云端服务层：**按密钥把请求路由到各自的 SQLite 库**。
//
// 结构：
//   /memory-eternal/api/cloud/*        管理面（发密钥 / 列密钥 / 吊销 / MengBot 登录 / 配置），不需要租户
//   /memory-eternal/api/<其它>         业务面：先解析 Authorization → 选中该租户的 vault → 交给它自己的 api 实例
//
// 为什么每个租户一个 `createApi` 实例：`createApi` 的 vault 是构造期注入的闭包，
// 而它内部缓存了 embedJobs / probeCache / 类型缓存等**按库隔离**的状态 ——
// 复用同一个实例会把不同人的状态串在一起。一个租户一个实例，物理隔离最省心。

import { createApi, API_PREFIX, readBody as readBodyLimited, MAX_BODY_BYTES, SECURITY_HEADERS } from './api.js'
import { statSync, createReadStream, existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { loginPage, adminPage, usersPage, issueSession, verifySession, readCookie, setCookie, COOKIE_ADMIN, COOKIE_USER } from './cloud-admin-ui.js'
import { userLoginPage, registerPage, authorizePage, accountPage } from './cloud-user-login.js'
import { LOGIN_JS, AUTHORIZE_JS } from './cloud-login-client.js'
// 控制面（PG）：账号 / 身份 / 会话 / 审计。DATABASE_URL 没配时这些函数不可用，服务端仍可跑。
import { ensureSchema, dbStatus } from './server-db.js'
import {
  loginWithPassword, createUser, issueSession as issueUserSession,
  resolveSession, revokeSession, listUsers, audit, normalizeEmail, isEmail,
  getUserById, listIdentities, upsertIdentity, setUserStatus, getUserDetail,
  lookupIdentity, passwordProblem,
} from './accounts.js'
import { resolveTenant, tenantVault, cloudRoot, keyStorePath, issueKey, listKeys, revokeKey, verifyMengbotLogin, publicCloudConfig, startMengbotAuth, completeMengbotAuth, issueSessionTokenForOwner, verifyAndCacheMbtToken, revokeSessionToken, readCookieFromHeader } from './cloud-auth.js'
import { licenseState, licenseSummary, allowedWhenReadonly } from './license.js'
import { resolveAccess, accessSummary } from './entitlement.js'
import crypto from 'node:crypto'
import { verifyWebhookSignature, applyWebhookEvent, webhookSecret, HEADERS } from './webhook.js'
import { readOidcConfig, oidcReady, buildAuthorizeUrl, rememberPkce, takePkce, completeOidcLogin, storeRefreshToken, storeAccessToken, discoverOidc, startDeviceAuth, pollDeviceToken, fetchUserInfo } from './oidc.js'
import { createCheckout, planView, resolvePayBase, cachedMarketPlans } from './billing.js'
import { quotaFor, createRateLimiter, checkCardQuota, quotaExceededBody } from './quota.js'
// LRU 淘汰时要把该租户的 SQLite 连接关掉。用**静态 import**（而不是 await import）：
// 异步关闭会留出「表里已删、连接还没关」的窗口，紧接着重建同租户就可能踩到刚被关的连接。
import { closeDb } from './db.js'
// 管理端要显示「每个租户多少张卡、几个库」—— 直接用库自己的统计与库列表，别在面板里另算一套。
import { stats as vaultStats } from './vault.js'
import { listOwnerVaults } from './cloud-vaults.js'

/** 服务端版本：优先调用方传入，其次读插件自己的 package.json（云端的 version 字段用于客户端兼容判断）。 */
const pkgVersion = (fallback = '') => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || fallback }
  catch { return fallback }
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,   // M1：云端响应也带 nosniff / CSP 兜底
  })
  res.end(body)
}

/**
 * 读 JSON body —— **统一走 lib/api.js 的 readBody**（审计 H2）。
 *
 * 这里原本自己实现了一份「字符串拼接 + 8MB 就 destroy」，与 api.js 的**无上限**版本、
 * `/import` 的 16MB 版本并存：三套口径、三种截断行为，出问题很难查。现在只有一份实现，
 * 上限统一（默认 2MB），超限时 api 那边会抛 `PAYLOAD_TOO_LARGE`，这里保持旧的
 * 「读不到就 {}」契约（管理面对无效 body 的既有回应不变）。
 */
const readBody = (req, maxBytes = MAX_BODY_BYTES) =>
  readBodyLimited(req, { maxBytes }).catch(() => ({}))

/**
 * 会话 cookie（用于 web 端登录墙）。
 * HttpOnly：前端读不到，避免 XSS 偷走；Secure：只走 https；SameSite=Lax：回跳时能带上。
 */
const sessionCookie = (token, maxAgeSeconds = 7 * 24 * 3600) =>
  `me_cloud_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`

/** 清 cookie（登出）。 */
const clearSessionCookie = () => 'me_cloud_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'

/**
 * Webhook 需要**原始 body**（验签必须对原始字节算 HMAC，不能被 JSON 重排破坏）。
 *
 * 仍然单独实现（要的是原始串不是解析结果），但补上两个老问题：
 *   · 超限后 `req.destroy()` 会让 `end` 永不到来 → 原来的 Promise **永远不 resolve**，
 *     请求挂死；现在 destroy 的同时就收口；
 *   · 上限明确成参数（默认 8MB，webhook 事件远小于它）。
 */
const readRawBody = (req, maxBytes = 8 * 1024 * 1024) => new Promise((resolve) => {
  let d = ''
  let done = false
  const finish = (v) => { if (done) return; done = true; resolve(v) }
  req.on('data', (c) => {
    d += c
    if (d.length > maxBytes) {
      try { if (typeof req.destroy === 'function') req.destroy() } catch { /* 忽略 */ }
      finish('')
    }
  })
  req.on('end', () => finish(d))
  req.on('error', () => finish(''))
  req.on('close', () => finish(d))
})

/**
 * CORS：客户端界面（本地 web UI / DSH 内嵌页）与云端是**不同 origin**，
 * 没有 CORS 头浏览器会直接拦掉请求 —— 表现为「连接云端直接失败」、控制台报 CORS 错误。
 *
 * 白名单策略：
 *   · `MEMORY_CLOUD_CORS_ORIGINS`（逗号分隔）显式列出；写 `*` 表示回显任意 origin
 *   · 默认放行本机任意端口（http://127.0.0.1:* / localhost:* / [::1]:*）
 *   · 以及 `MEMORY_CLOUD_PUBLIC_URL`（自己的域名）
 *
 * 注意：带凭据（cookie）的跨域请求**不能用 `*`**，必须回显具体 origin + Allow-Credentials。
 */
export function corsOriginAllowed(origin, env = process.env) {
  const o = String(origin || '').trim()
  if (!o) return ''
  const list = String(env.MEMORY_CLOUD_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (list.includes('*')) return o
  if (list.includes(o)) return o
  const pub = String(env.MEMORY_CLOUD_PUBLIC_URL || '').trim().replace(/\/+$/, '')
  if (pub && o === pub) return o
  // 默认放行本机（客户端的本地页面、DSH 内嵌 iframe）
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(o)) return o
  // 'null'：file:// 页面、sandboxed iframe 的 Origin 是字面量 "null"。
  if (o === 'null') return 'null'
  // DSH 桌面端（Electron）的页面 origin 是 **dsh-app://app** —— 实测日志抓到的：
  //   [cloud-access] GET /cloud/health origin=dsh-app://app cors=DENY
  // 自定义协议不在 http(s) 判定里，不显式放行的话，桌面端所有云端请求都会失败，
  // 而浏览器只报 "Failed to fetch"（没有任何 HTTP 状态），完全无法自查。
  if (/^dsh-app:\/\//i.test(o)) return o
  return ''
}

/**
 * 校验回跳地址是否可信（防开放重定向）。
 *
 * 允许：① `dsh-app://` 自定义协议（DSH 桌面端）；
 *      ② http(s) 且 origin 在 CORS 白名单里（本机任意端口 / 本站域名 / 显式列表）。
 * 其余一律返回空串，由调用方回落到默认地址 —— **绝不把令牌送去白名单外的地方**。
 */
export function safeRedirectTarget(raw, env) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^dsh-app:\/\//i.test(s)) return s
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return corsOriginAllowed(u.origin, env) ? s : ''
  } catch {
    return ''
  }
}

/**
 * 商户套餐的 sku。
 *
 * MengBot 目前公布的套餐是 personal / pro / max —— **全是个人套餐**，没有商户档。
 * 商户套餐的正式 sku 还没定（已写进对对方的请求清单），这里用可配置项占位：
 *   MEMORY_MERCHANT_PLAN_SKU=sub-merchant
 * 对方给了正式 sku 后改环境变量即可，不用发版。
 */
/** 商户套餐可选档位（MengBot P2 正式 sku）。 */
const MERCHANT_SKUS = ['sub-merchant', 'sub-merchant-pro']

/**
 * 解析商户套餐 sku。
 * 优先级：显式传入 > 环境变量 MEMORY_MERCHANT_PLAN_SKU > 默认 sub-merchant。
 * 非法值一律回落默认并在日志里说一声 —— 拼错 sku 会让对方返回 unknown_plan，
 * 那种 400 在用户眼里只是「订阅失败」，很难排查。
 */
function merchantPlanSku(env = process.env, want = '') {
  const pick = String(want || env.MEMORY_MERCHANT_PLAN_SKU || 'sub-merchant').trim().toLowerCase()
  if (MERCHANT_SKUS.includes(pick)) return pick
  try { console.error('[merchant] 未知的商户 sku: ' + pick + '，回落 sub-merchant（可选 ' + MERCHANT_SKUS.join(' / ') + '）') } catch { /* 忽略 */ }
  return 'sub-merchant'
}

/** 当前请求的实例地址（推支付域用）：只取 Host，不信任 X-Forwarded-*。 */
export function reqCloudUrl(req) {
  const host = String((req && req.headers && req.headers.host) || '').trim()
  return host ? 'https://' + host : ''
}

/** 商户订阅商户套餐的支付深链（与个人订阅同一个 subscribe 页，只是 sku 不同）。 */
function merchantSubscribeUrl(merchantId, env = process.env, sku = '', cloudUrl = '') {
  const payBase = resolvePayBase({ env, cloudUrl })
  const params = new URLSearchParams({ sku: merchantPlanSku(env, sku), source: 'memory-eternal', merchant: String(merchantId || '') })
  return payBase + '/subscribe?' + params.toString()
}

/** HTML 转义（自定义协议回跳页里要嵌 owner/token，不能直接插）。 */
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const CORS_ALLOW_HEADERS = [
  'Authorization', 'Content-Type',
  'X-Admin-Token',
  'X-MengBot-Signature', 'X-MengBot-Event', 'X-MengBot-Event-Id', 'X-MengBot-Delivery-Id',
].join(',')

/** 给响应挂上 CORS 头（命中白名单时才挂）。 */
export function applyCors(req, res, env = process.env) {
  const allow = corsOriginAllowed(req.headers && req.headers.origin, env)
  if (!allow) return ''
  res.setHeader('Access-Control-Allow-Origin', allow)
  res.setHeader('Vary', 'Origin')
  // 'null' origin（file:// 等）不给 credentials —— 它没有可靠站点身份，
  // 允许带 cookie 等于任意本地文件都能复用登录态；令牌走 Authorization 头不受影响。
  if (allow !== 'null') res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS)
  res.setHeader('Access-Control-Expose-Headers', 'X-OIDC-Authorize-Endpoint')
  res.setHeader('Access-Control-Max-Age', '600')
  return allow
}

/**
 * @param {{env?:NodeJS.ProcessEnv, version?:string, onSettings?:()=>object}} opts
 * @returns {async (req, res) => boolean} 返回 true 表示已处理
 */
/** 设备码临时票据：ticket → { deviceCode, at, interval, expiresIn }。
 *  device_code 只在服务端留存，不发给浏览器 —— 它等价于「这次登录的取票凭证」，
 *  落在前端就等于把这半条登录链路交给页面。 */
const deviceTickets = new Map()
/**
 * PC 回跳取票仓。
 *
 * 为什么需要：桌面端页面 origin 是 dsh-app://app，而 **DSH 没有把 dsh-app:// 注册成系统协议**，
 * 浏览器跳过去只会弹「找不到应用」。所以把「浏览器里授权完」这件事拆成两步：
 *   ① 浏览器回跳我们的 callback → 服务端换好令牌 → 存进票仓（用户看到「已完成，请回到应用」）
 *   ② 应用侧轮询 /cloud/auth/poll 取走令牌
 * 效果与设备码一致，但 PC 上不用扫码/输码：点登录 → 浏览器授权 → 自动回应用完成。
 */
const pollTickets = new Map()

/**
 * 授权注册票：扫码/授权成功但本地**没有**该账号时签发。
 * 持有者可去 /register/authorize 补设一个密码完成注册（资料以 MengBot 为准，只读展示）。
 * 一次性、10 分钟；里面只放展示资料，**不放任何令牌**。
 */
const regTickets = new Map()

/** 从 OIDC state 解出发起方塞进去的 extraState（格式 <random>.<b64url(extra)>）。 */
function extraStateOf(state) {
  try {
    const parts = String(state || '').split('.')
    if (parts.length < 2) return ''
    return Buffer.from(parts[1], 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

/** 浏览器侧「已完成，请回到应用」页（poll 模式用，不显示任何令牌）。 */
function pollDonePageHtml(owner) {
  const who = owner ? String(owner).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])) : ''
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录已完成</title>
<style>
body{font:15px/1.75 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;max-width:640px;margin:56px auto;padding:0 22px;color:#1a1a1a;background:#fafafa}
.h{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700;margin-bottom:8px}
.ok{width:26px;height:26px;border-radius:50%;background:#16a34a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px}
p{color:#666;margin:8px 0}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:18px 20px;margin:20px 0}
.who{font-size:14px;color:#111;font-weight:600}
.tip{font-size:13px;color:#888;margin-top:10px}
</style></head><body>
<div class="h"><span class="ok">✓</span>登录已完成</div>
<p>浏览器这边已经完成授权。</p>
<div class="card">
  ${who ? `<div class="who">${who}</div>` : ''}
  <div class="tip">请回到 DeepSeek Harness 应用 —— 它会自动完成登录，无需在这里操作。这个页面可以直接关闭。</div>
</div>
</body></html>`
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}

export function createCloudServer({ env = process.env, version = '', onSettings = () => ({}) } = {}) {
  // 版本统一（客户端兼容判断用）：调用方没传就读 package.json
  const VERSION = version || pkgVersion('0.0.0')
  /**
   * owner → { handler, vaultRoot, lastUsed } 的 LRU 表。
   *
   * 为什么需要 LRU：每个 handler 背后是一套 SQLite 连接（db.js 里按路径缓存实例）。
   * 之前这张表**只增不减** —— 租户越多，打开的库句柄与内存越多，几百个租户就会把
   * 文件句柄吃干（Linux 默认 ulimit -n 1024）。淘汰时要把该库的连接关掉，否则只是
   * 换了张表、句柄照样泄漏。
   */
  const MAX_TENANTS = (() => {
    const n = Math.floor(Number(env.MEMORY_TENANT_LRU))
    return Number.isFinite(n) && n > 0 ? n : 32
  })()
  const tenants = new Map()

  /** 淘汰一个租户实例：关掉它的 SQLite 连接，再从表里删掉。
   *  参数是 **cacheKey**（`owner|vaultRoot`），不是单纯的 owner —— 多库后一行对应一个库。 */
  function evictTenant(cacheKey) {
    const rec = tenants.get(cacheKey)
    if (!rec) return
    tenants.delete(cacheKey)
    // closeDb 幂等：关掉后 getDb 会按需重建，所以不会让这个租户"永久坏掉"
    try { closeDb(rec.vaultRoot) } catch { /* 已经坏了就算了 */ }
  }

  // ── 热切库：租户的两个路径 ────────────────────────────────────────────────
  //
  // 云端实例里一个租户可能有好几个库（`/vaults/create` 建的命名库在 `<租户根>/vaults/<slug>/`）。
  // 要把「切库」做成热的，必须把**两个不同含义的路径**分开：
  //
  //   · tenantRoot —— **隔离边界**，永远是 `tenantVault(owner)`（`cloud-vaults/<owner>`）。
  //     pathScope 只能用它：同租户的兄弟库（vaults/<slug>/）因此可达，别人的租户目录一律越界。
  //     边界**绝不能跟着 activeRoot 收窄** —— 切到 vaults/work 后若边界也变成它，
  //     用户就再也切不回默认库、也切不到兄弟库（自己把自己锁死）。
  //   · activeRoot —— **当前真正读写哪个库**：默认 = tenantRoot；被 `.active` 标记改成子库
  //     之后就是那个子库。`vaultDir()` / LRU cacheKey / 面板回显都用它。
  //
  // 重启后仍然生效靠 `.active`（`cloud-vaults/<owner>/.active`，一行相对租户根的路径，
  // `.` 表示默认库）；坏标记（越界/不存在/不是库）一律忽略并回落默认库 —— 不能让一份坏
  // 标记把租户卡死在面板打不开的状态。
  const ACTIVE_MARKER = '.active'
  // 与 lib/db.js 的 DB_FILE 同值。**不静态 import**：cloud-contract 测试钉死了本文件的
  // 静态依赖清单（api/cloud-auth/license/entitlement/oidc/webhook/billing/quota/db），
  // 再加一条静态 import 就会破契约（同理 getDb 走动态 import）。
  const VAULT_DB = 'memory-eternal.db'
  // 与 lib/cloud-vaults.js 同一套 slug 口径（就地实现的原因见 tenantVaultList）
  const VAULT_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
  const RESERVED_SLUG_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/
  /** 租户根 → 当前 activeRoot 的进程内缓存（避免每个请求都读盘）。 */
  const activeRoots = new Map()

  /** `p` 是否就是 `base` 或在它下面（字符串前缀判定，必须先各自 resolve 过）。 */
  const insideOf = (base, p) => !!base && !!p && (p === base || p.startsWith(base + path.sep))

  /** 这个目录是不是**已有的记忆库**（目录 + memory-eternal.db）。 */
  const isVaultDir = (dir) => {
    if (!dir) return false
    try { return statSync(dir).isDirectory() && existsSync(path.join(dir, VAULT_DB)) } catch { return false }
  }

  /**
   * 算出租户根（隔离边界）与该租户的**默认**库。
   *
   * 默认库就是租户根本身；唯一的例外是管理面用 `/cloud/keys` 给某把密钥显式钉了一个
   * `vault`（issueKey 的 vault 字段）—— 那种密钥以它自己为准，否则这把密钥的历史数据
   * 会被静默指到别的目录去（老行为不变）。
   */
  const tenantRootsOf = (t) => {
    const owner = String((t && t.owner) || '')
    const declared = String((t && t.vaultRoot) || '').trim() ? path.resolve(String(t.vaultRoot)) : ''
    let tenantRoot = ''
    try { tenantRoot = path.resolve(tenantVault(owner, env)) } catch { tenantRoot = '' }
    if (declared && (!tenantRoot || !insideOf(tenantRoot, declared))) tenantRoot = declared
    if (!tenantRoot) return null
    const def = (declared && declared !== tenantRoot && insideOf(tenantRoot, declared)) ? declared : tenantRoot
    return { owner, tenantRoot, def }
  }

  /**
   * 该租户「当前在用的库」：进程内缓存 → `.active` 标记 → 默认库。
   * 缓存里的值每次都要复核（还在边界内、还是个库），库被删了能自动回落。
   */
  const activeRootOf = (info) => {
    const { owner, tenantRoot, def } = info
    const key = owner + '|' + tenantRoot
    const cached = activeRoots.get(key)
    if (cached && insideOf(tenantRoot, cached) && isVaultDir(cached)) return cached
    let want = ''
    try {
      const raw = String(readFileSync(path.join(tenantRoot, ACTIVE_MARKER), 'utf8') || '').split(/\r?\n/)[0].trim()
      if (raw) want = raw === '.' ? tenantRoot : path.resolve(tenantRoot, raw)
    } catch { /* 没有标记 = 默认库（绝大多数租户就是从没切过库） */ }
    const root = (insideOf(tenantRoot, want) && isVaultDir(want)) ? want : def
    activeRoots.set(key, root)
    return root
  }

  /** 租户视角的两个路径（tenants 表 / apiFor / switchVaultHot 共用）。 */
  const rootsOf = (t) => {
    const info = tenantRootsOf(t)
    if (!info) {
      // 连租户根都算不出来（owner 非法）：退回旧行为，不要在这里炸掉请求
      const only = path.resolve(String((t && t.vaultRoot) || ''))
      return { owner: String((t && t.owner) || ''), tenantRoot: only, def: only, activeRoot: only }
    }
    return { ...info, activeRoot: activeRootOf(info) }
  }

  /** 写 `.active` 标记（0600，一行相对租户根的路径，`.` = 默认库）。失败返回空串。 */
  const writeActiveMarker = (tenantRoot, target) => {
    try {
      const rel = target === tenantRoot ? '.' : path.relative(tenantRoot, target).split(path.sep).join('/')
      const marker = path.join(tenantRoot, ACTIVE_MARKER)
      writeFileSync(marker, rel + '\n', { mode: 0o600 })
      return marker
    } catch { return '' }   // 写不进去不影响本次切换（只是重启后回默认库）
  }

  /**
   * 该租户名下的所有库（默认库 + `vaults/<slug>/`），给 `vaultRoots()` 用（跨库检索/图谱聚合）。
   *
   * 为什么不直接 await import('./cloud-vaults.js').listOwnerVaults：`vaultRoots()` 必须是
   * **同步**的（api.js 的 searchAll / graphAll 直接同步调用它），而静态 import cloud-vaults
   * 会破 cloud-contract 的依赖清单断言。这里按同一套目录约定与 slug 规则就地实现，
   * 判定口径与 lib/cloud-vaults.js 保持一致。
   */
  const tenantVaultList = (tenantRoot) => {
    const out = []
    if (!tenantRoot) return out
    if (isVaultDir(tenantRoot)) out.push({ name: 'default', root: tenantRoot })
    try {
      for (const d of readdirSync(path.join(tenantRoot, 'vaults'), { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const slug = String(d.name || '')
        if (!VAULT_SLUG_RE.test(slug) || RESERVED_SLUG_RE.test(slug)) continue
        out.push({ name: slug, root: path.join(tenantRoot, 'vaults', slug) })
      }
    } catch { /* 没有 vaults/ 目录 = 只有默认库 */ }
    return out
  }

  /**
   * 云端租户实例的**热切库**（注入给 api.js 的 `switchVault`）。
   *
   * 三道闸，一条都不能省：
   *   ① 路径必须落在**本租户根**内 —— 越界返回 PATH_NOT_ALLOWED（api.js 转 403，
   *      与 /vaults/export、/vaults/transfer 的隔离口径完全一致）；
   *   ② 目标必须是**已存在的目录且含 memory-eternal.db** —— 绝不 mkdir、绝不 ensureVault
   *      （审计 H6：热切接口曾经等于「请求里的任意路径都能建目录 + 建库」）；
   *   ③ `getDb(target)` 打不开就不切 —— 否则整个面板会落进一个坏库，比不切更糟。
   *
   * 成功后：更新进程内 activeRoot + 写 `.active` + 旧库连接延后 5 秒关闭
   * （在途请求可能还握着它的语句句柄，立刻 close 会把那些请求炸掉，同 lib/web.js）。
   */
  const switchVaultHot = async (roots, rawTarget) => {
    const raw = String(rawTarget || '').trim()
    if (!raw) return { ok: false, error: '路径为空' }
    const { tenantRoot } = roots
    const target = path.resolve(raw)
    const prev = activeRootOf(roots)
    if (!insideOf(tenantRoot, target)) {
      return { ok: false, code: 'PATH_NOT_ALLOWED', error: 'path-not-allowed', hint: '只能切到本租户自己的记忆库' }
    }
    let isDir = false
    try { isDir = statSync(target).isDirectory() } catch { isDir = false }
    if (!isDir) {
      return { ok: false, code: 'PATH_NOT_ALLOWED', error: 'path-not-allowed', hint: '目标库不存在：' + target }
    }
    if (!existsSync(path.join(target, VAULT_DB))) {
      return { ok: false, code: 'PATH_NOT_ALLOWED', error: 'path-not-allowed', hint: '目标不是记忆库（缺 ' + VAULT_DB + '）：' + target }
    }
    if (target === prev) {
      return {
        ok: true, hot: true, root: target, prev,
        prefFile: writeActiveMarker(tenantRoot, target),   // 幂等：上次标记没写成时补上
        isCurrent: target === tenantRoot, message: '已经是当前库',
      }
    }
    // 动态 import getDb（原因见 VAULT_DB 的注释：静态依赖清单被契约测试钉死）
    try {
      const { getDb } = await import('./db.js')
      getDb(target)
    } catch (e) {
      return { ok: false, error: '目标库打不开：' + String((e && e.message) || e) }
    }
    activeRoots.set(roots.owner + '|' + tenantRoot, target)
    const prefFile = writeActiveMarker(tenantRoot, target)
    setTimeout(() => { try { closeDb(prev) } catch { /* 已关或从未打开 */ } }, 5000)
    return { ok: true, hot: true, root: target, prev, prefFile, isCurrent: target === tenantRoot, message: '已切到 ' + path.basename(target) }
  }

  // 授权校验：启动即算一次（离线签名，不联网）。降级策略见 lib/license.js。
  //   warn     —— 照常服务（自用/试用）
  //   readonly —— 写接口 403，读/导出照常（到期后还能拿回数据）
  //   stop     —— 除诊断类接口外全部拒绝
  const lic = licenseState(env)
  if (lic.status !== 'valid') {
    const tail = lic.expiresAt ? `（到期 ${lic.expiresAt}，剩 ${lic.daysLeft} 天）` : ''
    console.error(`[memory-eternal-cloud] license ${lic.status}${tail} · 降级策略=${lic.degrade}` + (lic.error ? ` · ${lic.error}` : ''))
  } else {
    console.error(`[memory-eternal-cloud] license 有效 · plan=${lic.payload && lic.payload.plan} · 剩 ${lic.daysLeft} 天`)
  }
  /**
   * 权限判定：**按租户算，不再是全局一份**。
   *
   * 之前这里是 `const access = resolveAccess(env)`（启动时算一次，全局共享）——
   * 多租户下所有租户共用同一份 entitlement，A 用户的对账会把 B 的套餐冲掉。
   * 现在 `resolveAccess(env, { owner })` 按 owner 读各自的文件（见 lib/entitlement.js）。
   *
   * 无 owner 的调用（`/cloud/config` 这类管理面）回落到旧版全局文件，保持兼容。
   */
  const accessFor = (owner) => resolveAccess(env, { owner: owner || '' })
  const canWriteFor = (owner) => accessFor(owner).canWrite
  // 启动时打一条全局视图（仅用于日志/诊断，不参与判定）
  const bootAccess = accessFor('')
  // 配额：进程内滑动窗口限速器（按租户分桶）。每次请求现算 quota（套餐可能被 webhook 随时改）。
  const rateLimiter = createRateLimiter()
  // 管理面（登录/测连/看套餐）不参与配额：超限了还得让用户能看到自己剩多少、能去升级。
  const SUB_WITHOUT_QUOTA = /^\/cloud\//
  // 会**新增卡片**的写接口（只有这些要校验卡片数上限；改/删/读不受限）
  const WRITE_PATHS_ADDING_CARDS = new Set(['/write', '/import', '/recall', '/migrate/run', '/push'])
  if (bootAccess.source !== 'mengbot') {
    console.error(`[memory-eternal-cloud] 权限来源=${bootAccess.source} plan=${bootAccess.plan} canWrite=${bootAccess.canWrite}（无 owner 的全局视图）`)
  } else {
    console.error(`[memory-eternal-cloud] 权限来源=MengBot · plan=${bootAccess.plan} · 剩 ${bootAccess.daysLeft ?? '?'} 天（无 owner 的全局视图）`)
  }

  /**
   * 管理面鉴权。
   *
   * `/cloud/keys`（签发/吊销密钥）、`/cloud/config`（配置）这些**绝不能裸奔**：
   * 一旦部署到公网，任何人 POST 一下就能给自己签一把密钥。
   *
   * 两道闸：
   *   ① 配了 `MEMORY_CLOUD_ADMIN_TOKEN` → 必须带 `Authorization: Bearer <它>` 或 `X-Admin-Token: <它>`；
   *   ② 没配 → **只允许真正的本机回环**（127.0.0.1 / ::1），公网来源一律 403 并提示去配 token。
   *
   * ★ 审计 S2：旧实现把**整个 RFC1918** 都当"本机回环"（172.16/12、10/8、192.168/16 全放行）。
   *   Docker 网桥、K8s Pod、同机房 VPC、办公室局域网里的 remoteAddress 正是这些地址 —— 于是
   *   同网段任何人都能 `POST /cloud/keys {"owner":"受害者"}` 自签密钥，直接拿下对方全部记忆。
   *   回环只认 127.0.0.1 / ::1；反代/容器场景必须显式配置 MEMORY_CLOUD_ADMIN_TOKEN。
   *
   * ★ 管理令牌的**三个来源**：env > 文件 > 首次启动自动生成。
   *
   * 为什么要有第三档：`MEMORY_CLOUD_ADMIN_TOKEN` 只能人工 `openssl rand` 再写 env / docker-compose，
   * 普通用户既不知道该填什么，填完还得重启进程（用户原话：「这个一般谁生成？然后怎么填？」）。
   * 现在改成「首次启动自己生成一把、落到 `$DSH_HOME/cloud-admin-token`（0600，与 cloud-keys.json 同目录），
   * 并在 stderr **只打印这一次**」，用户复制到面板里就能签发访问密钥 —— 之后既不用记也不用再发明文。
   *
   * 优先级（绝不反向覆盖）：
   *   ① env 有值 → 完全按现状走：不读文件、不写文件、不上盘（运维显式配置永远最高优先级）；
   *   ② 文件存在且内容够长（≥32 字符）→ 用它（所以重启后令牌不变）；
   *   ③ 否则生成 32 字节 hex，`flag:'wx'` + 0600 落盘；写失败（只读盘、残留的过短文件）
   *      → 只在内存里有效，**不抛错**（管理面不能因为一次写盘失败就让服务起不来）。
   *
   * 安全红线：令牌只在这三处流转 —— 内存、那个 0600 文件、那一次 stderr 打印。
   * 不进 `cloud-keys.json`、不进任何 JSON 响应、不进日志文件。
   */
  const ADMIN_TOKEN_FILE = 'cloud-admin-token'
  /** 令牌文件路径：与 cloud-keys.json **同目录**（$DSH_HOME 口径由 cloud-auth 统一）。 */
  const adminTokenFile = () => path.join(path.dirname(keyStorePath(env)), ADMIN_TOKEN_FILE)
  const adminTokenState = (() => {
    const fromEnv = String(env.MEMORY_CLOUD_ADMIN_TOKEN || '').trim()
    if (fromEnv) return { source: 'env', token: fromEnv, file: '', written: false }
    const file = adminTokenFile()
    const readTokenFile = () => {
      try { return String(readFileSync(file, 'utf8') || '').trim() } catch { return '' }
    }
    const onDisk = readTokenFile()
    if (onDisk.length >= 32) return { source: 'file', token: onDisk, file, written: false }
    const token = crypto.randomBytes(32).toString('hex')
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, token + '\n', { flag: 'wx', mode: 0o600 })
      return { source: 'generated', token, file, written: true }
    } catch (e) {
      // EEXIST：上一次启动 / 另一个 worker 刚写过（并发启动，或盘上留着一段过短的坏内容）。
      // 能读到够长的就直接复用它（令牌才稳定），否则这段令牌只在本次进程内有效。
      if (e && e.code === 'EEXIST') {
        const again = readTokenFile()
        if (again.length >= 32) return { source: 'file', token: again, file, written: false }
      }
      return { source: 'generated', token, file: '', written: false, error: String((e && e.code) || (e && e.message) || e) }
    }
  })()
  /** 统一入口：三个来源都从这里取（adminAllowed / 启动提示 / `/cloud/config` 共用）。 */
  const resolvedAdminToken = () => adminTokenState.token
  const isLoopback = (req) => {
    const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '')
    return ip === '127.0.0.1' || ip === '::1'
  }
  /**
   * 管理面放行判定。**语义与收紧后的 S2 一致，没有放宽**：
   *   · 请求里带了正确的令牌（Bearer / X-Admin-Token）→ 放行（任何来源都能用）；
   *   · env 显式配了令牌 → 没带对就是不放行（运维说了算，不接受"本机免令牌"）；
   *   · 只有"真回环 + 无反代头"才免令牌 —— 这是旧行为，运维在服务器上直接 curl 仍然能用。
   * 自动生成的那把令牌只是**多了一条可用的进门凭证**，并没有给回环之外任何免令牌通道。
   */
  const adminAllowed = (req) => {
    const want = resolvedAdminToken()
    const h = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
    const x = String(req.headers['x-admin-token'] || '').trim()
    if (want && (h === want || x === want)) return true
    if (adminTokenState.source === 'env') return false
    // 没配 env：只放行本机直连。带反代头（x-forwarded-for / x-real-ip）说明前面有代理，
    // 真实来源无法确认，一律按「非本机」处理。
    const proxied = !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded'])
    return isLoopback(req) && !proxied
  }
  const ADMIN_PATHS = /^\/cloud\/(keys|config)(\/|$)/

  // 启动时说明一次令牌从哪来（**只有自动生成那次才打印令牌本体**，其余只给位置）
  if (adminTokenState.source === 'generated' && adminTokenState.written) {
    console.error(
      `[memory-eternal-cloud] 已生成管理令牌并写入 $DSH_HOME/${ADMIN_TOKEN_FILE}（0600）\n` +
      `  管理令牌：${adminTokenState.token}（仅本次启动打印这一次）\n` +
      '  面板：设置 → 实验性 → 云端连接 → 服务端密钥管理，粘贴上面这串即可签发访问密钥',
    )
  } else if (adminTokenState.source === 'generated') {
    console.error(
      `[memory-eternal-cloud] 已生成管理令牌，但写不进 $DSH_HOME/${ADMIN_TOKEN_FILE}（${adminTokenState.error || '写入失败'}）——\n` +
      `  管理令牌：${adminTokenState.token}（只在本次进程内有效，重启会变）\n` +
      '  面板：设置 → 实验性 → 云端连接 → 服务端密钥管理，粘贴上面这串即可签发访问密钥',
    )
  } else if (adminTokenState.source === 'file') {
    console.error(
      `[memory-eternal-cloud] 管理令牌取自 $DSH_HOME/${ADMIN_TOKEN_FILE}（0600，内容不回显；要更换就删掉它再重启）。` +
      '未配置 MEMORY_CLOUD_ADMIN_TOKEN 时 /cloud/keys 与 /cloud/config 除本机直连外，也接受这把令牌。',
    )
  }

  /**
   * 取请求里的令牌：**Authorization 头优先，其次 HttpOnly cookie**。
   *
   * 为什么要认 cookie：登录成功后服务端种了 `me_cloud_token`（HttpOnly）。
   * 同源场景（客户端页面就跑在 mem.mengbot.vip 上）浏览器会自动带 cookie，
   * 这时前端 localStorage 里没有令牌也不该失败 —— 否则用户明明刚登录过，
   * 却看到「缺少 Authorization: Bearer <token>」。
   *
   * 跨域场景（页面在 127.0.0.1 调云端）cookie 因 SameSite=Lax 不会带，
   * 那时靠前端显式传 Authorization（fragment 令牌）—— 两条路并存。
   */
  const tokenOf = (req) => {
    const h = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim()
    if (h) return h
    return readCookieFromHeader(req.headers && req.headers.cookie, 'me_cloud_token')
  }

  /**
   * 解析租户（统一走 tokenOf，header 与 cookie 都认）。
   *
   * resolveTenant 给的 `vaultRoot` 是**租户根**；真正读写哪个库由热切状态决定
   * （见 activeRootOf）—— 所以这里直接把 vaultRoot 覆盖成 activeRoot：
   * `/cloud/whoami`、`/cloud/connect`、`/overview` 与卡片数配额计数因此全部
   * 显示/统计**当前库**，而不是切库前的旧路径。隔离边界单独存成 `tenantRoot`，两者不混用。
   */
  const tenantOf = (req) => {
    const tok = tokenOf(req)
    if (!tok) return { ok: false, error: '缺少 Authorization: Bearer <token>', noToken: true }
    const t = resolveTenant('Bearer ' + tok, env)
    if (!t.ok) return t
    try {
      const r = rootsOf(t)
      return { ...t, tenantRoot: r.tenantRoot, activeRoot: r.activeRoot, vaultRoot: r.activeRoot || t.vaultRoot }
    } catch {
      return t   // 路径算不出来就按旧行为走，不要把请求打成 500
    }
  }
  /**
   * 取（或懒创建）某租户的 api handler，同时维护 LRU。
   * 命中的实例会被重新插到队尾（Map 保持插入顺序 = 访问顺序）。
   *
   * 参数是**解析好的租户**（tenantOf 的返回值），因为它带着热切库需要的两个路径：
   *   · tenantRoot → pathScope（隔离边界）与库列表枚举；
   *   · activeRoot → vaultDir()（真正读写哪个库）与 LRU 的 cacheKey 后半段。
   */
  const apiFor = (t) => {
    const owner = String((t && t.owner) || '')
    const roots = rootsOf(t)
    const activeRoot = roots.activeRoot
    const now = Date.now()
    // 缓存键要带 activeRoot：一个租户现在可能有多个库（默认库 + vaults/<slug>/），
    // 只按 owner 缓存会让切库后仍然拿到指向旧库的 handler（写错地方）。
    const cacheKey = owner + '|' + String(activeRoot || '')
    const hit = tenants.get(cacheKey)
    if (hit) {
      hit.lastUsed = now
      // 提升到队尾：删了重插，Map 的迭代顺序就是 LRU 顺序
      tenants.delete(cacheKey)
      tenants.set(cacheKey, hit)
      return hit.handler
    }
    // 满了就淘汰最久未用的（Map 的第一个 key）
    while (tenants.size >= MAX_TENANTS) {
      const oldest = tenants.keys().next().value
      if (oldest === undefined) break
      evictTenant(oldest)
    }
    const handler = createApi({
      // ★ 每次调用现算（读进程内 activeRoot，不是闭包里的固定路径）：
      //   热切之后**同一个 handler** 也要立刻读写新库，否则面板切了库、下一次请求还在写旧库。
      vaultDir: () => activeRootOf(roots),
      // 跨库检索/图谱要看到**本租户的全部库**（默认库 + vaults/<slug>/），不是只有当前库
      vaultRoots: () => tenantVaultList(roots.tenantRoot),
      getSettings: () => onSettings(),
      // ★ 审计 S1：租户实例只允许碰**自己的库根**（含其下 vaults/<slug>/）。
      //   /vaults/export、/vaults/import-into、/vaults/transfer、/vaults/switch 的路径
      //   全部来自请求；不注入这一层，任一租户就能读写别人的记忆库（多租户隔离归零）。
      //   ⚠️ 这里必须是 **tenantRoot**（租户根），不能是 activeRoot：切到 vaults/work 之后
      //      边界若跟着收窄，用户就切不回默认库/兄弟库了。两者都在 cloud-vaults/<owner>/ 内，
      //      S1 的语义不受影响。
      pathScope: { mode: 'cloud', roots: [roots.tenantRoot] },
      // ★ 本轮新增：把热切库真正接进云端租户实例（此前没注入 → /vaults/switch 走降级分支
      //   返回 hot:false，「已记录，重启后生效」）。实现见上面的 switchVaultHot。
      switchVault: (rawTarget) => switchVaultHot(roots, rawTarget),
      // 让 /api/vaults 能带上该租户的库数量配额（MengBot 联调要的 quota 字段）。
      // 这里的 caps 是该租户自己的，不能用全局 access —— 否则 A 租户会看到 B 的配额。
      //
      // ⚠️ 必须经 quotaFor()，不能直接返回 access.caps：
      //   MengBot 现在回的是 `caps: null`（他们说 "entitlement 下发前先按套餐默认"），
      //   直接返回 {} 会让 /vaults 的 quota.limit = 0（= 不限），
      //   于是免费用户也能无限建库 —— 订阅页承诺的"1 个库"就成了空话。
      //   quotaFor() 的优先级是 caps 显式值 > PLAN_QUOTA[plan] > DEFAULT_QUOTA，
      //   这样 caps 一旦下发就自动覆盖，没下发时也有套餐兜底。
      getCaps: () => {
        try {
          const acc = accessFor(owner) || {}
          // ⚠️ resolveAccess 有三级兜底：租户 entitlement → 全局 license → 降级。
          // yg 自己的 entitlement 是 free/inactive（不算 paid），于是掉到**全局 license**
          // （服务器上装的是 pro/max 授权）—— 结果免费租户拿到了 max 的 vaults=50。
          // 这里把「租户自己声明过的 plan」捞回来：entitlement.owner 匹配就用它，
          // 全局 license 只用来判定 canWrite/降级，不该决定某个租户的配额档位。
          const ent = acc.entitlement
          const ownPlan = (ent && String(ent.owner || '') === String(owner) && ent.plan) ? ent.plan : ''
          const q = quotaFor(ownPlan ? { ...acc, plan: ownPlan } : acc, env)
          return { cards: q.cards, rpm: q.rpm, vaults: q.vaults, plan: ownPlan || acc.plan || '', source: q.source || '' }
        } catch { return {} }
      },
    })
    tenants.set(cacheKey, { handler, vaultRoot: activeRoot, lastUsed: now })
    return handler
  }

  /** 诊断用：当前驻留的租户实例数（/cloud/health 会带上）。 */
  const tenantStats = () => ({ active: tenants.size, max: MAX_TENANTS })

  // 客户端包**不由服务端托管**（见 docs/CLOUD.md「三种客户端形态」）：
  // 服务端只在 connect/manifest 里给出「去哪下载 + 校验值」，静态分发交给 Release / 私有 npm / 对象存储。
  // 需要临时自托管时设 MEMORY_CLIENT_PKG 指向本地 tgz 即可（仅限内网/试用）。
  const clientPkgPath = () => {
    const explicit = String(env.MEMORY_CLIENT_PKG || '').trim()
    if (explicit) return explicit
    const v = String(VERSION || '').trim()
    return v ? path.join(process.cwd(), 'dist', `memory-eternal-${v}.tgz`) : ''
  }
  const clientManifest = () => {
    const configured = String(env.MEMORY_CLIENT_URL || '').trim()
    const file = clientPkgPath()
    const selfHosted = !!file && existsSync(file)
    if (!configured && !selfHosted) {
      return {
        ok: false,
        version: VERSION,
        available: false,
        reason: '未配置客户端下载地址（MEMORY_CLIENT_URL），也没有本地包（MEMORY_CLIENT_PKG / dist/memory-eternal-<ver>.tgz）',
      }
    }
    const base = { ok: true, available: true, version: VERSION }
    if (configured) {
      return { ...base, url: configured, sha256: String(env.MEMORY_CLIENT_SHA256 || ''), source: 'external' }
    }
    const st = statSync(file)
    return { ...base, url: '/memory-eternal/api/cloud/client', bytes: st.size, source: 'self-hosted' }
  }
  /** 发码限速台账：email → 时间戳；ip → 时间戳数组。进程内，重启清零。 */
  const otpSendLog = new Map()

  /** PG 建表只做一次；失败不阻断服务（只是账号体系不可用）。 */
  let pgSchemaReady = false
  const ensureDb = async () => {
    if (pgSchemaReady) return true
    const r = await ensureSchema(env)
    pgSchemaReady = r.ok
    if (!r.ok) console.error('[pg] schema init failed:', r.error)
    return r.ok
  }
  const clientIp = (req) => String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '')
  /** 反代终止 TLS 时用 x-forwarded-proto；直连看 socket.encrypted。 */
  const reqIsHttps = (req) => String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim() === 'https'
    || !!(req.socket && req.socket.encrypted)
  /** /me 的返回体：用户 + 身份源 + 套餐。 */
  const loginProfile = async (userId) => {
    const user = await getUserById(userId, env)
    if (!user) return { user: null }
    let identities = []
    try { identities = await listIdentities(userId, env) } catch { identities = [] }
    let plan = null
    try { plan = await Promise.resolve(planView(user.email, env)) } catch { plan = null }
    return { user, identities, plan }
  }

  const html = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
  }

  /** 管理端 UI：登录页 / 面板 / 会话内操作。**不做租户解析**，也不碰用户会话。 */
  const handleAdminUi = async (sub, req, res) => {
    const method = String(req.method || 'GET').toUpperCase()
    const secret = resolvedAdminToken()
    const authed = () => verifySession(secret, readCookie(req, COOKIE_ADMIN)).ok
    // 反代通常终止 TLS → 用 x-forwarded-proto 判断；直连则看 socket
    const isHttps = String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim() === 'https'
      || !!(req.socket && req.socket.encrypted)

    if (sub === '/admin/login' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}))
      const given = String((body && body.token) || '').trim()
      if (!given || given !== secret) {
        await new Promise((r) => setTimeout(r, 300))   // 统一延迟，减少计时侧信道
        return json(res, 401, { ok: false, error: '管理令牌不正确' })
      }
      setCookie(res, COOKIE_ADMIN, issueSession(secret), { path: '/memory-eternal/api', secure: isHttps })
      return json(res, 200, { ok: true, next: '/memory-eternal/api/admin' })
    }

    if (sub === '/admin/logout') {
      setCookie(res, COOKIE_ADMIN, '', { path: '/memory-eternal/api', maxAge: 0 })
      return json(res, 200, { ok: true })
    }

    if (sub === '/admin' && method === 'GET') {
      if (!authed()) return html(res, 200, loginPage({ next: '/memory-eternal/api/admin' }))
      let keys = []
      try { keys = listKeys(env) } catch { keys = [] }
      const byOwner = new Map()
      for (const k of keys) if (k && k.owner) byOwner.set(k.owner, { owner: k.owner, plan: '—', expiresAt: '—', cards: null, vaults: null })

      // 补真实数据：每租户的卡片数 / 库数 / 套餐。
      // 上限 30 个租户，避免租户很多时打开面板就卡住（其余显示「—」，可点进详情查）。
      const list = [...byOwner.values()]
      let totalCards = 0
      for (const t of list.slice(0, 30)) {
        try {
          const root = tenantVault(t.owner, env)
          const st = await vaultStats(root)
          t.cards = st.total
          totalCards += st.total
          try { t.vaults = listOwnerVaults(root).length } catch { t.vaults = null }
        } catch { t.cards = null; t.vaults = null }
        try {
          const pv = await Promise.resolve(planView(t.owner, env))
          if (pv && typeof pv === 'object') {
            t.plan = pv.plan || 'free'
            const exp = pv.expiresAt
            if (exp == null) t.expiresAt = '—'
            else if (typeof exp === 'number') t.expiresAt = new Date(exp * 1000).toISOString().slice(0, 10)
            else t.expiresAt = String(exp).slice(0, 10)
          }
        } catch { /* 套餐拿不到就留占位 */ }
      }

      let dbMB = null
      try { dbMB = Math.round(statSync(keyStorePath(env)).size / 1024) } catch { dbMB = null }
      const up = Math.floor(process.uptime())
      return html(res, 200, adminPage({
        version: VERSION,
        system: { version: VERSION, tenants: byOwner.size, cards: totalCards, dbMB, uptime: (up > 86400 ? Math.floor(up / 86400) + 'd ' : '') + Math.floor((up % 86400) / 3600) + 'h' },
        tenants: list,
        keys,
      }))
    }

    if (!authed()) {
      return json(res, 401, { ok: false, code: 'admin_login_required', error: '请先登录管理端', login: '/memory-eternal/api/admin' })
    }

    // ── 用户管理 ──────────────────────────────────────────────────
    if (sub === '/admin/users' && method === 'GET') {
      const u = new URL(req.url, 'http://localhost')
      const kw = String(u.searchParams.get('q') || '')
      const offset = Math.max(0, Number(u.searchParams.get('offset')) || 0)
      let users = []
      let error = ''
      try {
        if (!(await ensureDb())) error = '账号库不可用（DATABASE_URL / PG）'
        else users = await listUsers({ limit: 50, offset, search: kw }, env)
      } catch (e) { error = String((e && e.message) || e).slice(0, 160) }
      return html(res, 200, usersPage({ users, q: kw, offset, limit: 50, flash: String(u.searchParams.get('flash') || ''), error }))
    }

    const muDetail = sub.match(/^\/admin\/users\/([0-9a-fA-F-]{36})$/)
    if (muDetail && method === 'GET') {
      try {
        const d = await getUserDetail(muDetail[1], env)
        return json(res, d.ok ? 200 : 404, d)
      } catch (e) { return json(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 160) }) }
    }

    const muStatus = sub.match(/^\/admin\/users\/([0-9a-fA-F-]{36})\/status$/)
    if (muStatus && method === 'POST') {
      const body = await readBody(req).catch(() => ({}))
      try {
        const r2 = await setUserStatus(muStatus[1], String((body && body.status) || ''), env)
        await audit({ actor: 'admin', action: 'user_status', target: muStatus[1], detail: { status: (body && body.status) || '' }, ip: clientIp(req) }, env)
        return json(res, r2.ok ? 200 : 400, r2)
      } catch (e) { return json(res, 500, { ok: false, error: String((e && e.message) || e).slice(0, 160) }) }
    }

    if (sub === '/admin/keys' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}))
      try {
        const r = issueKey({ owner: String((body && body.owner) || '').trim(), note: String((body && body.note) || '').trim() }, env)
        return json(res, 200, { ok: true, token: r.token, key: r.key })
      } catch (e) { return json(res, 400, { ok: false, error: String((e && e.message) || e) }) }
    }

    // 单租户详情（只读）：套餐 / 配额 / 卡片统计 / 库列表
    const mt = sub.match(/^\/admin\/tenant\/([^/?#]+)$/)
    if (mt && method === 'GET') {
      const owner = decodeURIComponent(mt[1])
      try {
        const root = tenantVault(owner, env)
        const st = await vaultStats(root)
        let vaults = []
        try { vaults = listOwnerVaults(root).map((v) => ({ name: v.name, cards: v.cards, sizeMB: v.sizeMB })) } catch { vaults = [] }
        const pv = await Promise.resolve(planView(owner, env))
        return json(res, 200, { ok: true, owner, plan: pv || null, stats: st, vaults })
      } catch (e) { return json(res, 400, { ok: false, error: String((e && e.message) || e) }) }
    }

    const mk = sub.match(/^\/admin\/keys\/([\w.-]+)$/)
    if (mk && method === 'DELETE') {
      try { revokeKey(mk[1], env); return json(res, 200, { ok: true }) }
      catch (e) { return json(res, 400, { ok: false, error: String((e && e.message) || e) }) }
    }

    return json(res, 404, { ok: false, error: 'unknown admin route: ' + sub })
  }

  const handleAdmin = async (sub, req, res) => {
    const method = String(req.method || 'GET').toUpperCase()
    // 管理面闸门：签发/吊销密钥、读配置 —— 未通过就 403（防止公网裸奔签发）
    if (ADMIN_PATHS.test(sub) && !adminAllowed(req)) {
      // env 配了令牌 = 运维显式接管 → 只说"令牌不对"；
      // 没配 env（用文件 / 自动生成的令牌）= 保留"仅本机"的口径，并告诉用户去哪儿拿令牌。
      const hasEnvToken = adminTokenState.source === 'env'
      return json(res, 403, {
        ok: false, code: 'admin_required',
        error: hasEnvToken
          ? '管理令牌无效（Authorization: Bearer <MEMORY_CLOUD_ADMIN_TOKEN>）'
          : '管理面仅允许本机访问（127.0.0.1 / ::1）；当前请求不是本机直连，且没有带有效的管理令牌',
        hint: hasEnvToken
          ? '带上正确的管理令牌再试'
          : `在服务端设置 MEMORY_CLOUD_ADMIN_TOKEN，或复制服务端启动日志 / $DSH_HOME/${ADMIN_TOKEN_FILE} 里的管理令牌，用 Authorization: Bearer <它> 访问`,
      })
    }
    // license 摘要只给脱敏字段（status/plan/到期/剩余天数），不给 license 原文
    if (sub === '/cloud/config' && method === 'GET') return json(res, 200, { ok: true, version: VERSION, license: licenseSummary(lic), access: accessSummary(resolveAccess(env)), hasAdminToken: !!resolvedAdminToken(), adminTokenSource: adminTokenState.source, ...publicCloudConfig(env) })
    if (sub === '/cloud/keys' && method === 'GET') return json(res, 200, { ok: true, keys: listKeys(env) })
    if (sub === '/cloud/keys' && method === 'POST') {
      const body = await readBody(req)
      try {
        const r = issueKey({ owner: body.owner, note: body.note, vault: body.vault }, env)
        // 明文只在这里返回一次；库里只有哈希
        return json(res, 200, { ok: true, token: r.token, key: r.key, note: '这串密钥只显示这一次，请立刻保存' })
      } catch (e) { return json(res, 400, { ok: false, error: String((e && e.message) || e) }) }
    }
    const mRevoke = sub.match(/^\/cloud\/keys\/([\w.-]+)$/)
    if (mRevoke && method === 'DELETE') {
      const r = revokeKey(mRevoke[1], env)
      return json(res, r.ok ? 200 : 404, r)
    }
    // MengBot 账号授权（与 mengbot control-plane 的真实机制对齐）：
    //   { token }         直接用令牌（用户会话 或 mb_install_* 设备凭据）
    //   { email }         代发 8 位 OTP，返回 step:'otp-sent'
    //   { email, otp }    登录换 token → 校验 → 签发本地令牌
    if (sub === '/cloud/login/mengbot' && method === 'POST') {
      const body = await readBody(req)
      // 发码限速：这个端点会代用户去 MengBot 发验证码邮件。
      // 不限速 = 任何人都能拿**我们的出口**给任意邮箱刷码 —— 既骚扰收件人，也会把我们的发信额度/域名信誉打坏。
      // 两条独立闸：同一邮箱 60 秒一次、同一 IP 每小时 20 次（内存窗口，进程重启即清零，够用）。
      if (body && body.email && !body.otp && !body.token) {
        const nowMs = Date.now()
        const emailKey = 'e:' + String(body.email).toLowerCase().trim()
        const ipKey = 'ip:' + String((req.socket && req.socket.remoteAddress) || 'unknown')
        const emailHit = otpSendLog.get(emailKey)
        if (emailHit && nowMs - emailHit < 60 * 1000) {
          return json(res, 429, { ok: false, code: 'otp_too_soon', error: '验证码刚发过，请 60 秒后再试', retryAfterSeconds: Math.ceil((60 * 1000 - (nowMs - emailHit)) / 1000) })
        }
        const ipHits = (otpSendLog.get(ipKey) || []).filter((t) => nowMs - t < 60 * 60 * 1000)
        if (ipHits.length >= 20) {
          return json(res, 429, { ok: false, code: 'otp_ip_limited', error: '该来源发码过于频繁，请稍后再试' })
        }
        // 清理过期键，避免 Map 无限增长
        for (const [k, v] of otpSendLog) {
          if (Array.isArray(v)) { if (!v.some((t) => nowMs - t < 60 * 60 * 1000)) otpSendLog.delete(k) }
          else if (nowMs - v > 10 * 60 * 1000) otpSendLog.delete(k)
        }
        otpSendLog.set(emailKey, nowMs)
        otpSendLog.set(ipKey, [...ipHits, nowMs])
      }
      const r = await verifyMengbotLogin({
        token: body.token || '',
        email: body.email || '',
        otp: body.otp || body.code || '',
        env,
      })
      // 控制面落库（仅真正登录成功时；发码阶段 r.pending 不建号）
      if (r.ok && r.owner && !r.pending) {
        try {
          if (await ensureDb()) {
            const link = await upsertIdentity({
              provider: 'mengbot-otp',
              externalId: r.owner,
              email: r.owner,
              emailVerified: true,          // 验证码本身就证明了邮箱归属
              meta: { via: r.via || 'mengbot' },
            }, env)
            await audit({ actor: r.owner, action: 'otp_login', target: link.ok ? link.userId : '', detail: { linked: link.linked || '' }, ip: clientIp(req) }, env)
          }
        } catch (e) { console.error('[accounts] otp 落库失败：', String((e && e.message) || e).slice(0, 160)) }
      }
      return json(res, r.ok ? 200 : 400, r)
    }
    // ---- 跳转授权（redirect + 回跳）------------------------------------------
    // 比「在面板里输邮箱+验证码」好得多：点一下跳到 MengBot 登录页，登录完自动回跳。
    //   GET /cloud/auth/start     → 302 到 MengBot 登录页（带 state + redirect_uri）
    //   GET /cloud/auth/callback  → 校验 state、换令牌、解析租户，把本地令牌放 URL fragment 回跳
    // 令牌走 fragment（`#token=`），不进服务器日志、不带进 Referer。
    if (sub === '/cloud/auth/start' && method === 'GET') {
      const u = new URL(req.url, 'http://localhost')
      // **必须先校验**：这个值会被原样塞进 OIDC state，登录成功后拿来回跳并附上令牌。
      // 不校验就是开放重定向（令牌被送到攻击者站点）。
      const back = safeRedirectTarget(u.searchParams.get('redirect_uri') || '', env)
      // poll=1：浏览器授权完成后不回跳（跳不回 dsh-app://），改成把令牌存进票仓，
      // 由应用侧轮询取走。见 pollTickets 的注释。
      let pollId = ''
      if (u.searchParams.get('poll') === '1') {
        // 优先用 poll/start 签发好的 ID（前端已持有、正在轮询它）；
        // 没给就现发一个（直接访问本 URL 的场景）。
        const given = String(u.searchParams.get('poll_id') || '').trim()
        pollId = /^pl_[A-Za-z0-9_-]{8,64}$/.test(given) ? given : 'pl_' + crypto.randomBytes(9).toString('base64url')
        if (!pollTickets.has(pollId)) pollTickets.set(pollId, { createdAt: Date.now(), result: null })
        // 顺手清掉过期的，避免长时间运行后堆积
        for (const [k, v] of pollTickets) {
          if (Date.now() - v.createdAt > 15 * 60 * 1000) pollTickets.delete(k)
        }
      }
      // ① 有 OIDC 配置 → 走标准 authorization_code（PKCE S256）
      const oc = readOidcConfig(env)
      if (oidcReady(oc)) {
        // endpoint 一律从 .well-known/openid-configuration 拿，不硬编码路径
        // （MengBot 的是 https://accounts.mengbot.vip/auth，不是 {issuer}/oidc/auth）
        const disc = await discoverOidc(oc)
        if (!disc.ok) return json(res, 502, { ok: false, code: 'oidc_discovery_failed', error: disc.error })
        const built = buildAuthorizeUrl(oc, disc.endpoints, { extraState: pollId ? 'poll:' + pollId : back })
        if (!built.ok) return json(res, 400, built)
        rememberPkce(built.state, built.codeVerifier)
        res.writeHead(302, {
          Location: built.url,
          'Cache-Control': 'no-store',
          'X-OIDC-Authorize-Endpoint': disc.endpoints.authorizationEndpoint,
        })
        res.end()
        return
      }
      // ② 没有 OIDC 配置 → 回退旧的「MengBot 登录页 + 自造 state」
      const cb = String(env.MEMORY_CLOUD_PUBLIC_URL || '').trim().replace(/\/+$/, '') + '/memory-eternal/api/cloud/auth/callback'
      const r = startMengbotAuth({ redirectUri: back, callbackUrl: cb, env })
      if (!r.ok) return json(res, 400, r)
      res.writeHead(302, { Location: r.url, 'Cache-Control': 'no-store' })
      res.end()
      return
    }

      // ── 设备码登录（RFC 8628）：桌面端/无浏览器环境的标准方案 ────────────
      // 为什么需要：桌面应用页面 origin 是自定义协议（dsh-app://app），
      // OIDC 授权码流程的 interaction cookie 种在 accounts.mengbot.vip 域上，
      // 跨不到自定义协议 → 授权页直接判「不在同一个浏览器里」并 400。
      // 设备码流程没有这个问题：应用只显示一个短码，用户在任何设备输入并授权，应用轮询取 token。
      //
      // POST /cloud/auth/device/start   → { userCode, verificationUri, interval, expiresIn }
      // POST /cloud/auth/device/poll    { deviceCode } → { pending } 或 { ok, token, owner }
      if (sub === '/cloud/auth/device/start' && method === 'POST') {
        const oc = readOidcConfig(env)
        if (!oidcReady(oc)) return json(res, 400, { ok: false, code: 'oidc_unconfigured', error: 'OIDC 未配置' })
        const disc = await discoverOidc(oc)
        if (!disc.ok) return json(res, 502, { ok: false, code: 'oidc_discovery_failed', error: disc.error })
        const d = await startDeviceAuth(oc, disc.endpoints)
        if (!d.ok) {
          // grant_not_allowed 是最可能的一种：IdP 支持设备码但没给本 client 开。
          // 用 409 而不是 400 —— 这不是请求错，是部署配置缺一项，前端要给出不同的引导。
          const status = d.code === 'grant_not_allowed' ? 409 : 400
          return json(res, status, d)
        }
        // deviceCode 只在服务端留存（不发给浏览器，避免被前端日志/插件抄走）
        const key = 'dv_' + crypto.randomBytes(12).toString('base64url')
        deviceTickets.set(key, { deviceCode: d.deviceCode, at: Date.now(), interval: d.interval, expiresIn: d.expiresIn })
        // 顺手清理过期的
        for (const [k, v] of deviceTickets) if (Date.now() - v.at > 20 * 60000) deviceTickets.delete(k)
        return json(res, 200, {
          ok: true,
          ticket: key,
          userCode: d.userCode,
          verificationUri: d.verificationUri,
          verificationUriComplete: d.verificationUriComplete,
          interval: d.interval,
          expiresIn: d.expiresIn,
        })
      }
      if (sub === '/cloud/auth/device/poll' && method === 'POST') {
        const body = await readBody(req)
        const tk = deviceTickets.get(String(body.ticket || ''))
        if (!tk) return json(res, 404, { ok: false, code: 'ticket_expired', error: '登录会话已过期，请重新发起' })
        const oc = readOidcConfig(env)
        const disc = await discoverOidc(oc)
        if (!disc.ok) return json(res, 502, { ok: false, error: disc.error })
        const r = await pollDeviceToken(oc, disc.endpoints, tk.deviceCode)
        if (!r.ok && r.pending) return json(res, 200, { ok: false, pending: true })
        if (!r.ok) {
          deviceTickets.delete(String(body.ticket || ''))
          return json(res, 400, r)
        }
        deviceTickets.delete(String(body.ticket || ''))
        // 拿到令牌 → 换 userinfo → 签本地会话（与授权码流程完全一致的下游）
        const u = await fetchUserInfo(oc, disc.endpoints, r.tokens.accessToken)
        if (!u.ok) return json(res, 502, { ok: false, error: '拉取用户信息失败：' + u.error })
        const profile = { name: String(u.name || '').slice(0, 80), email: String(u.email || '').slice(0, 120), picture: String(u.picture || '').slice(0, 400) }
        const local = issueSessionTokenForOwner(u.owner, 'oidc-device', env, profile)
        if (!local || !local.ok) return json(res, 500, { ok: false, error: (local && local.error) || '签发本地会话失败' })
        if (r.tokens.refreshToken) { try { storeRefreshToken(u.owner, r.tokens.refreshToken, env) } catch { /* 忽略 */ } }
        return json(res, 200, {
          ok: true,
          token: local.token,
          owner: local.owner,
          via: 'oidc-device',
          profile,
        })
      }

    /**
     * GET /cloud/auth/poll?poll_id=xxx
     *
     * PC 回跳取票：浏览器授权完成后 callback 会把令牌存进 pollTickets，
     * 应用侧轮询这里取走（取一次即删，防重放）。
     *
     * 为什么不回跳 dsh-app://：DSH 没有把该协议注册给操作系统，
     * 浏览器跳过去只会弹「找不到应用」，令牌也丢了。
     */
    /**
     * POST /cloud/auth/poll/start → { pollId, url }
     *
     * PC 回跳的起点：先由服务端签发 poll_id（前端拿着它轮询），
     * 再跳浏览器授权。为什么不集中在 auth/start 里做：那是 302，
     * 前端看不到 Location 之外的任何信息，必须先有一次 JSON 往返拿到 pollId。
     */
    if (sub === '/cloud/auth/poll/start' && method === 'POST') {
      const b = (await readBody(req)) || {}
      const back = safeRedirectTarget(String(b.redirect_uri || ''), env)
      const pollId = 'pl_' + crypto.randomBytes(9).toString('base64url')
      pollTickets.set(pollId, { createdAt: Date.now(), result: null })
      for (const [k, v] of pollTickets) {
        if (Date.now() - v.createdAt > 15 * 60 * 1000) pollTickets.delete(k)
      }
      const q = new URLSearchParams({ poll: '1', poll_id: pollId })
      if (back) q.set('redirect_uri', back)
      const self = String(env.MEMORY_CLOUD_PUBLIC_URL || '').replace(/\/+$/, '')
      return json(res, 200, {
        ok: true,
        pollId,
        url: self + '/memory-eternal/api/cloud/auth/start?' + q.toString(),
        interval: 3,
        expiresIn: 600,
      })
    }

    if (sub === '/cloud/auth/poll' && method === 'GET') {
      const u = new URL(req.url, 'http://localhost')
      const pollId = String(u.searchParams.get('poll_id') || '').trim()
      if (!pollId || !pollId.startsWith('pl_')) {
        return json(res, 400, { ok: false, code: 'bad_poll_id', error: '缺少或非法的 poll_id' })
      }
      const ticket = pollTickets.get(pollId)
      if (!ticket) return json(res, 404, { ok: false, code: 'poll_expired', error: '取票码不存在或已过期，请重新发起登录' })
      if (Date.now() - ticket.createdAt > 15 * 60 * 1000) {
        pollTickets.delete(pollId)
        return json(res, 404, { ok: false, code: 'poll_expired', error: '取票码已过期，请重新发起登录' })
      }
      if (!ticket.result) return json(res, 200, { ok: false, pending: true })
      const result = ticket.result
      // ⚠ 不在这里立刻删票：
      //   ① 结果里可能是「需要授权注册」（needAuthorize + regTicket），前端拿到后要跳转，
      //      万一那次响应丢了（切网/休眠），立刻删票会让下次轮询拿到 404 —— 用户看到的就是
      //      「二维码已过期」，而实际上手机那边已经授权成功了（实测踩过）。
      //   ② 令牌重复下发不可怕（同一会话），错过一次就要重新扫码才可怕。
      // 改成：标记已取，60 秒后再删；过期仍由 15 分钟 TTL 兜底。
      if (!ticket.takenAt) ticket.takenAt = Date.now()
      setTimeout(() => { const t2 = pollTickets.get(pollId); if (t2 && t2.takenAt) pollTickets.delete(pollId) }, 60 * 1000)
      // 原样透传：不再挑字段，否则 needAuthorize / regTicket 会被吞掉（这就是上面那个 bug 的根因）
      return json(res, 200, { ok: true, ...result })
    }

    if (sub === '/cloud/auth/callback' && method === 'GET') {
      const u = new URL(req.url, 'http://localhost')
      const code = u.searchParams.get('code') || ''
      const state = u.searchParams.get('state') || ''
      const oc = readOidcConfig(env)

      // ① 标准 OIDC：code + PKCE verifier → tokens → userinfo
      if (oidcReady(oc) && code && state) {
        const p = takePkce(state)
        if (!p.ok) return json(res, 400, p)
        const disc = await discoverOidc(oc)
        if (!disc.ok) return json(res, 502, { ok: false, code: 'oidc_discovery_failed', error: disc.error })
        const done = await completeOidcLogin(oc, disc.endpoints, { code, codeVerifier: p.codeVerifier, fetchImpl: fetch })
        if (!done.ok) return json(res, 400, done)
        // 复用同一套租户/令牌体系
        // profile 只用于显示头像/名字（name / email / picture），不含任何令牌。
        // 控制面：**只查不建**。没有账号就走「授权注册」（资料以 MengBot 为准，用户只补一个密码）。
        const raw = done.user || {}
        const oidcSub = String(raw.sub || raw.id || '').trim()
        const oidcEmail = (done.profile && done.profile.email) || done.owner
        const oidcVerified = raw.email_verified === true || raw.emailVerified === true
        let pgFound = { found: false }
        try {
          if (await ensureDb()) {
            pgFound = await lookupIdentity({ provider: 'mengbot-oidc', externalId: oidcSub || oidcEmail, email: oidcEmail, emailVerified: oidcVerified }, env)
          }
        } catch (e) { console.error('[accounts] oidc 查询失败：', String((e && e.message) || e).slice(0, 160)) }
        await audit({ actor: done.owner, action: pgFound.found ? 'oidc_login' : 'oidc_need_register', target: pgFound.userId || '', detail: { by: pgFound.by || '' }, ip: clientIp(req) }, env)
        const local = issueSessionTokenForOwner(done.owner, 'oidc', env, done.profile || null)
        if (!local.ok) return json(res, 400, local)
        // refresh_token 不能丢：存进台账（只留最近 200 条），过期可静默续期，不用重新跳登录
        if (done.tokens && done.tokens.refreshToken) {
          try { storeRefreshToken(done.owner, done.tokens.refreshToken, env) } catch { /* 存不下不影响登录 */ }
        }
        // **不再缓存 access_token**。
        // 原来这里存是为了「代用户调 MengBot」（下单/查套餐），但支付已改成直跳 subscribe 深链
        //（MengBot 第 4 封 Q2），套餐对账走服务端自己的 mbt_ 令牌 —— 没有任何消费方了。
        // 留着等于在磁盘上白摆一份**所有用户的 access_token 明文**，纯增加泄漏面。
        // refresh_token 仍然存（它是长效凭据，配置/排查需要），但已按租户分文件。
        // ── poll 模式（PC 回跳）──────────────────────────────────────────
        // 桌面端跳不回 dsh-app://，改由应用轮询取票。这里把令牌存进票仓就返回，
        // **绝不在页面上显示令牌**（P0：不在浏览器里摆明文凭据）。
        const extra = extraStateOf(state)
        if (extra.startsWith('poll:')) {
          const pollId = extra.slice(5)
          const apiBase = String(env.MEMORY_CLOUD_PUBLIC_URL || '').replace(/\/+$/, '') + '/memory-eternal/api'
          const ticket = pollTickets.get(pollId)
          if (ticket) {
            if (pgFound.found) {
              // 已有账号：直接给令牌（PC 轮询取走）
              try { await upsertIdentity({ provider: 'mengbot-oidc', externalId: oidcSub || oidcEmail, email: oidcEmail, emailVerified: oidcVerified, meta: { name: (done.profile && done.profile.name) || '', picture: (done.profile && done.profile.picture) || '' } }, env) } catch { /* 幂等补写，失败不影响 */ }
              ticket.result = { token: local.token, owner: done.owner, profile: done.profile || null, api: apiBase }
            } else {
              // 无账号：签一张授权注册票，PC 端跳到「补设密码」页
              const regTicket = 'reg_' + crypto.randomBytes(18).toString('base64url')
              regTickets.set(regTicket, {
                at: Date.now(),
                provider: 'mengbot-oidc',
                externalId: oidcSub || oidcEmail,
                email: oidcEmail,
                emailVerified: oidcVerified,
                profile: done.profile || null,
              })
              for (const [k, v] of regTickets) { if (Date.now() - v.at > 10 * 60 * 1000) regTickets.delete(k) }
              ticket.result = { needAuthorize: true, regTicket, owner: done.owner, profile: done.profile || null, api: apiBase }
            }
          }
          return sendHtml(res, 200, pollDonePageHtml(done.owner))
        }

        const backRaw = String(u.searchParams.get('redirect_uri') || '').trim()
        const back = safeRedirectTarget(backRaw, env)
          || String(env.MEMORY_CLOUD_PUBLIC_URL || '/').trim()
        const sep = back.includes('#') ? '&' : '#'
        const dest = back + sep + 'me_cloud_token=' + encodeURIComponent(local.token)
          + '&me_cloud_owner=' + encodeURIComponent(done.owner)
          + '&me_cloud_api=' + encodeURIComponent((String(env.MEMORY_CLOUD_PUBLIC_URL || '').replace(/\/+$/, '')) + '/memory-eternal/api')
        // 同时种一个 HttpOnly cookie：web 端「登录墙」靠它判断（SPA 的 localStorage 只给前端用）
        const cookie = sessionCookie(local.token)

        // ⚠️ **非 http(s) 回跳地址不能 302**（这是 DSH 桌面端的真实卡点）：
        // DSH 的页面 origin 是自定义协议 `dsh-app://app`，浏览器/Electron 对
        // 「导航到自定义协议」通常直接拦掉 —— 302 过去用户看到的是白屏或没反应，
        // 而且令牌也丢了。这种情况改成**渲染一个页面把令牌显示出来**，用户手动复制一次即可。
        if (!/^https?:\/\//i.test(back)) {
          const apiBase = String(env.MEMORY_CLOUD_PUBLIC_URL || '').replace(/\/+$/, '') + '/memory-eternal/api'
          const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录成功</title>
<style>
body{font:14px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#1a1a1a;background:#fafafa}
h1{font-size:20px;margin:0 0 6px}p{color:#666;margin:6px 0}
.card{background:#fff;border:1px solid #e2e2e2;border-radius:10px;padding:18px;margin:18px 0}
.k{font-size:12px;color:#888;margin-bottom:4px}
.v{font-family:ui-monospace,Consolas,monospace;font-size:13px;word-break:break-all;background:#f4f4f5;border-radius:6px;padding:10px}
button{margin-top:12px;padding:8px 16px;font-size:14px;border:1px solid #d0d0d0;border-radius:8px;background:#fff;cursor:pointer}
button:hover{background:#f0f0f0}
.ok{color:#16803c;font-weight:600}
</style></head><body>
<h1 class="ok">✓ 登录成功</h1>
<p>账号：<b>${escapeHtml(done.owner)}</b></p>
<p>这里的页面跑在自定义协议（${escapeHtml(back)}）上，无法自动回跳，请手动复制下面的值。</p>
<div class="card"><div class="k">访问密钥（填到「访问密钥」框）</div>
<div class="v" id="tok">${escapeHtml(local.token)}</div>
<button onclick="navigator.clipboard.writeText(document.getElementById('tok').textContent).then(()=>this.textContent='已复制').catch(()=>{})">复制密钥</button></div>
<div class="card"><div class="k">服务地址（填到「地址」框）</div>
<div class="v" id="api">${escapeHtml(apiBase.replace(/\/memory-eternal\/api$/, ''))}</div></div>
<p>填好后点「保存并切换」即可。</p>
</body></html>`
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': cookie })
          res.end(html)
          return
        }

        res.writeHead(302, { Location: dest, 'Cache-Control': 'no-store', 'Set-Cookie': cookie })
        res.end()
        return
      }

      // ② 回退：MengBot 自定义回跳（code 或 token）
      const r = await completeMengbotAuth({
        code,
        token: u.searchParams.get('token') || '',
        state,
        env,
      })
      if (!r.ok) return json(res, 400, r)
      // ⚠ 这里必须和白名单分支（上面的 OIDC 路径）用同一套校验：
      // 曾经直接取 query 里的 redirect_uri，等于给「开放重定向 + 令牌外送」留了第二个口子。
      const back = safeRedirectTarget(String(u.searchParams.get('redirect_uri') || ''), env)
        || safeRedirectTarget(String(r.redirectUri || ''), env)
        || String(env.MEMORY_CLOUD_PUBLIC_URL || '/').trim()
      const sep = back.includes('#') ? '&' : '#'
      const dest = back + sep + 'me_cloud_token=' + encodeURIComponent(r.token)
        + '&me_cloud_owner=' + encodeURIComponent(r.owner)
        + '&me_cloud_api=' + encodeURIComponent((String(env.MEMORY_CLOUD_PUBLIC_URL || '').replace(/\/+$/, '')) + '/memory-eternal/api')
      res.writeHead(302, { Location: dest, 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(r.token) })
      res.end()
      return
    }
    // 健康检查：**公开、不鉴权**。客户端「测试连接」用它判断「服务端是否可达」，
    // 不与「是否已登录」混为一谈 —— 否则没登录时点测试连接会得到
    // 「缺少 Authorization: Bearer <token>」，让人以为地址填错了。
    if (sub === '/cloud/health' && method === 'GET') {
      return json(res, 200, {
        ok: true, reachable: true, cloud: true,
        version: VERSION,
        time: new Date().toISOString(),
        oidc: oidcReady(readOidcConfig(env)),
        license: lic.status,
        tenants: tenantStats(),
      })
    }
    if (sub === '/cloud/whoami') {
      const t = tenantOf(req)
      if (!t.ok) return json(res, 401, { ok: false, error: t.error })
      return json(res, 200, {
      ok: true, owner: t.owner, via: t.via,
      // profile 用于前端渲染头像（picture）与显示名（name）；没有就让前端用字母头像兜底
      profile: t.profile || null,
      vaultRoot: t.vaultRoot, cloudRoot: cloudRoot(env),
    })
    }
    // 登出：清掉会话 cookie（并把该令牌从会话表移除）
    if (sub === '/cloud/logout' && (method === 'POST' || method === 'GET')) {
      const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
        || readCookieFromHeader(req.headers.cookie, 'me_cloud_token')
      if (tok) { try { revokeSessionToken(tok, env) } catch { /* 忽略 */ } }
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store', 'Set-Cookie': clearSessionCookie() })
      res.end()
      return
    }
    // 客户端清单：只给「去哪下 + 校验值」，不下发代码（服务端不含客户端 UI）
    if (sub === '/cloud/client/manifest') {
      const m = clientManifest()
      return json(res, m.ok ? 200 : 404, { ok: m.ok, ...m })
    }
    // 临时自托管下载（仅当 MEMORY_CLIENT_PKG 指向本地 tgz 时）
    if (sub === '/cloud/client') {
      const file = clientPkgPath()
      if (!file || !existsSync(file)) return json(res, 404, { ok: false, error: '本实例未托管客户端包（用 MEMORY_CLIENT_PKG 指向 tgz，或让客户端从 Release 下载）' })
      const st = statSync(file)
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Length': String(st.size),
        'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
        'Cache-Control': 'no-store',
      })
      createReadStream(file).pipe(res)
      return
    }
    // ---- Webhook（MengBot → 我们）：签名校验 + 事件应用 -----------------------
    // MengBot 侧配置推送地址，双方各存一份 MEMORY_WEBHOOK_SECRET。
    // 这是**唯一不走租户令牌**的业务入口：靠 HMAC 签名鉴权。
    if (sub === '/cloud/webhook/mengbot' && method === 'POST') {
      const raw = await readRawBody(req)
      const verify = verifyWebhookSignature({
        secret: webhookSecret(env),
        rawBody: raw,
        header: req.headers[HEADERS.SIG_HEADER],
      })
      if (!verify.ok) return json(res, 401, { ok: false, error: verify.error })
      let payload = {}
      try { payload = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'body 不是合法 JSON' }) }
      const event = String(req.headers[HEADERS.EVENT_HEADER] || payload.event || '').trim()
      const eventId = String(req.headers[HEADERS.ID_HEADER] || payload.id || '').trim()
      // **把收到的事件内容记下来**：排查"我明明订阅了但状态没变"时，
      // 唯一能判断的是"对方到底推了什么"。之前只记了有请求到达，看不到 plan/caps/账号。
      try {
        const brief = {
          event,
          eventId,
          account: payload.account || payload.email || payload.owner || null,
          plan: payload.plan ?? null,
          status: payload.status ?? null,
          caps: payload.caps ?? null,
          version: payload.version ?? null,
        }
        console.error(`[webhook-in] ${JSON.stringify(brief)}`)
      } catch { /* 日志失败不影响处理 */ }
      const r = applyWebhookEvent({ event, payload, eventId }, env)
      // 幂等：重复投递也回 200（让对方别重试）
      return json(res, r.ok ? 200 : 400, r)
    }
    // ---- 支付 / 套餐（不自己收钱：下单交给 MengBot，结果靠 webhook 回来）----
    //   GET  /cloud/billing/plan                        当前套餐视图（本地 entitlement）
    //   POST /cloud/billing/checkout { plan, source }   发起支付 → 返回 MengBot 支付页 URL
    if (sub === '/cloud/billing/plan' && method === 'GET') {
      const t = tenantOf(req)
      if (!t.ok) return json(res, 401, { ok: false, error: t.error })
      // 顺带对账：本地 entitlement 超过 10 分钟没更新 → 用 mbt_ 打 MengBot 的
      // /api/v1/accounts/{email}/subscription 补一次（见 lib/subscription-sync.js）。
      // 失败静默（对账是兜底，不该让用户看到错）；只补空缺/只升级，不降级。
      let synced = null
      try {
        const { syncEntitlement, syncReady } = await import('./subscription-sync.js')
        if (syncReady(env)) synced = await syncEntitlement(t.owner, { env })
      } catch { /* 对账不影响正常返回 */ }
      // payBase 下发给客户端：升级/续费链接要跟着**当前实例域名**走，不能写死官方域
      // tiers：MengBot 的**权威套餐表**（名称 + 真实价格）。面板只展示它，绝不自己硬编码价格 ——
      // 两边各自写一份必然开叉（面板 ¥18 / 支付页 ¥39）。拿不到就返回 null，前端据此**不显示数字**。
      let tiers = null
      try {
        const token = String((req.headers && (req.headers.authorization || '')).replace(/^Bearer\s+/i, '') || '')
        tiers = await cachedMarketPlans({ env, token })
      } catch { tiers = null }
      return json(res, 200, {
        ok: true,
        plan: planView(t.owner, env),
        payBase: resolvePayBase({ env, cloudUrl: reqCloudUrl(req) }),
        tiers,
        ...(synced && synced.changed ? { synced: true } : {}),
      })
    }
    if (sub === '/cloud/billing/checkout' && method === 'POST') {
      const t = tenantOf(req)
      if (!t.ok) return json(res, 401, { ok: false, error: t.error })
      const body = await readBody(req)
      // 支付改成**直接拼 subscribe 深链**（MengBot 第 4 封 Q2 确认可行）：
      // 不再代用户调 checkout 端点，因此不需要 omc_ 设备令牌 / OIDC access_token。
      const r = await createCheckout({ plan: body.plan, source: body.source, owner: t.owner, env, cloudUrl: reqCloudUrl(req) })
      return json(res, r.ok ? 200 : 400, r.ok ? { ok: true, url: r.url, plan: r.plan, sku: r.sku } : r)
    }
    // 手动对账：force 覆盖（排查/用户主动刷新用）
    if (sub === '/cloud/billing/refresh' && method === 'POST') {
      const t = tenantOf(req)
      if (!t.ok) return json(res, 401, { ok: false, error: t.error })
      const body = await readBody(req)
      try {
        const { syncEntitlement, syncReady } = await import('./subscription-sync.js')
        if (!syncReady(env)) return json(res, 503, { ok: false, error: '未配置 mbt_ 令牌，对账未启用（见 docs/CLOUD.md）' })
        const r = await syncEntitlement(t.owner, { env, force: body.force !== false })
        return json(res, r.ok ? 200 : 502, { ok: r.ok, changed: r.changed, reason: r.reason, remote: r.remote || null, plan: planView(t.owner, env) })
      } catch (e) {
        return json(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    }
    // 全量核对：读最近一次结果；POST 立即跑一轮（**只记差异，不自动改**）
    if (sub === '/cloud/billing/audit' && (method === 'GET' || method === 'POST')) {
      const t = tenantOf(req)
      if (!t.ok) return json(res, 401, { ok: false, error: t.error })
      try {
        const { readAudit, runAudit, auditDue, syncReady: sr } = await import('./subscription-audit.js')
        const { syncReady } = await import('./subscription-sync.js')
        if (!syncReady(env)) return json(res, 503, { ok: false, error: '未配置 mbt_ 令牌，核对未启用' })
        if (method === 'GET') {
          const last = readAudit(env)
          return json(res, 200, { ok: true, due: auditDue(env), last: last || null })
        }
        const body = await readBody(req)
        const r = await runAudit({ env, ratePerSec: body.ratePerSec, maxTenants: body.maxTenants })
        return json(res, r.ok ? 200 : 502, r)
      } catch (e) {
        return json(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    }

    // ── 商户接入（与「客户端订阅」是两条独立的路）──────────────────────────
    // 客户端订阅：个人用户订阅 personal/pro/max，凭据是 me_ 密钥 / mb_ 会话。
    // 商户接入：商户有自己的云端实例，接入 MengBot 托管，凭据是 mch_ / msk_。
    // 分开的原因见 lib/merchant.js 顶部注释（计量主体不同、泄漏面不同、要能单独吊销）。
    if (sub === '/cloud/merchant/me' && method === 'GET') {
      const t = tenantOf(req)
      if (!t.ok) return json(res, 401, { ok: false, error: t.error })
      try {
        const { listMerchantsByOwner } = await import('./merchant.js')
        return json(res, 200, { ok: true, merchantPlanSku: merchantPlanSku(env), merchantPlanSkus: MERCHANT_SKUS, merchants: listMerchantsByOwner(t.owner, env) })
      } catch (e) {
        return json(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    }
    if (sub === '/cloud/merchant/register' && method === 'POST') {
      const t = tenantOf(req)
      if (!t.ok) return json(res, 401, { ok: false, error: t.error })
      const body = await readBody(req)
      try {
        const { registerMerchant } = await import('./merchant.js')
        const r = registerMerchant({ name: body.name, domain: body.domain, owner: t.owner, env })
        if (!r.ok) return json(res, 400, r)
        // **secret 只在这一次返回**，之后无法取回（只存 hash）
        return json(res, 200, {
          ok: true,
          merchant: r.merchant,
          secret: r.secret,
          secretHint: '商户密钥只显示这一次，请立即保存；泄漏后用「轮换密钥」作废旧值',
          subscribeUrl: merchantSubscribeUrl(r.merchant.id, env, body.sku),
          merchantPlanSku: merchantPlanSku(env, body.sku),
          merchantPlanSkus: MERCHANT_SKUS,
        })
      } catch (e) {
        return json(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    }
    if (sub === '/cloud/merchant/rotate' && method === 'POST') {
      const t = tenantOf(req)
      if (!t.ok) return json(res, 401, { ok: false, error: t.error })
      const body = await readBody(req)
      try {
        const { getMerchant, rotateMerchantSecret } = await import('./merchant.js')
        const m = getMerchant(body.id, env)
        if (!m) return json(res, 404, { ok: false, error: '商户不存在' })
        if (m.owner !== t.owner) return json(res, 403, { ok: false, error: '只能轮换自己名下的商户' })
        const r = rotateMerchantSecret(body.id, env)
        return json(res, r.ok ? 200 : 400, { ...r, secretHint: '新密钥只显示这一次；旧密钥已立即失效' })
      } catch (e) {
        return json(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    }
    if (sub === '/cloud/merchant/revoke' && method === 'POST') {
      const t = tenantOf(req)
      if (!t.ok) return json(res, 401, { ok: false, error: t.error })
      const body = await readBody(req)
      try {
        const { getMerchant, revokeMerchant } = await import('./merchant.js')
        const m = getMerchant(body.id, env)
        if (!m) return json(res, 404, { ok: false, error: '商户不存在' })
        if (m.owner !== t.owner) return json(res, 403, { ok: false, error: '只能吊销自己名下的商户' })
        return json(res, 200, revokeMerchant(body.id, env))
      } catch (e) {
        return json(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    }
    // 商户实例接入校验（商户自己的服务端带 mch_/msk_ 来换权益）
    if (sub === '/cloud/merchant/verify' && method === 'POST') {
      const body = await readBody(req)
      try {
        const { verifyMerchant } = await import('./merchant.js')
        const r = verifyMerchant(body.id, body.secret, env)
        if (!r.ok) return json(res, 401, r)
        return json(res, 200, { ok: true, merchant: r.merchant })
      } catch (e) {
        return json(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    }
    // 连接协商：登录/带令牌后拿这一份就够切客户端（apiBase + 令牌 + 配额 + 客户端去哪儿下）
    if (sub === '/cloud/connect' && method === 'POST') {
      const t = tenantOf(req)
      if (!t.ok) return json(res, 401, { ok: false, error: t.error })
      const m = clientManifest()
      const cfg = publicCloudConfig(env)
      return json(res, 200, {
        ok: true,
        connect: {
          mode: 'cloud',
          owner: t.owner,
          via: t.via,
          apiBase: '/memory-eternal/api',
          vault: t.vaultRoot,
          version: VERSION,
          client: m,
          limits: { maxVaults: 1, maxCardsPerVault: Number(env.MEMORY_CLOUD_MAX_CARDS || 0) || null },
          features: { semantic: true, backup: true, audit: true, cloud: true },
          note: '客户端顶栏「本地运行 ▾ → 连接云端」填本实例地址 + 这串令牌即可',
        },
      })
    }
    return json(res, 404, { ok: false, error: '未知的云端接口' })
  }

  /**
   * 挂到 web.js 的请求链上。命中云端路由返回 true。
   */
  return async function handleCloudRequest(req, res) {
    const url = new URL(req.url, 'http://localhost')
    if (!url.pathname.startsWith(API_PREFIX)) return false
    const sub = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/'
    // 分发层的 HTTP 方法（handleAdminUi / handleAdmin 各自还有一份，那是它们自己的作用域）
    const method = String(req.method || 'GET').toUpperCase()

    // 访问日志（诊断用）：默认开，记录方法/路径/**Origin**/UA。
    // 为什么记 Origin：客户端报「连不上服务端（Failed to fetch）」时，
    // 唯一能区分「请求没到」与「到了但被 CORS 丢弃」的证据就是这条日志里有没有这个请求。
    // Caddy 默认不记访问日志，所以只能在这里记。
    if (String(env.MEMORY_CLOUD_ACCESS_LOG || '1') !== '0') {
      try {
        const o = String(req.headers.origin || '')
        const ua = String(req.headers['user-agent'] || '-').slice(0, 60)
        // 无 Origin = 服务间调用（webhook / curl / 服务端），CORS 不适用。
        // 之前记成 `origin=- cors=DENY`，会让人误以为投递被 CORS 拦了。
        const corsTag = o ? (corsOriginAllowed(o, env) ? 'ok' : 'DENY') : 'n/a（无 Origin，服务间调用）'
        console.error(`[cloud-access] ${req.method} ${sub} origin=${o || '<无>'} cors=${corsTag} ua=${ua}`)
      } catch { /* 日志失败不影响请求 */ }
    }

    // CORS 先于一切：客户端与云端是不同 origin，没有这些头浏览器直接拦请求。
    // 预检（OPTIONS）在这里就回 204，不进业务逻辑（也不能被鉴权拦住 —— 浏览器不会带 Authorization）。
    applyCors(req, res, env)
    if (String(req.method || '').toUpperCase() === 'OPTIONS') {
      res.writeHead(204, { 'Content-Length': '0' })
      res.end()
      return true
    }

    // 体积闸门（审计 H2）：声明就超限 → 立刻 413，别把 body 读进内存再说。
    // 云端多租户下这是「一个租户拖垮全部租户」的最短路径。
    const declaredBytes = Number(req.headers['content-length'])
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
      json(res, 413, {
        ok: false, code: 'payload_too_large',
        error: '请求体过大：上限 ' + Math.round(MAX_BODY_BYTES / 1024 / 1024) + 'MB',
        maxBytes: MAX_BODY_BYTES, declared: declaredBytes,
      })
      return true
    }

    // ── 账号：注册 / 登录 / 登出 / 我是谁 ──────────────────────────────────
    // 自有账号体系（PG 控制面）。MengBot 只是**可选身份源**，不是登录前提。
    if (sub === '/signup' && method === 'POST') {
      if (!(await ensureDb())) return json(res, 503, { ok: false, code: 'db_unavailable', error: '账号库不可用（DATABASE_URL / PG）' })
      const body = await readBody(req)
      const email = normalizeEmail(body && body.email)
      if (!isEmail(email)) return json(res, 400, { ok: false, error: '邮箱格式不正确' })
      const mode = String(env.MEMORY_SIGNUP_MODE || 'open').toLowerCase()
      if (mode === 'invite') {
        const want = String(env.MEMORY_SIGNUP_INVITE || '').trim()
        if (!want || String((body && body.invite) || '').trim() !== want) {
          return json(res, 403, { ok: false, code: 'invite_required', error: '当前为邀请制注册，请填写邀请码' })
        }
      }
      const cu = await createUser({ email, password: String((body && body.password) || ''), displayName: String((body && body.name) || '').slice(0, 60) }, env)
      if (!cu.ok) return json(res, 400, { ok: false, code: cu.code || 'signup_failed', error: cu.error })
      // 本源注册也记一条身份（provider=local）：否则 identities 表只记第三方，
      // 管理端看不出「这个账号是本地注册还是 MengBot 登录来的」。
      try {
        const { q: pgq } = await import('./server-db.js')
        await pgq('INSERT INTO identities(user_id, provider, external_id, email, email_verified) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [cu.user.id, 'local', email, email, true], env)
      } catch { /* 身份记录失败不影响注册 */ }
      // 首把访问密钥（只返回一次）：业务面鉴权目前走 me_ 密钥通道，注册即给一把，用户能立刻用。
      let keyToken = ''
      try { keyToken = issueKey({ owner: email, note: '注册自动签发' }, env).token } catch { keyToken = '' }
      const s = await issueUserSession(cu.user.id, { via: 'password', ip: clientIp(req), ua: req.headers['user-agent'] }, env)
      setCookie(res, COOKIE_USER, s.token, { path: '/memory-eternal/api', secure: reqIsHttps(req) })
      await audit({ actor: email, action: 'signup', target: cu.user.id, detail: { mode }, ip: clientIp(req) }, env)
      return json(res, 200, { ok: true, user: { id: cu.user.id, email: cu.user.email }, token: keyToken, session: s.token, next: '/memory-eternal/api/me' })
    }

    if (sub === '/signin' && method === 'POST') {
      if (!(await ensureDb())) return json(res, 503, { ok: false, code: 'db_unavailable', error: '账号库不可用（DATABASE_URL / PG）' })
      const body = await readBody(req)
      const lr = await loginWithPassword(body && body.email, String((body && body.password) || ''), env)
      if (!lr.ok) {
        await audit({ actor: normalizeEmail(body && body.email), action: 'signin_failed', ip: clientIp(req) }, env)
        return json(res, 401, { ok: false, error: lr.error })
      }
      let keyToken = ''
      if (body && body.withKey) {
        try { keyToken = issueKey({ owner: lr.user.email, note: '登录时签发' }, env).token } catch { keyToken = '' }
      }
      const s = await issueUserSession(lr.user.id, { via: 'password', ip: clientIp(req), ua: req.headers['user-agent'] }, env)
      setCookie(res, COOKIE_USER, s.token, { path: '/memory-eternal/api', secure: reqIsHttps(req) })
      await audit({ actor: lr.user.email, action: 'signin', target: lr.user.id, ip: clientIp(req) }, env)
      return json(res, 200, { ok: true, user: { id: lr.user.id, email: lr.user.email }, session: s.token, ...(keyToken ? { token: keyToken } : {}), next: '/memory-eternal/api/me' })
    }

    if (sub === '/signout' && method === 'POST') {
      const tok = readCookie(req, COOKIE_USER)
      if (tok) { try { await revokeSession(tok, env) } catch { /* 忽略 */ } }
      setCookie(res, COOKIE_USER, '', { path: '/memory-eternal/api', maxAge: 0, secure: reqIsHttps(req) })
      return json(res, 200, { ok: true })
    }

    if (sub === '/me' && method === 'GET') {
      // 浏览器直接打开 → 出账号页；程序调用（fetch / curl）→ 保持 JSON。
      // 之前无脑返回 JSON，用户点登录跳过来看到一屏裸数据。
      const wantsHtml = String((req.headers && req.headers.accept) || '').includes('text/html')
      const bearer = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '').trim()
      const cookieTok = readCookie(req, COOKIE_USER)
      const tok = bearer.startsWith('ms_') ? bearer : cookieTok
      if (wantsHtml) {
        const srHtml = await resolveSession(tok, env).catch(() => ({ ok: false }))
        if (!srHtml.ok) {
          res.writeHead(302, { Location: '/memory-eternal/api/login', 'Cache-Control': 'no-store' })
          res.end()
          return true
        }
        if (!(await ensureDb())) return json(res, 503, { ok: false, code: 'db_unavailable', error: '账号库不可用' })
        const prof = await loginProfile(srHtml.userId)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(accountPage(prof))
        return true
      }
      if (!(await ensureDb())) return json(res, 503, { ok: false, code: 'db_unavailable', error: '账号库不可用' })
      const sr = await resolveSession(tok, env)
      if (!sr.ok) return json(res, 401, { ok: false, code: 'unauthenticated', error: '未登录（' + (sr.reason || 'no-session') + '）', login: '/memory-eternal/api/login' })
      const u = await loginProfile(sr.userId)
      return json(res, 200, { ok: true, ...u })
    }

    // ── 扫码后的「授权注册」：MengBot 资料只读，用户只补一个密码 ──────────
    if (sub === '/cloud/auth/authorize' && method === 'POST') {
      const body = await readBody(req)
      const t = String((body && body.ticket) || '').trim()
      const rec = regTickets.get(t)
      if (!rec) return json(res, 404, { ok: false, code: 'ticket_invalid', error: '授权凭证无效或已过期，请重新扫码' })
      if (Date.now() - rec.at > 10 * 60 * 1000) {
        regTickets.delete(t)
        return json(res, 410, { ok: false, code: 'ticket_expired', error: '授权凭证已过期，请重新扫码' })
      }
      if (!(await ensureDb())) return json(res, 503, { ok: false, code: 'db_unavailable', error: '账号库不可用' })
      const pw = String((body && body.password) || '')
      const bad = passwordProblem(pw)
      if (bad) return json(res, 400, { ok: false, error: bad })
      regTickets.delete(t)   // 一次性：先消费，避免并发重放
      const prof = rec.profile || {}
      const cu = await createUser({ email: rec.email, password: pw, displayName: String(prof.name || '').slice(0, 60) }, env)
      if (!cu.ok) {
        // 邮箱已存在：说明并发下已被注册，退回登录即可
        return json(res, 400, { ok: false, code: cu.code || 'signup_failed', error: cu.error, hint: '该邮箱已有账号，请直接用密码或扫码登录' })
      }
      try {
        await upsertIdentity({
          provider: rec.provider,
          externalId: rec.externalId,
          email: rec.email,
          emailVerified: rec.emailVerified,
          meta: { name: prof.name || '', picture: prof.picture || '' },
          displayName: prof.name || '',
        }, env)
      } catch { /* 身份补写失败不影响注册 */ }
      let keyToken = ''
      try { keyToken = issueKey({ owner: rec.email, note: '扫码注册自动签发' }, env).token } catch { keyToken = '' }
      const s = await issueUserSession(cu.user.id, { via: 'authorize', ip: clientIp(req), ua: req.headers['user-agent'] }, env)
      setCookie(res, COOKIE_USER, s.token, { path: '/memory-eternal/api', secure: reqIsHttps(req) })
      await audit({ actor: rec.email, action: 'signup_authorized', target: cu.user.id, detail: { provider: rec.provider }, ip: clientIp(req) }, env)
      return json(res, 200, { ok: true, user: { id: cu.user.id, email: cu.user.email }, token: keyToken, next: '/memory-eternal/api/me' })
    }

    // 授权注册页（扫码回来的落地页）
    if (sub === '/register/authorize' && method === 'GET') {
      const u = new URL(req.url, 'http://localhost')
      const t = String(u.searchParams.get('ticket') || '').trim()
      const rec = regTickets.get(t)
      if (!rec) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(authorizePage({ error: '授权凭证无效或已过期，请重新扫码', ticket: '' }))
        return true
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(authorizePage({ ticket: t, profile: rec.profile || {}, email: rec.email }))
      return true
    }

    // 授权注册页脚本
    if (sub === '/authorize.js' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(AUTHORIZE_JS)
      return true
    }

    // 二维码（扫码登录用）：GET /cloud/auth/qr?d=<url>
    // 只接受 http(s) 且长度受限 —— 防止被当成任意 QR 生成器滥用。
    if (sub === '/cloud/auth/qr' && method === 'GET') {
      const u = new URL(req.url, 'http://localhost')
      const data = String(u.searchParams.get('d') || '').trim()
      if (!data || data.length > 1200 || !/^https?:\/\//i.test(data)) {
        return json(res, 400, { ok: false, error: '二维码内容非法（需要 http(s) URL，长度 <= 1200）' })
      }
      try {
        const { default: QRCode } = await import('qrcode')
        const svg = await QRCode.toString(data, { type: 'svg', margin: 1, width: 220, errorCorrectionLevel: 'M' })
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(svg)
        return true
      } catch (e) {
        return json(res, 503, { ok: false, code: 'qr_unavailable', error: '二维码生成不可用：' + String((e && e.message) || e).slice(0, 120) })
      }
    }

    // 登录页的脚本（外链，便于缓存与调试）
    if (sub === '/login.js' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(LOGIN_JS)
      return true
    }

    // 独立注册页（与登录分开）
    if (sub === '/register' && method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(registerPage({ signupMode: String(env.MEMORY_SIGNUP_MODE || 'open') }))
      return true
    }

    // 用户端登录页（/login）：只收扫码 / 账号密码 / me_ 密钥，**不收管理令牌**。
    if (sub === '/login' && String(req.method || 'GET').toUpperCase() === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(userLoginPage({ authStart: '/memory-eternal/api/cloud/auth/start' }))
      return true
    }

    // 管理端 UI：/admin（登录页 + 面板）。与用户端登录完全隔离 —— 它只认管理令牌派生的会话，
    // 不认 me_/mbt_ 用户令牌；反之用户端也不接受管理令牌。
    if (sub === '/admin' || sub.startsWith('/admin/')) {
      await handleAdminUi(sub, req, res)
      return true
    }

    // 管理面：不需要租户
    if (sub.startsWith('/cloud/')) {
      await handleAdmin(sub, req, res)
      return true
    }

    // 业务面：必须有合法令牌
    let t = tenantOf(req)
    // `mbt_` 首次出现（缓存里没有）：**当场向 MengBot 校验一次**再放行，
    // 省掉「先调登录接口换令牌」这一步。校验结果缓存 15 分钟（见 MBT_CACHE_TTL_HOURS）。
    if (!t.ok && t.needsVerify) {
      const bearer = tokenOf(req)
      const v = await verifyAndCacheMbtToken(bearer, { env })
      if (v.ok) t = tenantOf(req)
    }
    if (!t.ok) {
      // 区分「完全没带令牌」与「令牌无效」，提示要能指导下一步
      const hint = t.noToken
        ? '未检测到登录状态：请先「用 MengBot 账号登录」，或在设置里填访问密钥'
        : '令牌无效或已过期：请重新登录（或重新填访问密钥）'
      json(res, 401, { ok: false, error: t.error, code: t.noToken ? 'no_token' : 'invalid_token', hint })
      return true
    }

    // 授权降级闸门：license 失效且策略为 readonly/stop 时挡写操作（读/导出照常）。
    // stop 比 readonly 更狠：除诊断类接口外全拒。
    // **按租户判定**（不再是全局 access）
    const tenantAccess = accessFor(t.owner)
    if (!tenantAccess.canWrite) {
      if (lic.degrade === 'readonly' && !allowedWhenReadonly(sub, req.method)) {
        json(res, 403, {
          ok: false, code: 'license_readonly',
          error: '服务端为只读模式（license ' + lic.status + '）' + (lic.expiresAt ? '，到期 ' + lic.expiresAt : ''),
          hint: '读与导出仍可用；续期后重启即可恢复写入',
        })
        return true
      }
      if (lic.degrade === 'stop' && !allowedWhenReadonly(sub, req.method)) {
        json(res, 503, {
          ok: false, code: 'license_stop',
          error: '服务已停用（license ' + lic.status + '）',
          hint: '请联系授权方续期；诊断接口 /cloud/config、/cloud/whoami 仍可用',
        })
        return true
      }
    }

    // ── 配额闸门（套餐上限真正生效的地方）────────────────────────────────
    // 只对**业务面**生效：/cloud/* 是管理面（登录、测连、看套餐），不该被限速挡住，
    // 否则用户一旦超限连「看看自己还剩多少」都做不到。
    if (!SUB_WITHOUT_QUOTA.test(sub)) {
      const q = quotaFor(tenantAccess, env)
      // ① 速率：每个租户每分钟 rpm 次
      const rate = rateLimiter.hit(t.owner, q.rpm)
      res.setHeader('X-RateLimit-Limit', String(rate.limit))
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, rate.limit - rate.used)))
      if (!rate.ok) {
        res.setHeader('Retry-After', String(rate.retryAfterSeconds))
        json(res, 429, quotaExceededBody({
          kind: 'rpm', used: rate.used, limit: rate.limit, plan: q.plan,
          retryAfterSeconds: rate.retryAfterSeconds,
        }))
        return true
      }
      // ② 卡片数：只在「会新增卡片」的写接口上校验，读/改/删不受限
      if (WRITE_PATHS_ADDING_CARDS.has(sub) && req.method === 'POST') {
        let used = 0
        try {
          const { countCards } = await import('./vault.js')
          used = await countCards(t.vaultRoot, {})
        } catch { used = 0 }
        const cardQ = checkCardQuota(used, q)
        if (!cardQ.ok) {
          json(res, 429, quotaExceededBody({ kind: 'cards', used: cardQ.used, limit: cardQ.limit, plan: q.plan }))
          return true
        }
      }
    }

    const handler = apiFor(t)
    await handler(req, res)
    return true
  }
}

export { tenantVault }
