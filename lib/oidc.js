// 标准 OIDC 客户端（authorization_code + client_secret_basic）。
//
// MengBot 侧是 node-oidc-provider（`server/pay/oidc.ts`），clients 白名单里已有
// `admin`（confidential, authorization_code + refresh_token）与 `desktop`（public, device_code）。
// 我们要作为第三个 confidential client 注册：`memory-eternal-cloud`。
//
// 这样写的好处：换任何标准 IdP（Keycloak / Auth0 / Authentik / Zitadel）都能用，
// 不再依赖某家自定义参数。
//
// 只需三件事：拼授权 URL、用 code 换 token、拿 access_token 拉 userinfo。
// id_token 不强制验签 —— 身份最终以 TLS 上拿到的 userinfo 为准（OIDC Core 允许这么做），
// 省掉 JWKS 轮换那一摊。需要更强保证时再打开 `verifyIdToken`。

import crypto from 'node:crypto'

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/** 配置：MEMORY_OIDC_* 或 cloud-keys.json 的 oidc 段。 */
export function readOidcConfig(env = process.env) {
  const pick = (k, alt) => String(env[k] || (alt !== undefined ? alt : '')).trim()
  return {
    issuer: pick('MEMORY_OIDC_ISSUER').replace(/\/+$/, ''),
    clientId: pick('MEMORY_OIDC_CLIENT_ID', 'memory-eternal-cloud'),
    clientSecret: pick('MEMORY_OIDC_CLIENT_SECRET'),
    redirectUri: pick('MEMORY_OIDC_REDIRECT_URI'),
    scope: pick('MEMORY_OIDC_SCOPE', 'openid profile email offline_access'),
    // 显式覆盖（一般不用）：只有部署方想绕过 discovery 时才填
    authorizePath: pick('MEMORY_OIDC_AUTHORIZE_PATH'),
    tokenPath: pick('MEMORY_OIDC_TOKEN_PATH'),
    userinfoPath: pick('MEMORY_OIDC_USERINFO_PATH'),
  }
}

export function oidcReady(cfg) {
  return !!(cfg && cfg.issuer && cfg.clientId && cfg.redirectUri)
}

// ---- endpoint 发现（按 .well-known/openid-configuration，不硬编码路径）------
//
// 为什么必须走 discovery：Issuer 的路径布局各家不同 ——
// MengBot 的是 `https://accounts.mengbot.com.cn/auth`，而不是我们一开始猜的
// `{issuer}/oidc/auth`。硬编码一定会错，且对方换部署就断。
//
// 缓存：内存 1 小时（endpoint 极少变），失败不缓存（下次重试）。

const DISCOVERY_TTL_MS = 60 * 60 * 1000
/** issuer → { at, endpoints } */
const discoveryCache = new Map()

/** 拉一次 discovery 文档（带缓存）。 */
export async function discoverOidc(cfg, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  if (!cfg || !cfg.issuer) return { ok: false, error: 'OIDC 未配置 issuer' }
  const hit = discoveryCache.get(cfg.issuer)
  if (!force && hit && now - hit.at < DISCOVERY_TTL_MS) {
    return { ok: true, endpoints: hit.endpoints, cached: true }
  }
  const url = cfg.issuer + '/.well-known/openid-configuration'
  try {
    const r = await fetchImpl(url, { headers: { Accept: 'application/json' } })
    if (!r.ok) return { ok: false, error: `discovery 拉取失败：HTTP ${r.status}（${url}）` }
    const d = await r.json()
    const endpoints = {
      issuer: String(d.issuer || cfg.issuer).replace(/\/+$/, ''),
      authorizationEndpoint: String(d.authorization_endpoint || ''),
      tokenEndpoint: String(d.token_endpoint || ''),
      userinfoEndpoint: String(d.userinfo_endpoint || ''),
    // 设备码流程（RFC 8628）：桌面端/无浏览器环境的标准登录方式。
    // 发现端点有它不代表本 client 被允许 —— 那是 client 级 grant，调了才知道。
    deviceAuthorizationEndpoint: String(d.device_authorization_endpoint || ''),
    grantTypes: Array.isArray(d.grant_types_supported) ? d.grant_types_supported : [],
      jwksUri: String(d.jwks_uri || ''),
      scopesSupported: Array.isArray(d.scopes_supported) ? d.scopes_supported : [],
      grantTypesSupported: Array.isArray(d.grant_types_supported) ? d.grant_types_supported : [],
      codeChallengeMethods: Array.isArray(d.code_challenge_methods_supported) ? d.code_challenge_methods_supported : [],
      // 显式覆盖优先
      ...(cfg.authorizePath ? { authorizationEndpoint: cfg.issuer + cfg.authorizePath } : {}),
      ...(cfg.tokenPath ? { tokenEndpoint: cfg.issuer + cfg.tokenPath } : {}),
      ...(cfg.userinfoPath ? { userinfoEndpoint: cfg.issuer + cfg.userinfoPath } : {}),
    }
    if (!endpoints.authorizationEndpoint || !endpoints.tokenEndpoint) {
      return { ok: false, error: 'discovery 文档缺少 authorization_endpoint / token_endpoint' }
    }
    discoveryCache.set(cfg.issuer, { at: now, endpoints })
    return { ok: true, endpoints, cached: false }
  } catch (e) {
    return { ok: false, error: 'discovery 连接失败：' + String((e && e.message) || e) }
  }
}

