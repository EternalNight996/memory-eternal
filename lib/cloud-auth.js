// 云端多租户鉴权：**每人一把密钥 → 每人一个独立 SQLite**。
//
// 设计取舍（用户拍板的架构）：
//   · 不用 PG、不动现有 SQLite 写入路径 —— 云端就是一个"能按密钥分库"的服务端；
//   · 每个用户一个独立 vault 目录（`$DSH_HOME/cloud-vaults/<owner>/memory-eternal.db`），
//     彼此物理隔离：一个人的库坏了/被删了，不会影响别人；
//   · 两种进门方式：① 云端签发的 Bearer 密钥；② MengBot 授权登录换来的令牌。
//
// 密钥只存 sha256（明文只在创建时返回一次），文件 0600。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const KEY_PREFIX = 'me_'
const KEY_BYTES = 24

/** 云端根目录（所有租户库的父目录）。 */
export function cloudRoot(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'cloud-vaults')
}

/** 密钥台账文件（只存哈希）。 */
export function keyStorePath(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'cloud-keys.json')
}

/** 单个租户的 vault 目录：owner 做文件名前缀，顺便挡掉路径穿越。 */
export function tenantVault(owner, env = process.env) {
  const safe = String(owner || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 64)
  if (!safe) throw new Error('owner 不合法')
  return path.join(cloudRoot(env), safe)
}

export function hashCode(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex')
}

function readStore(env) {
  try {
    const raw = JSON.parse(fs.readFileSync(keyStorePath(env), 'utf8'))
    return { version: 1, keys: Array.isArray(raw.keys) ? raw.keys : [], mengbot: raw.mengbot || {}, ...{} }
  } catch {
    return { version: 1, keys: [], mengbot: {} }
  }
}

function writeStore(store, env) {
  const file = keyStorePath(env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  return store
}

/** 签发一把密钥：返回**明文一次**，库里只留哈希。 */
export function issueKey({ owner, note = '', vault = '' } = {}, env = process.env) {
  const name = String(owner || '').trim()
  if (!name) throw new Error('缺少 owner（这个密钥属于谁）')
  const token = KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString('base64url')
  const store = readStore(env)
  const rec = {
    id: 'k_' + crypto.randomBytes(6).toString('hex'),
    owner: name,
    hash: hashCode(token),
    note: String(note || '').slice(0, 120),
    vault: String(vault || ''),
    createdAt: new Date().toISOString(),
    lastUsedAt: '',
    revoked: false,
  }
  store.keys = [...store.keys, rec]
  writeStore(store, env)
  return { token, key: publicKey(rec) }
}

const publicKey = (k) => ({
  id: k.id, owner: k.owner, note: k.note, vault: k.vault || '',
  createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || '', revoked: !!k.revoked,
})

/** 列出密钥（**不含明文与哈希**）。 */
export function listKeys(env = process.env) {
  return readStore(env).keys.map(publicKey)
}

export function revokeKey(id, env = process.env) {
  const store = readStore(env)
  const hit = store.keys.find((k) => k.id === id)
  if (!hit) return { ok: false, error: '没有这把密钥' }
  hit.revoked = true
  writeStore(store, env)
  return { ok: true, key: publicKey(hit) }
}

/**
 * 用 token 换租户：命中返回 `{ ok, owner, vaultRoot, via }`；不命中返回 `{ ok:false, error }`。
 * via = `key`（云端密钥）或 `mengbot`（MengBot 令牌）。
 */
export function resolveTenant(authorization = '', env = process.env) {
  const raw = String(authorization || '').trim()
  const token = raw.replace(/^Bearer\s+/i, '').trim()
  if (!token) return { ok: false, error: '缺少 Authorization: Bearer <token>' }
  const store = readStore(env)

  if (token.startsWith(KEY_PREFIX)) {
    const h = hashCode(token)
    const hit = store.keys.find((k) => k.hash === h && !k.revoked)
    if (!hit) return { ok: false, error: '密钥无效或已吊销' }
    hit.lastUsedAt = new Date().toISOString()
    writeStore(store, env)
    const vault = hit.vault || tenantVault(hit.owner, env)
    return { ok: true, owner: hit.owner, vaultRoot: vault, via: 'key', keyId: hit.id }
  }

  // MengBot 令牌：由 oauth 校验后写入 `store.mengbot.sessions`（见 verifyMengbotLogin）
  const sess = (store.mengbot.sessions || []).find((s) => s.token === token)
  if (sess && (!sess.expiresAt || Date.parse(sess.expiresAt) > Date.now())) {
    return { ok: true, owner: sess.owner, vaultRoot: tenantVault(sess.owner, env), via: sess.via || 'mengbot' }
  }

  // MengBot 直接签发的 API token（`mbt_` 前缀）：服务端不落库，靠 MengBot 侧校验。
  // 这里只做**前缀识别**，实际校验由调用方打 MengBot 的 introspection / userinfo 完成
  // （见 lib/cloud-server.js 的 `/cloud/whoami` 与 `POST /cloud/login/mengbot {token}`）。
  // 为什么要单独一个前缀：便于 MengBot 侧按 token 限流与撤销，也便于我们在日志里区分来源。
  if (token.startsWith('mbt_')) {
    const cached = (store.mengbot.mbtCache || {})[hashCode(token)]
    if (cached && (!cached.expiresAt || Date.parse(cached.expiresAt) > Date.now())) {
      return { ok: true, owner: cached.owner, vaultRoot: tenantVault(cached.owner, env), via: 'mengbot-token' }
    }
    return { ok: false, error: 'mbt_ 令牌需要先通过 MengBot 校验（POST /cloud/login/mengbot {token} 或 GET /cloud/auth/start）', needsVerify: true }
  }
  return { ok: false, error: '无法识别的令牌' }
}

/** 签一个本地令牌并计入会话表（与密钥一样解析成独立 vault）。 */
function issueSessionToken({ owner, via, ttlHours, env }) {
  const store = readStore(env)
  const token = 'mb_' + crypto.randomBytes(20).toString('base64url')
  const sessions = [...((store.mengbot && store.mengbot.sessions) || []).slice(-200), {
    token, owner, via, at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlHours * 3600000).toISOString(),
  }]
  store.mengbot = { ...(store.mengbot || {}), sessions }
  writeStore(store, env)
  return token
}

