// 多租户云端服务层：**按密钥把请求路由到各自的 SQLite 库**。
//
// 结构：
//   /memory-eternal/api/cloud/*        管理面（发密钥 / 列密钥 / 吊销 / MengBot 登录 / 配置），不需要租户
//   /memory-eternal/api/<其它>         业务面：先解析 Authorization → 选中该租户的 vault → 交给它自己的 api 实例
//
// 为什么每个租户一个 `createApi` 实例：`createApi` 的 vault 是构造期注入的闭包，
// 而它内部缓存了 embedJobs / probeCache / 类型缓存等**按库隔离**的状态 ——
// 复用同一个实例会把不同人的状态串在一起。一个租户一个实例，物理隔离最省心。

import { createApi, API_PREFIX } from './api.js'
import { statSync, createReadStream, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveTenant, tenantVault, cloudRoot, issueKey, listKeys, revokeKey, verifyMengbotLogin, publicCloudConfig, startMengbotAuth, completeMengbotAuth, issueSessionTokenForOwner, verifyAndCacheMbtToken, revokeSessionToken, readCookieFromHeader } from './cloud-auth.js'
import { licenseState, licenseSummary, allowedWhenReadonly } from './license.js'
import { resolveAccess, accessSummary } from './entitlement.js'
import { verifyWebhookSignature, applyWebhookEvent, webhookSecret, HEADERS } from './webhook.js'
import { readOidcConfig, oidcReady, buildAuthorizeUrl, rememberPkce, takePkce, completeOidcLogin, storeRefreshToken, storeAccessToken, discoverOidc } from './oidc.js'
import { createCheckout, planView } from './billing.js'
import { quotaFor, createRateLimiter, checkCardQuota, quotaExceededBody } from './quota.js'
// LRU 淘汰时要把该租户的 SQLite 连接关掉。用**静态 import**（而不是 await import）：
// 异步关闭会留出「表里已删、连接还没关」的窗口，紧接着重建同租户就可能踩到刚被关的连接。
import { closeDb } from './db.js'

/** 服务端版本：优先调用方传入，其次读插件自己的 package.json（云端的 version 字段用于客户端兼容判断）。 */
const pkgVersion = (fallback = '') => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || fallback }
  catch { return fallback }
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
  res.end(body)
}

const readBody = (req) => new Promise((resolve) => {
  let d = ''
  req.on('data', (c) => { d += c; if (d.length > 8 * 1024 * 1024) req.destroy() })
  req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}) } catch { resolve({}) } })
  req.on('error', () => resolve({}))
})

/**
 * 会话 cookie（用于 web 端登录墙）。
 * HttpOnly：前端读不到，避免 XSS 偷走；Secure：只走 https；SameSite=Lax：回跳时能带上。
 */
const sessionCookie = (token, maxAgeSeconds = 7 * 24 * 3600) =>
  `me_cloud_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`

/** 清 cookie（登出）。 */
const clearSessionCookie = () => 'me_cloud_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'

