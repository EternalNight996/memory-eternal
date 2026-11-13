// 标准 OIDC 客户端 + `mbt_` token + Webhook：守六件事：
//   ① 授权 URL 是标准 authorization_code + PKCE(S256)；
//   ② code 换 token 用 client_secret_basic；
//   ③ PKCE verifier 一次性、5 分钟过期；
//   ④ `mbt_` token 未校验时 needsVerify，校验后缓存放行；
//   ⑤ webhook 签名（两种形态）+ 篡改/重放拒绝；
//   ⑥ 事件应用幂等 + 取消订阅降级为 free。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildAuthorizeUrl, readOidcConfig, exchangeCode, oidcClientRegistration, rememberPkce, takePkce } from '../lib/oidc.js'
import { signPayload, verifyWebhookSignature, applyWebhookEvent } from '../lib/webhook.js'
import { resolveTenant, cacheMbtToken } from '../lib/cloud-auth.js'
import { readEntitlement } from '../lib/entitlement.js'

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-int-'))
  const env = { ...process.env, DSH_HOME: home }
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  return Promise.resolve(fn(env, home)).finally(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ } })
}

const oidcEnv = {
  MEMORY_OIDC_ISSUER: 'https://cloud.mengbot.example',
  MEMORY_OIDC_CLIENT_SECRET: 'sec',
  MEMORY_OIDC_REDIRECT_URI: 'https://mem.example.com/memory-eternal/api/cloud/auth/callback',
}

test('OIDC 授权 URL：标准参数 + PKCE S256', () => {
  const cfg = readOidcConfig({ ...process.env, ...oidcEnv })
  const r = buildAuthorizeUrl(cfg, { extraState: 'https://app.example/done' })
  assert.equal(r.ok, true)
  const u = new URL(r.url)
  assert.equal(u.origin + u.pathname, 'https://cloud.mengbot.example/oidc/auth')
  assert.equal(u.searchParams.get('response_type'), 'code')
  assert.equal(u.searchParams.get('client_id'), 'memory-eternal-cloud')
  assert.equal(u.searchParams.get('redirect_uri'), oidcEnv.MEMORY_OIDC_REDIRECT_URI)
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('scope'), 'openid profile email offline_access')
  assert.ok(u.searchParams.get('code_challenge'), '要有 PKCE challenge')
  assert.ok(u.searchParams.get('nonce'), '要有 nonce')
  assert.ok(r.codeVerifier && r.codeVerifier.length > 30)
})

test('OIDC 未配置 → 明确报错', () => {
  const cfg = readOidcConfig({ ...process.env, MEMORY_OIDC_ISSUER: '', MEMORY_OIDC_REDIRECT_URI: '' })
  const r = buildAuthorizeUrl(cfg)
  assert.equal(r.ok, false)
  assert.match(r.error, /OIDC 未配置/)
})

test('PKCE verifier 一次性 + 5 分钟过期', () => {
  rememberPkce('st1', 'verifier-1')
  const a = takePkce('st1')
  assert.equal(a.ok, true)
  assert.equal(a.codeVerifier, 'verifier-1')
  const b = takePkce('st1')
  assert.equal(b.ok, false, '二次取用必须失败')

  rememberPkce('st2', 'v2', Date.now() - 6 * 60 * 1000)
  const c = takePkce('st2')
  assert.equal(c.ok, false)
  assert.match(c.error, /过期/)
})

test('code 换 token 用 client_secret_basic', async () => {
  const cfg = readOidcConfig({ ...process.env, ...oidcEnv })
  let seen = null
  const fake = async (url, init) => {
    seen = { url, auth: init.headers.Authorization, body: String(init.body) }
    return { ok: true, status: 200, json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }) }
  }
  const r = await exchangeCode(cfg, { code: 'c1', codeVerifier: 'v1', fetchImpl: fake })
  assert.equal(r.ok, true)
  assert.equal(r.accessToken, 'at')
  assert.equal(seen.url, 'https://cloud.mengbot.example/oidc/token')
  assert.match(seen.auth, /^Basic /)
  assert.match(seen.body, /code=c1/)
  assert.match(seen.body, /code_verifier=v1/)
})