/** 仅供测试：清空 discovery 缓存。 */
export function clearDiscoveryCache() {
  discoveryCache.clear()
}

/**
 * 拼授权 URL。**必须传 endpoints**（来自 discoverOidc），路径不硬编码。
 * 带 PKCE（S256）—— confidential client 也建议带，防 code 被截获后重放。
 * @returns {{ok:boolean, url?:string, state?:string, nonce?:string, codeVerifier?:string, error?:string}}
 */
export function buildAuthorizeUrl(cfg, endpoints, { extraState = '' } = {}) {
  if (!oidcReady(cfg)) {
    return { ok: false, error: 'OIDC 未配置（需要 MEMORY_OIDC_ISSUER / MEMORY_OIDC_CLIENT_ID / MEMORY_OIDC_REDIRECT_URI）' }
  }
  const authz = endpoints && endpoints.authorizationEndpoint
  if (!authz) {
    return { ok: false, error: '缺少 authorization_endpoint（先调用 discoverOidc）' }
  }
  const state = b64url(crypto.randomBytes(18)) + (extraState ? '.' + b64url(Buffer.from(extraState)) : '')
  const nonce = b64url(crypto.randomBytes(18))
  const codeVerifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest())
  const u = new URL(authz)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', cfg.clientId)
  u.searchParams.set('redirect_uri', cfg.redirectUri)
  u.searchParams.set('scope', cfg.scope)
  u.searchParams.set('state', state)
  u.searchParams.set('nonce', nonce)
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  return { ok: true, url: u.toString(), state, nonce, codeVerifier }
}

/** code → tokens（client_secret_basic + PKCE verifier）。endpoint 来自 discovery。 */
export async function exchangeCode(cfg, endpoints, { code, codeVerifier, fetchImpl = fetch } = {}) {
  if (!oidcReady(cfg)) return { ok: false, error: 'OIDC 未配置' }
  if (!code) return { ok: false, error: '缺少 code' }
  const tokenUrl = endpoints && endpoints.tokenEndpoint
  if (!tokenUrl) return { ok: false, error: '缺少 token_endpoint（先调用 discoverOidc）' }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  })
  if (codeVerifier) body.set('code_verifier', codeVerifier)
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (cfg.clientSecret) {
    headers.Authorization = 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64')
  } else {
    body.set('client_id', cfg.clientId) // public client
  }
  try {
    const r = await fetchImpl(tokenUrl, { method: 'POST', headers, body: body.toString() })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d.access_token) {
      return { ok: false, error: '换令牌失败：' + (d.error_description || d.error || ('HTTP ' + r.status)) }
    }
    return {
      ok: true,
      accessToken: d.access_token,
      refreshToken: d.refresh_token || '',
      idToken: d.id_token || '',
      tokenType: d.token_type || 'Bearer',
      expiresIn: Number(d.expires_in) || 0,
      scope: d.scope || cfg.scope,
    }
  } catch (e) {
    return { ok: false, error: '连接 OIDC 失败：' + String((e && e.message) || e) }
  }
}