/** 吊销一个本地会话令牌（登出）。 */
export function revokeSessionToken(token, env = process.env) {
  const raw = String(token || '').trim()
  if (!raw) return { ok: false, error: '缺 token' }
  const store = readStore(env)
  const sessions = (store.mengbot && store.mengbot.sessions) || []
  const next = sessions.filter((s) => s.token !== raw)
  if (next.length === sessions.length) return { ok: false, error: '会话不存在' }
  store.mengbot = { ...(store.mengbot || {}), sessions: next }
  writeStore(store, env)
  return { ok: true }
}

/** 从 Cookie 头里取一个值（极简，够用）。 */
export function readCookieFromHeader(header, name) {
  const raw = String(header || '')
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return ''
}

/** 给已通过外部 IdP 校验的用户签发本地令牌（OIDC 回调用）。 */
export function issueSessionTokenForOwner(owner, via = 'oidc', env = process.env) {
  const name = String(owner || '').trim()
  if (!name) return { ok: false, error: '缺少 owner' }
  const ttlHours = readMengbotConfig(env).ttlHours || 168
  const token = issueSessionToken({ owner: name, via, ttlHours, env })
  return { ok: true, token, owner: name, via, vaultRoot: tenantVault(name, env), expiresInHours: ttlHours }
}

/** 把校验通过的 `mbt_` token 记进缓存（供后续请求直接放行，避免每请求打 MengBot）。 */
/**
 * `mbt_` 校验缓存 TTL：**15 分钟**（不是 24h）。
 *
 * 为什么这么短：`mbt_` 可随时被 MengBot 侧撤销，缓存太长会让「撤销」滞后一整天。
 * 15 分钟对应约每分钟 4 次校验 —— 对方限流 300 次/分钟（单 token），这点开销可以忽略。
 */
export const MBT_CACHE_TTL_HOURS = 0.25