/** Webhook 需要**原始 body**（验签必须对原始字节算 HMAC，不能被 JSON 重排破坏） */
const readRawBody = (req) => new Promise((resolve) => {
  let d = ''
  req.on('data', (c) => { d += c; if (d.length > 8 * 1024 * 1024) req.destroy() })
  req.on('end', () => resolve(d))
  req.on('error', () => resolve(''))
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

  /** 淘汰一个租户实例：关掉它的 SQLite 连接，再从表里删掉。 */
  function evictTenant(owner) {
    const rec = tenants.get(owner)
    if (!rec) return
    tenants.delete(owner)
    // closeDb 幂等：关掉后 getDb 会按需重建，所以不会让这个租户"永久坏掉"
    try { closeDb(rec.vaultRoot) } catch { /* 已经坏了就算了 */ }
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
   *   ② 没配 → **只允许本机回环**访问（127.0.0.1 / ::1 / 172.17.0.1 这类内网地址），
   *      公网来源一律 403，并提示去配 token。
   *
   * `/cloud/whoami`、`/cloud/connect`、`/cloud/client/manifest` 仍然只认租户令牌，不受影响。
   */
  const adminToken = () => String(env.MEMORY_CLOUD_ADMIN_TOKEN || '').trim()
  const isLoopback = (req) => {
    const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '')
    return ip === '127.0.0.1' || ip === '::1' || ip === '172.17.0.1' || /^172\.(1[7-9]|2\d|3[01])\./.test(ip) || /^10\./.test(ip) || /^192\.168\./.test(ip)
  }
  const adminAllowed = (req) => {
    const want = adminToken()
    if (!want) return isLoopback(req)
    const h = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
    const x = String(req.headers['x-admin-token'] || '').trim()
    return h === want || x === want
  }
  const ADMIN_PATHS = /^\/cloud\/(keys|config)(\/|$)/

  /**
   * 取请求里的令牌：**Authorization 头优先，其次 HttpOnly cookie**。
   *
   * 为什么要认 cookie：登录成功后服务端种了 `me_cloud_token`（HttpOnly）。
   * 同源场景（客户端页面就跑在 mem.mengbot.com.cn 上）浏览器会自动带 cookie，
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

  /** 解析租户（统一走 tokenOf，header 与 cookie 都认）。 */
  const tenantOf = (req) => {
    const tok = tokenOf(req)
    return tok ? resolveTenant('Bearer ' + tok, env) : { ok: false, error: '缺少 Authorization: Bearer <token>', noToken: true }
  }
  /**
   * 取（或懒创建）某租户的 api handler，同时维护 LRU。
   * 命中的实例会被重新插到队尾（Map 保持插入顺序 = 访问顺序）。
   */
  const apiFor = (owner, vaultRoot) => {
    const now = Date.now()
    const hit = tenants.get(owner)
    if (hit) {
      hit.lastUsed = now
      // 提升到队尾：删了重插，Map 的迭代顺序就是 LRU 顺序
      tenants.delete(owner)
      tenants.set(owner, hit)
      return hit.handler
    }
    // 满了就淘汰最久未用的（Map 的第一个 key）
    while (tenants.size >= MAX_TENANTS) {
      const oldest = tenants.keys().next().value
      if (oldest === undefined) break
      evictTenant(oldest)
    }
    const handler = createApi({
      vaultDir: () => vaultRoot,
      vaultRoots: () => [{ name: owner, root: vaultRoot }],
      getSettings: () => onSettings(),
    })
    tenants.set(owner, { handler, vaultRoot, lastUsed: now })
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
  const handleAdmin = async (sub, req, res) => {
    const method = String(req.method || 'GET').toUpperCase()
    // 管理面闸门：签发/吊销密钥、读配置 —— 未通过就 403（防止公网裸奔签发）
    if (ADMIN_PATHS.test(sub) && !adminAllowed(req)) {
      const hasToken = !!adminToken()
      return json(res, 403, {
        ok: false, code: 'admin_required',
        error: hasToken ? '管理令牌无效（Authorization: Bearer <MEMORY_CLOUD_ADMIN_TOKEN>）' : '管理面仅允许本机访问（未配置 MEMORY_CLOUD_ADMIN_TOKEN）',
        hint: hasToken ? '带上正确的管理令牌再试' : '在服务端设置 MEMORY_CLOUD_ADMIN_TOKEN 后，用 Authorization: Bearer <它> 访问',
      })
    }
    // license 摘要只给脱敏字段（status/plan/到期/剩余天数），不给 license 原文
    if (sub === '/cloud/config' && method === 'GET') return json(res, 200, { ok: true, version: VERSION, license: licenseSummary(lic), access: accessSummary(resolveAccess(env)), ...publicCloudConfig(env) })
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
      const r = await verifyMengbotLogin({
        token: body.token || '',
        email: body.email || '',
        otp: body.otp || body.code || '',
        env,
      })
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
      // ① 有 OIDC 配置 → 走标准 authorization_code（PKCE S256）
      const oc = readOidcConfig(env)
      if (oidcReady(oc)) {
        // endpoint 一律从 .well-known/openid-configuration 拿，不硬编码路径
        // （MengBot 的是 https://accounts.mengbot.com.cn/auth，不是 {issuer}/oidc/auth）
        const disc = await discoverOidc(oc)
        if (!disc.ok) return json(res, 502, { ok: false, code: 'oidc_discovery_failed', error: disc.error })
        const built = buildAuthorizeUrl(oc, disc.endpoints, { extraState: back })
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
        const local = issueSessionTokenForOwner(done.owner, 'oidc', env)
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
      const back = String(u.searchParams.get('redirect_uri') || r.redirectUri || env.MEMORY_CLOUD_PUBLIC_URL || '/').trim()
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
      return json(res, 200, { ok: true, owner: t.owner, via: t.via, vaultRoot: t.vaultRoot, cloudRoot: cloudRoot(env) })
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
      return json(res, 200, {
        ok: true,
        plan: planView(t.owner, env),
        ...(synced && synced.changed ? { synced: true } : {}),
      })
    }
    if (sub === '/cloud/billing/checkout' && method === 'POST') {
      const t = tenantOf(req)
      if (!t.ok) return json(res, 401, { ok: false, error: t.error })
      const body = await readBody(req)
      // 支付改成**直接拼 subscribe 深链**（MengBot 第 4 封 Q2 确认可行）：
      // 不再代用户调 checkout 端点，因此不需要 omc_ 设备令牌 / OIDC access_token。
      const r = await createCheckout({ plan: body.plan, source: body.source, owner: t.owner, env })
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

    const handler = apiFor(t.owner, t.vaultRoot)
    await handler(req, res)
    return true
  }
}

export { tenantVault }