/** access_token → userinfo（拿 sub / email / name）。endpoint 来自 discovery。 */
export async function fetchUserInfo(cfg, endpoints, accessToken, { fetchImpl = fetch } = {}) {
  if (!oidcReady(cfg)) return { ok: false, error: 'OIDC 未配置' }
  if (!accessToken) return { ok: false, error: '缺少 access_token' }
  const url = endpoints && endpoints.userinfoEndpoint
  if (!url) {
    // 有的 provider 不暴露 userinfo：退回用 id_token 里的 claims 太脆，直接明说
    return { ok: false, error: 'discovery 未提供 userinfo_endpoint' }
  }
  try {
    const r = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + accessToken } })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: '拉取用户信息失败：' + (d.error || ('HTTP ' + r.status)) }
    const owner = String(d.email || d.sub || d.preferred_username || '').trim()
    if (!owner) return { ok: false, error: 'userinfo 里没有 sub/email' }
    // picture：MengBot 的 userinfo 可能给也可能不给；给了就用它做头像，没给前端用字母头像兜底。
    const picture = String(d.picture || d.avatar || d.avatar_url || '').trim()
    return { ok: true, owner, sub: d.sub || '', email: d.email || '', name: d.name || '', picture, raw: d }
  } catch (e) {
    return { ok: false, error: '连接 OIDC 失败：' + String((e && e.message) || e) }
  }
}

/** 一回到底：code → tokens → userinfo（endpoints 由调用方先 discover）。 */
export async function completeOidcLogin(cfg, endpoints, { code, codeVerifier, fetchImpl = fetch } = {}) {
  const t = await exchangeCode(cfg, endpoints, { code, codeVerifier, fetchImpl })
  if (!t.ok) return t
  const u = await fetchUserInfo(cfg, endpoints, t.accessToken, { fetchImpl })
  if (!u.ok) return u
  // profile：只挑展示用的三项，别把整个 userinfo 原样透传（可能含地址、电话等）
  const profile = { name: String(u.name || '').slice(0, 80), email: String(u.email || '').slice(0, 120), picture: String(u.picture || '').slice(0, 400) }
  return { ok: true, owner: u.owner, user: u.raw, tokens: t, profile }
}

/** 给 MengBot 注册用的客户端条目（贴进 `server/pay/oidc.ts` 的 clients 数组）。
 * @returns {object} node-oidc-provider 的 client 配置形状
 */
export function oidcClientRegistration({ baseUrl, clientSecret, extraRedirects = [] } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  const redirects = [
    ...(base ? [base + '/memory-eternal/api/cloud/auth/callback'] : []),
    'http://127.0.0.1:7999/memory-eternal/api/cloud/auth/callback',
    ...extraRedirects,
  ]
  return {
    client_id: 'memory-eternal-cloud',
    client_secret: clientSecret || '<MEMORY_OIDC_CLIENT_SECRET>',
    redirect_uris: redirects,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
    scope: 'openid profile email offline_access',
  }
}

// ---- PKCE verifier 暂存（state → verifier，5 分钟一次性）--------------------
const PKCE_TTL_MS = 5 * 60 * 1000
const pkce = new Map()

export function rememberPkce(state, codeVerifier, now = Date.now()) {
  for (const [k, v] of pkce) if (now - v.at > PKCE_TTL_MS) pkce.delete(k)
  pkce.set(String(state), { codeVerifier, at: now })
}

/** 取一次即删（防重放）。 */
export function takePkce(state, now = Date.now()) {
  const k = String(state || '')
  const hit = pkce.get(k)
  if (!hit) return { ok: false, error: 'state 无效或已过期（请重新发起登录）' }
  pkce.delete(k)
  if (now - hit.at > PKCE_TTL_MS) return { ok: false, error: 'state 已过期（超过 5 分钟）' }
  return { ok: true, codeVerifier: hit.codeVerifier }
}

// ---- refresh_token 续期（拿到的不能丢，否则过期只能重新跳登录）-------------
//
// 存到 `<DSH_HOME>/cloud-oidc-refresh.json`（0600），按 owner 索引，只留最近 200 条。
// 续期时用 refresh_token 换新 access_token；失败（被撤销/过期）就清掉，让用户重新登录。

import fsSync from 'node:fs'
import pathSync from 'node:path'
import osSync from 'node:os'

