// OIDC endpoint 一律走 discovery（不硬编码路径）+ mbt_ 15 分钟缓存 + /api/v1/me 校验。
// 守六件事：
//   ① discovery 从 .well-known/openid-configuration 拿 endpoint（含 MengBot 的 /auth 路径）；
//   ② discovery 有缓存、失败不缓存；
//   ③ buildAuthorizeUrl 必须传 endpoints，缺则明确报错；
//   ④ token/userinfo 都用 discovery 给的地址；
//   ⑤ mbt_ 校验打 /api/v1/me，200 有效 / 401 无效，缓存 15 分钟；
//   ⑥ 缓存过期后会重新校验（撤销 15 分钟内生效）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readOidcConfig, discoverOidc, clearDiscoveryCache, buildAuthorizeUrl, exchangeCode, fetchUserInfo,
  oidcClientRegistration, rememberPkce, takePkce, storeRefreshToken, readRefreshStore, refreshAccessToken,
} from '../lib/oidc.js'
import { verifyMbtToken, verifyAndCacheMbtToken, resolveTenant, cacheMbtToken, MBT_CACHE_TTL_HOURS } from '../lib/cloud-auth.js'
import { signPayload, verifyWebhookSignature, applyWebhookEvent } from '../lib/webhook.js'
import { readEntitlement } from '../lib/entitlement.js'

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-int-'))
  const env = { ...process.env, DSH_HOME: home }
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  return Promise.resolve(fn(env, home)).finally(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ } })
}

const ISSUER = 'https://accounts.mengbot.example'
const oidcEnv = {
  MEMORY_OIDC_ISSUER: ISSUER,
  MEMORY_OIDC_CLIENT_SECRET: 'sec',
  MEMORY_OIDC_REDIRECT_URI: 'https://mem.mengbot.com.cn/memory-eternal/api/cloud/auth/callback',
}

/** 假 discovery：**模拟 MengBot 真实布局**（authorize 在 /auth，不在 /oidc/auth） */
const fakeDiscovery = (calls) => async (url) => {
  calls.push(url)
  if (url === ISSUER + '/.well-known/openid-configuration') {
    return {
      ok: true, status: 200,
      json: async () => ({
        issuer: ISSUER,
        authorization_endpoint: ISSUER + '/auth',
        token_endpoint: ISSUER + '/token',
        userinfo_endpoint: ISSUER + '/me',
        jwks_uri: ISSUER + '/jwks',
        scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
        code_challenge_methods_supported: ['S256'],
      }),
    }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}

test('discovery 拿 endpoint（MengBot 的 authorize 在 /auth，不是 /oidc/auth）', async () => {
  clearDiscoveryCache()
  const cfg = readOidcConfig({ ...process.env, ...oidcEnv })
  const calls = []
  const d = await discoverOidc(cfg, { fetchImpl: fakeDiscovery(calls) })
  assert.equal(d.ok, true)
  assert.equal(d.endpoints.authorizationEndpoint, ISSUER + '/auth')
  assert.equal(d.endpoints.tokenEndpoint, ISSUER + '/token')
  assert.equal(d.endpoints.userinfoEndpoint, ISSUER + '/me')
  assert.deepEqual(calls, [ISSUER + '/.well-known/openid-configuration'])
})

test('discovery 有缓存（第二次不再请求）', async () => {
  clearDiscoveryCache()
  const cfg = readOidcConfig({ ...process.env, ...oidcEnv })
  const calls = []
  const f = fakeDiscovery(calls)
  await discoverOidc(cfg, { fetchImpl: f })
  const d2 = await discoverOidc(cfg, { fetchImpl: f })
  assert.equal(d2.cached, true)
  assert.equal(calls.length, 1, '第二次应命中缓存')
})

test('buildAuthorizeUrl 必须传 endpoints，URL 用 discovery 的 authorization_endpoint', async () => {
  clearDiscoveryCache()
  const cfg = readOidcConfig({ ...process.env, ...oidcEnv })
  const noEp = buildAuthorizeUrl(cfg, null)
  assert.equal(noEp.ok, false)
  assert.match(noEp.error, /authorization_endpoint/)

  const d = await discoverOidc(cfg, { fetchImpl: fakeDiscovery([]) })
  const r = buildAuthorizeUrl(cfg, d.endpoints, { extraState: 'https://app.example/done' })
  assert.equal(r.ok, true)
  const u = new URL(r.url)
  assert.equal(u.origin + u.pathname, ISSUER + '/auth')
  assert.equal(u.searchParams.get('response_type'), 'code')
  assert.equal(u.searchParams.get('client_id'), 'memory-eternal-cloud')
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('scope'), 'openid profile email offline_access')
})