export function cacheMbtToken(token, { owner, ttlHours = MBT_CACHE_TTL_HOURS }, env = process.env) {
  const store = readStore(env)
  const key = hashCode(token)
  const cache = { ...((store.mengbot && store.mengbot.mbtCache) || {}) }
  cache[key] = { owner, at: new Date().toISOString(), expiresAt: new Date(Date.now() + ttlHours * 3600000).toISOString() }
  // 只留最近 200 个
  const entries = Object.entries(cache).slice(-200)
  store.mengbot = { ...(store.mengbot || {}), mbtCache: Object.fromEntries(entries) }
  writeStore(store, env)
  return { ok: true }
}

/**
 * 向 MengBot 校验一个 `mbt_` token。
 *
 * 端点：`GET {base}/api/v1/me`，`Authorization: Bearer mbt_...`
 * 响应：`{ ok, scope, tokenId, rateLimit }`
 *   · 200 → 有效（用 tokenId 或 scope 里的主体做 owner）
 *   · 401 → 无效
 * 限流：300 次/分钟（单 token）—— 所以校验结果缓存 15 分钟，不每请求打。
 */
export async function verifyMbtToken(token, { env = process.env, fetchImpl = fetch } = {}) {
  const raw = String(token || '').trim()
  if (!raw.startsWith('mbt_')) return { ok: false, error: '不是 mbt_ 令牌' }
  const cfg = readMengbotConfig(env)
  const base = String(env.MEMORY_MENGBOT_API_BASE || cfg.baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) return { ok: false, error: '未配置 MEMORY_MENGBOT_API_BASE / mengbot.baseUrl' }
  const url = String(env.MEMORY_MENGBOT_ME_URL || '').trim() || (base + '/api/v1/me')
  try {
    const r = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + raw, Accept: 'application/json' } })
    const d = await r.json().catch(() => ({}))
    if (r.status === 401 || r.status === 403) {
      return { ok: false, invalid: true, error: 'mbt_ 令牌无效或已撤销（MengBot 返回 ' + r.status + '）' }
    }
    if (!r.ok) return { ok: false, error: '校验失败：HTTP ' + r.status }
    // owner 取值优先级：显式 account/email > tokenId（便于定位租户）
    const owner = String(d.account || d.email || d.subject || d.tokenId || '').trim()
    if (!owner) return { ok: false, error: '校验响应里没有可用于分租户的标识（account/email/tokenId）' }
    return { ok: true, owner, scope: d.scope || '', tokenId: d.tokenId || '', rateLimit: d.rateLimit || null }
  } catch (e) {
    return { ok: false, error: '连接 MengBot 失败：' + String((e && e.message) || e) }
  }
}

/** 校验 + 落缓存（云端的业务面在遇到未缓存的 mbt_ 时调它）。 */
export async function verifyAndCacheMbtToken(token, { env = process.env, fetchImpl = fetch } = {}) {
  const v = await verifyMbtToken(token, { env, fetchImpl })
  if (!v.ok) return v
  cacheMbtToken(token, { owner: v.owner }, env)
  return v
}

/**
 * MengBot 云端账号授权 —— **按 mengbot control-plane 的真实机制实现**。
 *
 * mengbot 云（`cloud.mengbot.com.cn`）用的是 better-auth：
 *   ① 发码   POST {base}/api/auth/email-otp/send-verification-otp  {email}        8 位、10 分钟、限流 60s/5
 *   ② 登录   POST {base}/api/auth/sign-in/email-otp                {email, otp}    → 会话（bearer token）
 *   ③ 校验   GET  {base}/v1/me                                     Bearer <token>  → {user:{id,email,...}}
 *
 * 另有**设备凭据**（长期，90 天）：
 *   ④ 创建   POST {base}/v1/installations   Bearer <用户会话>      → {credential:"mb_install_<22>.<43>", ...}
 *   ⑤ 自校验 GET  {base}/v1/installations/self  Bearer mb_install_... → {installation:{id,...}}
 *
 * 所以这里**不再假设 OAuth2 的 code→tokenUrl**（那是错的），改成三种入口：
 *   { token }              → 直接用令牌（用户会话 或 mb_install_* 设备凭据）
 *   { email }              → 代发 OTP，返回 step:'otp-sent'
 *   { email, otp }         → 登录换 token → 校验 → 签发本地令牌
 *
 * 配置（cloud-keys.json 的 mengbot，或环境变量）：
 *   { baseUrl: "https://cloud.mengbot.com.cn", allowList: [], ttlHours: 168 }
 */