function refreshStorePath(env) {
  const home = env.DSH_HOME || pathSync.join(osSync.homedir(), '.dsh')
  return pathSync.join(home, 'cloud-oidc-refresh.json')
}

/**
 * refresh_token 缓存路径。
 *
 * **按租户分文件**：原来是全局 `cloud-oidc-refresh.json` 里的一个 map，
 * 文件里同时存着**所有用户**的长效凭据 —— 一旦文件泄漏，所有人的登录态一起完。
 * 分文件后每个租户一个 0600 文件，泄漏面缩小，且单个文件损坏不波及其他租户。
 *
 * 无 owner 时回落旧路径（兼容/迁移用）。
 */
export function refreshStorePath_(env = process.env, owner = '') {
  const home = env.DSH_HOME || pathSync.join(osSync.homedir(), '.dsh')
  const who = String(owner || '').trim()
  if (!who) return refreshStorePath(env)
  return pathSync.join(home, 'cloud-oidc-refresh-' + encodeURIComponent(who).slice(0, 120) + '.json')
}

/** 读某个租户的 refresh 记录（无 owner 时返回旧版全局 map）。 */
export function readRefreshStore(env = process.env, owner = '') {
  try {
    const raw = JSON.parse(fsSync.readFileSync(refreshStorePath_(env, owner), 'utf8'))
    if (!raw || typeof raw !== 'object') return {}
    // 分文件模式下文件内容就是该 owner 的记录；旧全局模式是 map —— 统一成 map 返回
    if (owner && raw.refreshToken) return { [String(owner)]: raw }
    return raw
  } catch { return {} }
}

