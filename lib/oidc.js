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
    // MengBot 的 provider 挂在 /oidc 下（server.ts 把 /oidc/* 转发给 Koa）
    authorizePath: pick('MEMORY_OIDC_AUTHORIZE_PATH', '/oidc/auth'),
    tokenPath: pick('MEMORY_OIDC_TOKEN_PATH', '/oidc/token'),
    userinfoPath: pick('MEMORY_OIDC_USERINFO_PATH', '/oidc/me'),
  }
}

export function oidcReady(cfg) {
  return !!(cfg && cfg.issuer && cfg.clientId && cfg.redirectUri)
}

/**
 * 拼授权 URL。带 PKCE（S256）—— confidential client 也建议带，防 code 被截获后重放。
 * @returns {{ok:boolean, url?:string, state?:string, nonce?:string, codeVerifier?:string, error?:string}}
 */
export function buildAuthorizeUrl(cfg, { extraState = '' } = {}) {
  if (!oidcReady(cfg)) {
    return { ok: false, error: 'OIDC 未配置（需要 MEMORY_OIDC_ISSUER / MEMORY_OIDC_CLIENT_ID / MEMORY_OIDC_REDIRECT_URI）' }
  }
  const state = b64url(crypto.randomBytes(18)) + (extraState ? '.' + b64url(Buffer.from(extraState)) : '')
  const nonce = b64url(crypto.randomBytes(18))
  const codeVerifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest())
  const u = new URL(cfg.issuer + cfg.authorizePath)
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

/** code → tokens（client_secret_basic + PKCE verifier）。 */
export async function exchangeCode(cfg, { code, codeVerifier, fetchImpl = fetch } = {}) {
  if (!oidcReady(cfg)) return { ok: false, error: 'OIDC 未配置' }
  if (!code) return { ok: false, error: '缺少 code' }
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
    const r = await fetchImpl(cfg.issuer + cfg.tokenPath, { method: 'POST', headers, body: body.toString() })
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

/** access_token → userinfo（拿 sub / email / name）。 */
export async function fetchUserInfo(cfg, accessToken, { fetchImpl = fetch } = {}) {
  if (!oidcReady(cfg)) return { ok: false, error: 'OIDC 未配置' }
  if (!accessToken) return { ok: false, error: '缺少 access_token' }
  try {
    const r = await fetchImpl(cfg.issuer + cfg.userinfoPath, {
      headers: { Authorization: 'Bearer ' + accessToken },
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: '拉取用户信息失败：' + (d.error || ('HTTP ' + r.status)) }
    const owner = String(d.email || d.sub || d.preferred_username || '').trim()
    if (!owner) return { ok: false, error: 'userinfo 里没有 sub/email' }
    return { ok: true, owner, sub: d.sub || '', email: d.email || '', name: d.name || '', raw: d }
  } catch (e) {
    return { ok: false, error: '连接 OIDC 失败：' + String((e && e.message) || e) }
  }
}

/** 一回到底：code → tokens → userinfo。 */
export async function completeOidcLogin(cfg, { code, codeVerifier, fetchImpl = fetch } = {}) {
  const t = await exchangeCode(cfg, { code, codeVerifier, fetchImpl })
  if (!t.ok) return t
  const u = await fetchUserInfo(cfg, t.accessToken, { fetchImpl })
  if (!u.ok) return u
  return { ok: true, owner: u.owner, user: u.raw, tokens: t }
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