export function readMengbotConfig(env = process.env) {
  const store = readStore(env)
  const mb = store.mengbot || {}
  return {
    baseUrl: String(mb.baseUrl || env.MEMORY_MENGBOT_BASE_URL || '').trim().replace(/\/+$/, ''),
    allowList: Array.isArray(mb.allowList) ? mb.allowList.map(String) : [],
    ttlHours: Math.max(1, Math.min(24 * 30, Number(mb.ttlHours) || 24 * 7)),
  }
}


// ---- 跳转授权（redirect + 回跳）-------------------------------------------
//
// 面板里输邮箱 + 验证码是最差的体验（切来切去）。改成：
//   ① 浏览器跳 `GET /cloud/auth/start` → 302 到 MengBot 的登录页（带 redirect_uri + state）
//   ② 用户在 MengBot 页面上完成 OTP 登录
//   ③ MengBot 带 `code`/`token` 回跳 `GET /cloud/auth/callback?code=…&state=…`
//   ④ 服务端校验 state、换令牌、解析租户，最后把本地令牌放 **URL fragment** 回跳客户端
//      （fragment 不会进服务器日志与 Referer）
//
// state 只存内存（5 分钟、一次性），进程重启即失效 —— 比落盘更安全，也不污染台账。

const AUTH_STATE_TTL_MS = 5 * 60 * 1000
/** state → { at, redirectUri } */
const authStates = new Map()

function sweepAuthStates(now = Date.now()) {
  for (const [k, v] of authStates) if (now - v.at > AUTH_STATE_TTL_MS) authStates.delete(k)
}

/** MengBot 登录页地址：优先 MEMORY_MENGBOT_LOGIN_URL 模板，否则 {baseUrl}/login。 */
export function mengbotLoginUrl({ state, redirectUri, callbackUrl }, env = process.env) {
  const cfg = readMengbotConfig(env)
  const tpl = String(env.MEMORY_MENGBOT_LOGIN_URL || '').trim() || (cfg.baseUrl ? cfg.baseUrl + '/login' : '')
  if (!tpl) return { ok: false, error: '未配置 MengBot 登录页（mengbot.baseUrl 或 MEMORY_MENGBOT_LOGIN_URL）' }
  const url = tpl
    .replace('{redirect_uri}', encodeURIComponent(callbackUrl || redirectUri || ''))
    .replace('{state}', encodeURIComponent(state))
    .replace('{client}', encodeURIComponent('memory-eternal-cloud'))
  // 模板里没写占位符时，自动补 query（多数登录页都认这两个参数）
  if (!tpl.includes('{')) {
    const sep = url.includes('?') ? '&' : '?'
    return {
      ok: true,
      url: url + sep + 'redirect_uri=' + encodeURIComponent(callbackUrl || redirectUri || '') + '&state=' + encodeURIComponent(state),
    }
  }
  return { ok: true, url }
}

/** 生成一次授权跳转（state 一次性、5 分钟）。 */
export function startMengbotAuth({ redirectUri = '', callbackUrl = '', env = process.env } = {}) {
  sweepAuthStates()
  const state = crypto.randomBytes(18).toString('base64url')
  authStates.set(state, { at: Date.now(), redirectUri: redirectUri || callbackUrl || '' })
  const built = mengbotLoginUrl({ state, redirectUri, callbackUrl }, env)
  if (!built.ok) return built
  return { ok: true, state, url: built.url, expiresInSeconds: AUTH_STATE_TTL_MS / 1000 }
}

/** 消费 state（一次性）：命中返回上下文并删除。 */
export function consumeAuthState(state) {
  sweepAuthStates()
  const key = String(state || '')
  const hit = authStates.get(key)
  if (!hit) return { ok: false, error: 'state 无效或已过期（请重新发起登录）' }
  authStates.delete(key)
  return { ok: true, redirectUri: hit.redirectUri }
}