test('token / userinfo 都用 discovery 给的地址', async () => {
  clearDiscoveryCache()
  const cfg = readOidcConfig({ ...process.env, ...oidcEnv })
  const d = await discoverOidc(cfg, { fetchImpl: fakeDiscovery([]) })
  const seen = []
  const fake = async (url, init) => {
    seen.push({ url, auth: init && init.headers && init.headers.Authorization, body: String((init && init.body) || '') })
    if (url.endsWith('/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }) }
    if (url.endsWith('/me')) return { ok: true, status: 200, json: async () => ({ email: 'yg@example.com', sub: 'u1' }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  const t = await exchangeCode(cfg, d.endpoints, { code: 'c1', codeVerifier: 'v1', fetchImpl: fake })
  assert.equal(t.ok, true)
  assert.equal(seen[0].url, ISSUER + '/token')
  assert.match(seen[0].auth, /^Basic /)

  const u = await fetchUserInfo(cfg, d.endpoints, t.accessToken, { fetchImpl: fake })
  assert.equal(u.ok, true)
  assert.equal(u.owner, 'yg@example.com')
  assert.equal(seen[1].url, ISSUER + '/me')
})

test('PKCE verifier 一次性 + 5 分钟过期', () => {
  rememberPkce('st1', 'verifier-1')
  assert.equal(takePkce('st1').codeVerifier, 'verifier-1')
  assert.equal(takePkce('st1').ok, false, '二次取用必须失败')
  rememberPkce('st2', 'v2', Date.now() - 6 * 60 * 1000)
  const c = takePkce('st2')
  assert.equal(c.ok, false)
  assert.match(c.error, /过期/)
})

test('client 注册条目形状符合 node-oidc-provider', () => {
  const c = oidcClientRegistration({ baseUrl: 'https://mem.mengbot.com.cn', clientSecret: 'xxx' })
  assert.equal(c.client_id, 'memory-eternal-cloud')
  assert.deepEqual(c.grant_types, ['authorization_code', 'refresh_token'])
  assert.deepEqual(c.response_types, ['code'])
  assert.equal(c.token_endpoint_auth_method, 'client_secret_basic')
  assert.ok(c.redirect_uris.some((u) => u.endsWith('/memory-eternal/api/cloud/auth/callback')))
})

test('mbt_ 校验：打 /api/v1/me，200 有效 / 401 无效', () => withHome(async (env) => {
  const e = { ...env, MEMORY_MENGBOT_API_BASE: 'https://accounts.mengbot.example' }
  const okFetch = async (url, init) => {
    assert.equal(url, 'https://accounts.mengbot.example/api/v1/me')
    assert.equal(init.headers.Authorization, 'Bearer mbt_ok')
    return { ok: true, status: 200, json: async () => ({ ok: true, scope: 'memory', tokenId: 'tok_1', rateLimit: { limit: 300, window: 60 } }) }
  }
  const good = await verifyMbtToken('mbt_ok', { env: e, fetchImpl: okFetch })
  assert.equal(good.ok, true)
  assert.equal(good.owner, 'tok_1', '没有 account/email 时用 tokenId 做租户标识')
  assert.equal(good.rateLimit.limit, 300)

  const bad = await verifyMbtToken('mbt_revoked', { env: e, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false }) }) })
  assert.equal(bad.ok, false)
  assert.equal(bad.invalid, true)
  assert.match(bad.error, /无效或已撤销/)
}))

test('mbt_ 缓存 15 分钟（不是 24h）', () => withHome(async (env) => {
  assert.equal(MBT_CACHE_TTL_HOURS, 0.25, 'TTL 应为 15 分钟')
  const e = { ...env, MEMORY_MENGBOT_API_BASE: 'https://accounts.mengbot.example' }
  const v = await verifyAndCacheMbtToken('mbt_x', {
    env: e, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, tokenId: 'tok_x' }) }),
  })
  assert.equal(v.ok, true)
  const t = resolveTenant('Bearer mbt_x', e)
  assert.equal(t.ok, true)
  assert.equal(t.via, 'mengbot-token')
  // 缓存里应该只有 15 分钟
  const store = JSON.parse(fs.readFileSync(path.join(env.DSH_HOME, 'cloud-keys.json'), 'utf8'))
  const rec = Object.values(store.mengbot.mbtCache)[0]
  const ttlMin = (Date.parse(rec.expiresAt) - Date.now()) / 60000
  assert.ok(ttlMin > 13 && ttlMin <= 15.1, '缓存有效期应约 15 分钟，实际 ' + ttlMin.toFixed(1))
}))

test('webhook 签名两种形态 + 篡改/重放拒绝', () => {
  const secret = 'whsec_x'
  const body = '{"a":1}'
  const sig = signPayload(secret, body)
  assert.equal(verifyWebhookSignature({ secret, rawBody: body, header: sig }).ok, true)
  const ts = Date.now()
  const stripe = 't=' + ts + ',v1=' + signPayload(secret, body, String(ts)).replace('sha256=', '')
  assert.equal(verifyWebhookSignature({ secret, rawBody: body, header: stripe }).ok, true)
  assert.equal(verifyWebhookSignature({ secret, rawBody: body + ' ', header: sig }).ok, false)
  const old = 't=' + (ts - 10 * 60 * 1000) + ',v1=' + signPayload(secret, body, String(ts - 10 * 60 * 1000)).replace('sha256=', '')
  const r = verifyWebhookSignature({ secret, rawBody: body, header: old })
  assert.equal(r.ok, false)
  assert.match(r.error, /重放|容差/)
})