export function storeRefreshToken(owner, refreshToken, env = process.env) {
  if (!owner || !refreshToken) return { ok: false, error: '缺 owner 或 refresh_token' }
  try {
    const f = refreshStorePath_(env, owner)
    fsSync.mkdirSync(pathSync.dirname(f), { recursive: true })
    // 分文件模式下文件里只放这一个 owner 的记录（不再需要 200 条上限兜底）
    const payload = owner
      ? { refreshToken, at: new Date().toISOString() }
      : { [String(owner)]: { refreshToken, at: new Date().toISOString() } }
    fsSync.writeFileSync(f, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

export function forgetRefreshToken(owner, env = process.env) {
  // 分文件模式下"删除"就是删掉这个租户的文件
  try {
    const f = refreshStorePath_(env, owner)
    if (fsSync.existsSync(f)) fsSync.unlinkSync(f)
    return { ok: true }
  } catch { return { ok: true } }
}

// ---- access_token 短期缓存（支付等「代用户调 MengBot」的场景要用）-------------
//
// 为什么不复用 refresh_store：refresh 是长期凭据，access 是短期的（通常 1 小时），
// 混在一起容易误用。这里单独存 `cloud-oidc-access.json`（0600）。

function accessStorePath(env) {
  const home = env.DSH_HOME || pathSync.join(osSync.homedir(), '.dsh')
  return pathSync.join(home, 'cloud-oidc-access.json')
}

export function readAccessStore(env = process.env) {
  try {
    const raw = JSON.parse(fsSync.readFileSync(accessStorePath(env), 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

export function storeAccessToken(owner, { accessToken, expiresIn = 3600, scope = '' }, env = process.env) {
  if (!owner || !accessToken) return { ok: false, error: '缺 owner 或 access_token' }
  const store = readAccessStore(env)
  // 提前 60 秒过期，避免边界
  const expiresAt = new Date(Date.now() + Math.max(60, expiresIn - 60) * 1000).toISOString()
  store[String(owner)] = { accessToken, scope, expiresAt, at: new Date().toISOString() }
  const entries = Object.entries(store).slice(-200)
  try {
    const f = accessStorePath(env)
    fsSync.mkdirSync(pathSync.dirname(f), { recursive: true })
    fsSync.writeFileSync(f, JSON.stringify(Object.fromEntries(entries), null, 2) + '\n', { mode: 0o600 })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 取一个**可用**的 access_token：缓存里还有效就用它，否则用 refresh 换新的。
 * @returns {{ok:boolean, accessToken?:string, refreshed?:boolean, error?:string}}
 */
export async function getValidAccessToken(cfg, endpoints, owner, { env = process.env, fetchImpl = fetch } = {}) {
  const rec = readAccessStore(env)[owner]
  if (rec && rec.accessToken && rec.expiresAt && Date.parse(rec.expiresAt) > Date.now()) {
    return { ok: true, accessToken: rec.accessToken, refreshed: false }
  }
  const r = await refreshAccessToken(cfg, endpoints, owner, { env, fetchImpl })
  if (!r.ok) return r
  storeAccessToken(owner, { accessToken: r.accessToken, expiresIn: r.expiresIn || 3600 }, env)
  return { ok: true, accessToken: r.accessToken, refreshed: true }
}

/** 用 refresh_token 换新的 access_token（失败自动清掉失效的 refresh）。 */
/**
 * 同一个 owner 的刷新单飞（single-flight）。
 *
 * 为什么必须单飞：MengBot 的 refresh_token 是**一次性轮换**的（C1 答复原文：
 * "每次刷新签发新 token，旧 token 立即失效"）。如果两个调用同时读到 T1：
 *   A 用 T1 刷新 → 成功，得到 T2，存 T2
 *   B 用 T1 刷新 → T1 已失效 → 失败 →（旧实现）forgetRefreshToken 清掉 **T2**
 * 结果用户登录态彻底丢失，只能重新登录。这不是理论风险 ——
 * getValidAccessToken 会被 /cloud/billing/plan、/cloud/billing/checkout 等多处调用。
 */
const refreshInflight = new Map()

export async function refreshAccessToken(cfg, endpoints, owner, { fetchImpl = fetch, env = process.env } = {}) {
  const key = String(owner || '')
  if (refreshInflight.has(key)) return refreshInflight.get(key)
  const task = doRefreshAccessToken(cfg, endpoints, owner, { fetchImpl, env })
    .finally(() => { refreshInflight.delete(key) })
  refreshInflight.set(key, task)
  return task
}

async function doRefreshAccessToken(cfg, endpoints, owner, { fetchImpl = fetch, env = process.env } = {}) {
  const store = readRefreshStore(env, owner)
  const rec = store[owner]
  if (!rec || !rec.refreshToken) return { ok: false, error: '没有可用的 refresh_token（需重新登录）' }
  const tokenUrl = endpoints && endpoints.tokenEndpoint
  if (!tokenUrl) return { ok: false, error: '缺少 token_endpoint（先调用 discoverOidc）' }
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rec.refreshToken })
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (cfg.clientSecret) headers.Authorization = 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64')
  else body.set('client_id', cfg.clientId)
  try {
    const r = await fetchImpl(tokenUrl, { method: 'POST', headers, body: body.toString() })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d.access_token) {
      // **不要无条件清令牌**：如果是并发导致的 invalid_grant，另一个请求可能已经轮换成功了。
      // 先看库里的 token 是否已被换掉 —— 变了就说明别人成功，此时清掉等于把新的也毁了。
      let fresh = null
      try { fresh = readRefreshStore(env, owner)[owner] } catch { /* 忽略 */ }
      if (fresh && fresh.refreshToken && fresh.refreshToken !== rec.refreshToken) {
        return { ok: false, error: '并发刷新：令牌已被另一个请求轮换，请重试' }
      }
      forgetRefreshToken(owner, env)
      return { ok: false, error: 'refresh 失败（已清除）：' + (d.error_description || d.error || ('HTTP ' + r.status)) }
    }
    if (d.refresh_token) storeRefreshToken(owner, d.refresh_token, env) // 轮换
    return { ok: true, accessToken: d.access_token, expiresIn: Number(d.expires_in) || 0 }
  } catch (e) {
    return { ok: false, error: '连接 OIDC 失败：' + String((e && e.message) || e) }
  }
}


// ── 设备码流程（RFC 8628）────────────────────────────────────────────
//
// 为什么用它：桌面应用（Electron，页面 origin 是 dsh-app://app）**没法走授权码流程** ——
// OIDC 的 interaction cookie 种在 accounts.mengbot.com.cn 域上，跨不到自定义协议页面，
// 授权页会直接判「不在同一个浏览器里」并 400。
// 设备码流程没有这个问题：应用只负责显示一个短码，用户在任何设备（手机/浏览器）输入并授权，
// 应用轮询拿 token。RFC 8252 §6 明确把它列为桌面/CLI 的推荐方案之一。
//
// 前提：IdP 支持 device_authorization_endpoint，且**本 client 被允许**
// device_code grant。缺后者时端点会返回 "not allowed for this client"。

/** 发起设备码授权：返回 user_code / verification_uri / interval。 */
export async function startDeviceAuth(cfg, endpoints, { scope = '', fetchImpl = fetch } = {}) {
  if (!oidcReady(cfg)) return { ok: false, error: 'OIDC 未配置' }
  const url = endpoints && endpoints.deviceAuthorizationEndpoint
  if (!url) {
    return { ok: false, code: 'device_unsupported', error: 'IdP 未提供 device_authorization_endpoint' }
  }
  const body = new URLSearchParams({ scope: scope || cfg.scope || 'openid profile email offline_access' })
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (cfg.clientSecret) {
    headers.Authorization = 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64')
  } else {
    body.set('client_id', cfg.clientId)
  }
  try {
    const r = await fetchImpl(url, { method: 'POST', headers, body: body.toString() })
    const d = await r.json().catch(() => ({}))
    if (!r.ok || !d.device_code) {
      const msg = String(d.error_description || d.error || ('HTTP ' + r.status))
      // 把「client 没被允许这个 grant」识别出来 —— 这是部署侧要改的一行配置，
      // 不识别的话用户只会看到"登录失败"，无从排查。
      const notAllowed = /not allowed for this client/i.test(msg)
      return {
        ok: false,
        code: notAllowed ? 'grant_not_allowed' : 'device_start_failed',
        error: notAllowed
          ? 'IdP 已支持设备码登录，但当前 client 未被允许 device_code grant（需要 IdP 侧在 client 配置里加 urn:ietf:params:oauth:grant-type:device_code）'
          : '发起设备码授权失败：' + msg,
        raw: d,
      }
    }
    return {
      ok: true,
      deviceCode: String(d.device_code),
      userCode: String(d.user_code || ''),
      verificationUri: String(d.verification_uri || d.verification_url || ''),
      verificationUriComplete: String(d.verification_uri_complete || ''),
      expiresIn: Number(d.expires_in) || 600,
      interval: Math.max(1, Number(d.interval) || 5),
    }
  } catch (e) {
    return { ok: false, code: 'network', error: '连接 IdP 失败：' + String((e && e.message) || e) }
  }
}

/**
 * 轮询设备码结果（单次）。
 * @returns {{ok:boolean, pending?:boolean, tokens?:object, error?:string, code?:string}}
 *   pending=true 表示用户还没授权，调用方按 interval 再来；
 *   ok=true 才拿到令牌。
 */
export async function pollDeviceToken(cfg, endpoints, deviceCode, { fetchImpl = fetch } = {}) {
  if (!oidcReady(cfg)) return { ok: false, error: 'OIDC 未配置' }
  const url = endpoints && endpoints.tokenEndpoint
  if (!url) return { ok: false, error: '缺少 token_endpoint' }
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: String(deviceCode || ''),
  })
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (cfg.clientSecret) {
    headers.Authorization = 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64')
  } else {
    body.set('client_id', cfg.clientId)
  }
  try {
    const r = await fetchImpl(url, { method: 'POST', headers, body: body.toString() })
    const d = await r.json().catch(() => ({}))
    if (r.ok && d.access_token) {
      return {
        ok: true,
        tokens: {
          accessToken: d.access_token,
          refreshToken: d.refresh_token || '',
          idToken: d.id_token || '',
          tokenType: d.token_type || 'Bearer',
          expiresIn: Number(d.expires_in) || 0,
          scope: d.scope || '',
        },
      }
    }
    const err = String(d.error || '')
    // authorization_pending / slow_down 都是"继续等"，不是失败
    if (err === 'authorization_pending' || err === 'slow_down') {
      return { ok: false, pending: true, code: err }
    }
    if (err === 'expired_token') return { ok: false, code: 'expired', error: '设备码已过期，请重新发起登录' }
    if (err === 'access_denied') return { ok: false, code: 'denied', error: '用户拒绝了授权' }
    return { ok: false, code: 'poll_failed', error: '获取令牌失败：' + (d.error_description || err || ('HTTP ' + r.status)) }
  } catch (e) {
    return { ok: false, code: 'network', error: '连接 IdP 失败：' + String((e && e.message) || e) }
  }
}