/**
 * 回跳处理：拿 MengBot 回来的 `code`（或直接 `token`）换成本地令牌。
 * 支持两种回跳形态（哪边方便用哪边）：
 *   · `code`  —— 走 MEMORY_MENGBOT_EXCHANGE_URL 换 token（标准授权码流程）
 *   · `token` —— MengBot 直接把会话 token 带回来（简化流程）
 */
export async function completeMengbotAuth({ code = '', token = '', state = '', env = process.env, fetchImpl = fetch } = {}) {
  const consumed = consumeAuthState(state)
  if (!consumed.ok) return consumed

  // ① code → token
  let bearer = String(token || '').trim()
  if (!bearer && code) {
    const exchange = String(env.MEMORY_MENGBOT_EXCHANGE_URL || '').trim()
    const cfg = readMengbotConfig(env)
    const url = exchange || (cfg.baseUrl ? cfg.baseUrl + '/api/cloud/desktop/token' : '')
    if (!url) return { ok: false, error: '未配置换取令牌的端点（MEMORY_MENGBOT_EXCHANGE_URL 或 mengbot.baseUrl）' }
    try {
      const r = await fetchImpl(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceCode: code, client: 'memory-eternal-cloud' }),
      })
      const d = await r.json().catch(() => ({}))
      bearer = String(d.token || d.access_token || '').trim()
        || String((r.headers && typeof r.headers.get === 'function' ? r.headers.get('set-auth-token') : '') || '').trim()
      if (!r.ok || !bearer) return { ok: false, error: 'MengBot 换令牌失败：' + (d.error || d.message || ('HTTP ' + r.status)) }
    } catch (e) {
      return { ok: false, error: '连接 MengBot 失败：' + String((e && e.message) || e) }
    }
  }
  if (!bearer) return { ok: false, error: '回跳缺少 code 或 token' }

  // ② 校验身份（复用既有逻辑：/v1/me 或 /v1/installations/self）
  const verified = await verifyMengbotLogin({ token: bearer, env, fetchImpl })
  if (!verified.ok) return verified
  return { ...verified, redirectUri: consumed.redirectUri }
}

export async function verifyMengbotLogin({ token = '', email = '', otp = '', env = process.env, fetchImpl = fetch } = {}) {
  const cfg = readMengbotConfig(env)
  if (!cfg.baseUrl) {
    return { ok: false, error: '未配置 MengBot 云地址（cloud-keys.json 的 mengbot.baseUrl 或 MEMORY_MENGBOT_BASE_URL，例如 https://cloud.mengbot.com.cn）' }
  }

  let bearer = String(token || '').trim()

  // ① 只有邮箱 → 代发 OTP（不落任何状态，等用户把码带回来）
  if (!bearer && email && !otp) {
    try {
      const r = await fetchImpl(cfg.baseUrl + '/api/auth/email-otp/send-verification-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: String(email) }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) return { ok: false, error: 'MengBot 发码失败：' + (d.message || d.error || ('HTTP ' + r.status)) }
      return { ok: true, pending: true, step: 'otp-sent', email: String(email), hint: '验证码已发到邮箱（8 位、10 分钟有效），把它连同 email 一起再提交一次' }
    } catch (e) {
      return { ok: false, error: '连接 MengBot 失败：' + String((e && e.message) || e) }
    }
  }

  // ② email + otp → 登录换 token
  if (!bearer && email && otp) {
    try {
      const r = await fetchImpl(cfg.baseUrl + '/api/auth/sign-in/email-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: String(email), otp: String(otp) }),
      })
      const d = await r.json().catch(() => ({}))
      // better-auth 的 bearer 插件的 token 可能在 body.token，也可能在 set-auth-token 头
      bearer = String(d.token || '').trim() || String((r.headers && typeof r.headers.get === 'function' ? r.headers.get('set-auth-token') : '') || '').trim()
      if (!r.ok || !bearer) {
        return { ok: false, error: 'MengBot 登录失败：' + (d.message || d.error || ('HTTP ' + r.status) || '未返回令牌') }
      }
    } catch (e) {
      return { ok: false, error: '连接 MengBot 失败：' + String((e && e.message) || e) }
    }
  }

  if (!bearer) return { ok: false, error: '缺少 token，或 email + otp' }

  // ③ 校验令牌：设备凭据走 /v1/installations/self，用户会话走 /v1/me
  try {
    const isInstall = bearer.startsWith('mb_install_')
    const path = isInstall ? '/v1/installations/self' : '/v1/me'
    const r = await fetchImpl(cfg.baseUrl + path, { headers: { Authorization: 'Bearer ' + bearer } })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) {
      return { ok: false, error: 'MengBot 令牌无效：' + (d.error || d.message || ('HTTP ' + r.status)) }
    }
    const owner = isInstall
      ? 'mb-inst-' + String((d.installation && d.installation.id) || '').slice(0, 36)
      : String((d.user && (d.user.email || d.user.id)) || '').trim()
    if (!owner || owner === 'mb-inst-') return { ok: false, error: 'MengBot 未返回用户标识' }
    if (cfg.allowList.length && !cfg.allowList.includes(owner)) return { ok: false, error: '该账号不在 allowList 内（' + owner + '）' }

    const local = issueSessionToken({ owner, via: isInstall ? 'mengbot-install' : 'mengbot', ttlHours: cfg.ttlHours, env })
    return {
      ok: true,
      token: local,
      owner,
      via: isInstall ? 'mengbot-install' : 'mengbot',
      vaultRoot: tenantVault(owner, env),
      upstream: { baseUrl: cfg.baseUrl, user: d.user || null, installation: d.installation || null },
      expiresInHours: cfg.ttlHours,
    }
  } catch (e) {
    return { ok: false, error: '连接 MengBot 失败：' + String((e && e.message) || e) }
  }
}

