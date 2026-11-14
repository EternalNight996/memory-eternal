// 支付链路：**下单交给 MengBot，结果靠 webhook 回来**。守五件事：
//   ① 套餐白名单（personal/pro/max —— 以 MengBot 第 3 封 B2 定稿为准），别把任意字符串透传过去；
//   ② 代用户调用用 OIDC access_token（缓存失效自动 refresh）；
//   ③ 支付页地址只认契约字段 `url`（对方 B2 答复：checkoutUrl/checkout_url 不是契约字段）；
//   ④ 下单失败给可读原因（不吞 401/402）；
//   ⑤ webhook 收到 entitlement.updated 后本地套餐立刻生效。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCheckout, planView, mengbotApiBase, CHECKOUT_PLANS } from '../lib/billing.js'
import { storeAccessToken, readAccessStore, getValidAccessToken, readOidcConfig, clearDiscoveryCache, discoverOidc } from '../lib/oidc.js'
import { applyWebhookEvent } from '../lib/webhook.js'
import { readEntitlement } from '../lib/entitlement.js'

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-bill-'))
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  const env = {
    ...process.env,
    DSH_HOME: home,
    MEMORY_OIDC_ISSUER: 'https://accounts.mengbot.example',
    MEMORY_OIDC_CLIENT_SECRET: 'sec',
    MEMORY_OIDC_REDIRECT_URI: 'https://mem.mengbot.com.cn/memory-eternal/api/cloud/auth/callback',
    MEMORY_MENGBOT_API_BASE: 'https://accounts.mengbot.example',
  }
  return Promise.resolve(fn(env, home)).finally(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ } })
}

const fakeDiscovery = async (url) => {
  if (String(url).includes('/.well-known/openid-configuration')) {
    return {
      ok: true, status: 200,
      json: async () => ({
        issuer: 'https://accounts.mengbot.example',
        authorization_endpoint: 'https://accounts.mengbot.example/auth',
        token_endpoint: 'https://accounts.mengbot.example/token',
        userinfo_endpoint: 'https://accounts.mengbot.example/me',
      }),
    }
  }
  return { ok: false, status: 404, json: async () => ({}) }
}

test('套餐白名单：未知套餐直接拒，不透传', () => withHome(async (env) => {
  assert.deepEqual(CHECKOUT_PLANS, ['personal', 'pro', 'max'], 'plan 枚举以对方 B2 定稿为准')
  const r = await createCheckout({ plan: 'free-lunch', owner: 'yg@example.com', env, fetchImpl: async () => ({ ok: true, json: async () => ({ url: 'x' }) }) })
  assert.equal(r.ok, false)
  assert.match(r.error, /不支持的套餐/)
}))

test('缺 owner / 缺 API 根 → 明确报错', () => withHome(async (env) => {
  const noOwner = await createCheckout({ plan: 'pro', env, fetchImpl: async () => ({}) })
  assert.equal(noOwner.ok, false)
  assert.match(noOwner.error, /必须先登录/)

  const noBase = await createCheckout({ plan: 'pro', owner: 'a@b.c', env: { ...env, MEMORY_MENGBOT_API_BASE: '', MEMORY_OIDC_ISSUER: '' }, fetchImpl: async () => ({}) })
  assert.equal(noBase.ok, false)
  assert.match(noBase.error, /未配置 MengBot API 根/)
}))