test('事件应用：更新 / 取消 / 幂等', () => withHome((env) => {
  const a = applyWebhookEvent({ event: 'entitlement.updated', payload: { plan: 'pro', status: 'active', version: 5, expiresAt: new Date(Date.now() + 86400000).toISOString() }, eventId: 'e1' }, env)
  assert.equal(a.applied, true)
  assert.equal(readEntitlement(env).plan, 'pro')
  const dup = applyWebhookEvent({ event: 'entitlement.updated', payload: {}, eventId: 'e1' }, env)
  assert.equal(dup.applied, false)
  const cancel = applyWebhookEvent({ event: 'subscription.canceled', payload: {}, eventId: 'e2' }, env)
  assert.equal(cancel.ok, true)
  assert.equal(readEntitlement(env).plan, 'free')
}))

test('refresh_token 存储 / 轮换 / 失败清除', () => withHome(async (env) => {
  clearDiscoveryCache()
  const cfg = readOidcConfig({ ...process.env, ...oidcEnv })
  const d = await discoverOidc(cfg, { fetchImpl: fakeDiscovery([]) })
  storeRefreshToken('yg@example.com', 'rt_1', env)
  const ok = await refreshAccessToken(cfg, d.endpoints, 'yg@example.com', {
    env, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'at2', refresh_token: 'rt_2' }) }),
  })
  assert.equal(ok.ok, true)
  assert.equal(readRefreshStore(env)['yg@example.com'].refreshToken, 'rt_2')
  const bad = await refreshAccessToken(cfg, d.endpoints, 'yg@example.com', {
    env, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }),
  })
  assert.equal(bad.ok, false)
  assert.equal(readRefreshStore(env)['yg@example.com'], undefined)
}))

// C1：MengBot 的 refresh_token 是一次性轮换的（对方答复原文："每次刷新签发新 token，
// 旧 token 立即失效"）。两个请求并发读到同一个旧 token 时，第二个会失败，
// 旧实现还会 forgetRefreshToken 把**第一个刚拿到的新 token** 清掉 → 登录态彻底丢失。
test('refreshAccessToken 单飞：并发只打一次，令牌不被误清', async () => {
  const { refreshAccessToken, storeRefreshToken, readRefreshStore } = await import('../lib/oidc.js')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-refresh-'))
  const env = { ...process.env, DSH_HOME: home }
  const cfg = { clientId: 'cid', clientSecret: 'csec', scope: 'openid offline_access', issuer: 'https://idp.test', redirectUri: 'https://x/cb' }
  const endpoints = { tokenEndpoint: 'https://idp.test/token' }
  storeRefreshToken('u1', 'RT_OLD', env)

  let calls = 0
  const fetchImpl = async () => {
    calls++
    return { ok: true, status: 200, json: async () => ({ access_token: 'AT_NEW', refresh_token: 'RT_NEW', expires_in: 3600 }) }
  }
  const results = await Promise.all(
    Array.from({ length: 5 }, () => refreshAccessToken(cfg, endpoints, 'u1', { fetchImpl, env })),
  )
  assert.equal(calls, 1, '并发 5 次只该打 1 次 token 端点，实际 ' + calls)
  assert.equal(results.filter((r) => r.ok).length, 5, '5 个调用都应拿到结果')
  assert.equal(readRefreshStore(env).u1.refreshToken, 'RT_NEW', '新令牌要存下来')
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})

test('refresh 失败但令牌已被别的请求轮换 → 不清令牌', async () => {
  const { refreshAccessToken, storeRefreshToken, readRefreshStore } = await import('../lib/oidc.js')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-refresh2-'))
  const env = { ...process.env, DSH_HOME: home }
  const cfg = { clientId: 'cid', clientSecret: 'csec', scope: 'openid offline_access', issuer: 'https://idp.test', redirectUri: 'https://x/cb' }
  const endpoints = { tokenEndpoint: 'https://idp.test/token' }
  storeRefreshToken('u2', 'RT_STALE', env)
  const fetchImpl = async () => {
    storeRefreshToken('u2', 'RT_BY_OTHER', env) // 模拟另一个请求已轮换成功
    return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }
  }
  const r = await refreshAccessToken(cfg, endpoints, 'u2', { fetchImpl, env })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /并发刷新/, '要识别出并发场景')
  assert.equal(readRefreshStore(env).u2.refreshToken, 'RT_BY_OTHER', '别人的新令牌不能被清')
  try { fs.rmSync(home, { recursive: true, force: true }) } catch {}
})