/** 云端配置（脱敏：不返回任何密钥/会话令牌）。 */
export function publicCloudConfig(env = process.env) {
  const store = readStore(env)
  const cfg = readMengbotConfig(env)
  const mb = store.mengbot || {}
  // OIDC 状态：这才是「账号授权」的主路径（邮箱 OTP 直连只是备用）
  const oidcIssuer = String(env.MEMORY_OIDC_ISSUER || '').trim().replace(/\/+$/, '')
  const oidcClientId = String(env.MEMORY_OIDC_CLIENT_ID || 'memory-eternal-cloud').trim()
  const hasClientSecret = !!String(env.MEMORY_OIDC_CLIENT_SECRET || '').trim()
  const oidcRedirect = String(env.MEMORY_OIDC_REDIRECT_URI || '').trim()
  const apiBase = String(env.MEMORY_MENGBOT_API_BASE || '').trim().replace(/\/+$/, '')
  const webhookReady = !!String(env.MEMORY_WEBHOOK_SECRET || '').trim()
  return {
    cloudRoot: cloudRoot(env),
    keys: store.keys.length,
    // 部署自检用：一眼看出「授权/支付/webhook 到底齐了没」
    ready: {
      oidc: !!(oidcIssuer && hasClientSecret && oidcRedirect),
      webhook: webhookReady,
      mengbotApi: !!apiBase,
      license: !!String(env.MEMORY_SERVER_LICENSE || '').trim(),
    },
    oidc: {
      issuer: oidcIssuer,
      clientId: oidcClientId,
      hasClientSecret,
      redirectUri: oidcRedirect,
      // 端点不在这里写死：由 discovery 决定（见 lib/oidc.js）
      discoveryUrl: oidcIssuer ? oidcIssuer + '/.well-known/openid-configuration' : '',
    },
    mengbot: {
      // 与 mengbot control-plane 的真实机制对齐：邮箱 OTP 登录 + bearer 会话 + 设备凭据
      configured: !!(cfg.baseUrl || oidcIssuer),
      baseUrl: cfg.baseUrl || oidcIssuer,
      apiBase,
      loginPath: (cfg.baseUrl || oidcIssuer) ? '/api/auth/sign-in/email-otp' : '',
      sendOtpPath: (cfg.baseUrl || oidcIssuer) ? '/api/auth/email-otp/send-verification-otp' : '',
      allowList: cfg.allowList,
      ttlHours: cfg.ttlHours,
      sessions: (mb.sessions || []).filter((s) => !s.expiresAt || Date.parse(s.expiresAt) > Date.now()).length,
    },
  }
}