test('有可用 access_token → 正常下单并返回支付页 URL', () => withHome(async (env) => {
  clearDiscoveryCache()
  storeAccessToken('yg@example.com', { accessToken: 'at_live', expiresIn: 3600 }, env)
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body, auth: init.headers.Authorization })
    if (String(url).includes('openid-configuration')) return fakeDiscovery(url)
    if (String(url).endsWith('/api/cloud/desktop/checkout')) {
      return { ok: true, status: 200, json: async () => ({ url: 'https://pay.mengbot.com.cn/c/abc123' }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  const r = await createCheckout({ plan: 'pro', source: 'memory-eternal-cloud', owner: 'yg@example.com', env, fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(r.url, 'https://pay.mengbot.com.cn/c/abc123')
  const co = calls.find((c) => c.url.endsWith('/api/cloud/desktop/checkout'))
  assert.ok(co, '应调 MengBot checkout')
  assert.equal(co.auth, 'Bearer at_live', '应带 access_token')
  assert.deepEqual(JSON.parse(co.body), { plan: 'pro', source: 'memory-eternal-cloud' })
}))

test('access_token 过期 → 自动 refresh 后下单', () => withHome(async (env) => {
  clearDiscoveryCache()
  // 存一个已过期的
  const f = path.join(env.DSH_HOME, 'cloud-oidc-access.json')
  fs.writeFileSync(f, JSON.stringify({ 'yg@example.com': { accessToken: 'at_old', expiresAt: new Date(Date.now() - 1000).toISOString() } }))
  fs.writeFileSync(path.join(env.DSH_HOME, 'cloud-oidc-refresh.json'), JSON.stringify({ 'yg@example.com': { refreshToken: 'rt_1' } }))
  const fetchImpl = async (url, init) => {
    if (String(url).includes('openid-configuration')) return fakeDiscovery(url)
    if (String(url).endsWith('/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'at_new', refresh_token: 'rt_2', expires_in: 3600 }) }
    if (String(url).endsWith('/checkout')) return { ok: true, status: 200, json: async () => ({ url: 'https://pay/c/1' }) }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  const r = await createCheckout({ plan: 'max', owner: 'yg@example.com', env, fetchImpl })
  assert.equal(r.ok, true)
  assert.equal(readAccessStore(env)['yg@example.com'].accessToken, 'at_new', '应用新 token 覆盖缓存')
}))

test('MengBot 下单失败 → 可读原因（不吞 402/401）', () => withHome(async (env) => {
  clearDiscoveryCache()
  storeAccessToken('yg@example.com', { accessToken: 'at', expiresIn: 3600 }, env)
  const fetchImpl = async (url) => {
    if (String(url).includes('openid-configuration')) return fakeDiscovery(url)
    return { ok: false, status: 402, json: async () => ({ error: 'quota_exceeded' }) }
  }
  const r = await createCheckout({ plan: 'pro', owner: 'yg@example.com', env, fetchImpl })
  assert.equal(r.ok, false)
  assert.match(r.error, /下单失败/)
  assert.match(r.error, /quota_exceeded/)
}))

test('支付页地址只认契约字段 url（对方 B2：checkoutUrl/checkout_url 不是契约字段）', () => withHome(async (env) => {
  clearDiscoveryCache()
  // ① url 有 → 成功
  storeAccessToken('a@b.c', { accessToken: 'at', expiresIn: 3600 }, env)
  const ok = await createCheckout({
    plan: 'pro', owner: 'a@b.c', env,
    fetchImpl: async (url) => (String(url).includes('openid-configuration')
      ? fakeDiscovery(url)
      : { ok: true, status: 200, json: async () => ({ url: 'https://pay/x' }) }),
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.url, 'https://pay/x')

  // ② 只有 checkoutUrl / checkout_url → 明确报缺字段，不再"宽容"解析
  for (const bad of [{ checkoutUrl: 'https://pay/y' }, { checkout_url: 'https://pay/z' }]) {
    const r = await createCheckout({
      plan: 'pro', owner: 'a@b.c', env,
      fetchImpl: async (url) => (String(url).includes('openid-configuration')
        ? fakeDiscovery(url)
        : { ok: true, status: 200, json: async () => bad }),
    })
    assert.equal(r.ok, false, '非契约字段不该被当成 url：' + JSON.stringify(bad))
    assert.match(String(r.error), /url/, '错误里要指出缺的是 url')
  }
}))

test('planView：展示本地套餐 + 是否可下单', () => withHome((env) => {
  applyWebhookEvent({ event: 'entitlement.updated', payload: { plan: 'pro', status: 'active', version: 3, expiresAt: new Date(Date.now() + 86400000 * 30).toISOString(), caps: { seats: 5 } }, eventId: 'e1' }, env)
  storeAccessToken('yg@example.com', { accessToken: 'at', expiresIn: 3600 }, env)
  const v = planView('yg@example.com', env)
  assert.equal(v.plan, 'pro')
  assert.equal(v.status, 'active')
  assert.equal(v.caps.seats, 5)
  assert.equal(v.canCheckout, true)
  assert.deepEqual(v.plans, ['personal', 'pro', 'max'])
  // 无 owner 时不可下单
  assert.equal(planView('', env).canCheckout, false)
}))

test('webhook 支付成功 → 本地套餐立刻生效（闭环）', () => withHome((env) => {
  assert.equal(readEntitlement(env), null)
  applyWebhookEvent({
    event: 'entitlement.updated',
    payload: { account: 'yg@example.com', plan: 'pro', status: 'active', version: 9, expiresAt: new Date(Date.now() + 86400000 * 365).toISOString(), caps: { seats: 3 } },
    eventId: 'pay_1',
  }, env)
  const e = readEntitlement(env)
  assert.equal(e.plan, 'pro')
  assert.equal(e.version, 9)
  assert.equal(e.caps.seats, 3)
  assert.equal(readEntitlement(env).source, 'mengbot')
}))