test('client 注册条目：形状符合 node-oidc-provider', () => {
  const c = oidcClientRegistration({ baseUrl: 'https://mem.example.com', clientSecret: 'xxx' })
  assert.equal(c.client_id, 'memory-eternal-cloud')
  assert.deepEqual(c.grant_types, ['authorization_code', 'refresh_token'])
  assert.deepEqual(c.response_types, ['code'])
  assert.equal(c.token_endpoint_auth_method, 'client_secret_basic')
  assert.ok(c.redirect_uris.some((u) => u.endsWith('/memory-eternal/api/cloud/auth/callback')))
})

test('mbt_ token：未校验 needsVerify，缓存后放行', () => withHome((env) => {
  const a = resolveTenant('Bearer mbt_xyz', env)
  assert.equal(a.ok, false)
  assert.equal(a.needsVerify, true)
  cacheMbtToken('mbt_xyz', { owner: 'yg@example.com' }, env)
  const b = resolveTenant('Bearer mbt_xyz', env)
  assert.equal(b.ok, true)
  assert.equal(b.owner, 'yg@example.com')
  assert.equal(b.via, 'mengbot-token')
}))

test('webhook 签名：sha256= 形态 + t=,v1= 形态', () => {
  const secret = 'whsec_x'
  const body = '{"a":1}'
  const sig = signPayload(secret, body)
  assert.equal(verifyWebhookSignature({ secret, rawBody: body, header: sig }).ok, true)
  const ts = Date.now()
  const stripe = 't=' + ts + ',v1=' + signPayload(secret, body, String(ts)).replace('sha256=', '')
  assert.equal(verifyWebhookSignature({ secret, rawBody: body, header: stripe }).ok, true)
  // 篡改
  assert.equal(verifyWebhookSignature({ secret, rawBody: body + ' ', header: sig }).ok, false)
  // 重放（时间戳过旧）
  const old = 't=' + (ts - 10 * 60 * 1000) + ',v1=' + signPayload(secret, body, String(ts - 10 * 60 * 1000)).replace('sha256=', '')
  const r = verifyWebhookSignature({ secret, rawBody: body, header: old })
  assert.equal(r.ok, false)
  assert.match(r.error, /重放|容差/)
})

test('webhook 未配 secret → 明确拒绝', () => {
  const r = verifyWebhookSignature({ secret: '', rawBody: '{}', header: 'sha256=x' })
  assert.equal(r.ok, false)
  assert.match(r.error, /MEMORY_WEBHOOK_SECRET/)
})

test('事件应用：更新 / 取消 / 幂等', () => withHome((env) => {
  const a = applyWebhookEvent({ event: 'entitlement.updated', payload: { plan: 'pro', status: 'active', version: 5, expiresAt: new Date(Date.now() + 86400000).toISOString() }, eventId: 'e1' }, env)
  assert.equal(a.ok, true)
  assert.equal(a.applied, true)
  assert.equal(readEntitlement(env).plan, 'pro')

  const dup = applyWebhookEvent({ event: 'entitlement.updated', payload: {}, eventId: 'e1' }, env)
  assert.equal(dup.applied, false, '重复投递不再应用')
  assert.match(dup.reason, /重复/)

  const cancel = applyWebhookEvent({ event: 'subscription.canceled', payload: {}, eventId: 'e2' }, env)
  assert.equal(cancel.ok, true)
  assert.equal(readEntitlement(env).plan, 'free')
  assert.equal(readEntitlement(env).status, 'inactive')

  const bad = applyWebhookEvent({ event: 'nope', payload: {}, eventId: 'e3' }, env)
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /未知事件/)
}))
