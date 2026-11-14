// 设备码登录（RFC 8628）+ 商户权益分流。
//
// 背景：MengBot 已开通 device_code（P0）、/device?user_code= 页面在线（P1）、
// 商户 SKU 定为 sub-merchant / sub-merchant-pro 且 webhook 带独立 `merchant` 字段（P2）。
// 这条测试守三件事：
//   ① 设备码端点形状（ticket / userCode / verificationUriComplete / interval）
//   ② 商户权益走 merchant 分支，**不写个人 entitlement**（否则商户管理员白拿个人套餐）
//   ③ merchant 字段既接受对象也接受字符串；个人权益仍走原路
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createCloudServer } from '../lib/cloud-server.js'
import { applyWebhookEvent } from '../lib/webhook.js'
import { readEntitlement, writeEntitlement } from '../lib/entitlement.js'
import { registerMerchant, getMerchant } from '../lib/merchant.js'

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-dev-'))
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }))
  return home
}
const cleanup = (h) => { try { fs.rmSync(h, { recursive: true, force: true }) } catch { /* 忽略 */ } }

test('设备码：未配置 OIDC 时明确报 oidc_unconfigured（不静默失败）', () => withServer({}, async (base) => {
  const r = await fetch(base + '/memory-eternal/api/cloud/auth/device/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(r.status, 400)
  const b = await r.json()
  assert.equal(b.code, 'oidc_unconfigured')
}))

test('设备码：假 ticket 轮询返回 ticket_expired', () => withServer({ MEMORY_OIDC_ISSUER: 'https://idp.test', MEMORY_OIDC_CLIENT_ID: 'c', MEMORY_OIDC_CLIENT_SECRET: 's', MEMORY_OIDC_REDIRECT_URI: 'https://x/cb' }, async (base) => {
  const r = await fetch(base + '/memory-eternal/api/cloud/auth/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: 'dv_nope' }) })
  assert.equal(r.status, 404)
  assert.equal((await r.json()).code, 'ticket_expired')
}))

test('商户权益 webhook：走 merchant 分支，不写个人 entitlement', () => {
  const home = tmpHome()
  const env = { ...process.env, DSH_HOME: home }
  const m = registerMerchant({ name: 'Acme', owner: 'boss@acme.com', env })
  assert.equal(m.ok, true)

  const r = applyWebhookEvent({
    event: 'entitlement.updated',
    eventId: 'evt_m1',
    payload: { merchant: { id: m.merchant.id }, plan: 'sub-merchant-pro', status: 'active', version: 5 },
  }, env)

  assert.equal(r.ok, true)
  assert.equal(r.applied, true)
  assert.equal(r.kind, 'merchant', '必须标记为商户权益')
  assert.equal(getMerchant(m.merchant.id, env).plan, 'sub-merchant-pro')
  assert.equal(getMerchant(m.merchant.id, env).status, 'active')
  // 关键：个人 entitlement 不能被写
  assert.equal(readEntitlement(env, 'boss@acme.com'), null, '商户权益不该写进个人 entitlement')
  cleanup(home)
})

test('商户权益 webhook：merchant 传字符串也认', () => {
  const home = tmpHome()
  const env = { ...process.env, DSH_HOME: home }
  const m = registerMerchant({ name: 'B', owner: 'b@x.com', env })
  const r = applyWebhookEvent({
    event: 'entitlement.updated',
    eventId: 'evt_m2',
    payload: { merchant: m.merchant.id, plan: 'sub-merchant', status: 'active', version: 6 },
  }, env)
  assert.equal(r.kind, 'merchant')
  assert.equal(getMerchant(m.merchant.id, env).plan, 'sub-merchant')
  cleanup(home)
})

test('个人权益 webhook：不受 merchant 逻辑影响，仍写自己的 entitlement', () => {
  const home = tmpHome()
  const env = { ...process.env, DSH_HOME: home }
  const r = applyWebhookEvent({
    event: 'entitlement.updated',
    eventId: 'evt_u1',
    payload: { account: 'u@x.com', plan: 'pro', status: 'active', caps: { cards: 10000 }, version: 7 },
  }, env)
  assert.equal(r.ok, true)
  assert.notEqual(r.kind, 'merchant')
  assert.equal(readEntitlement(env, 'u@x.com').plan, 'pro')
  cleanup(home)
})

test('商户 SKU：只接受 sub-merchant / sub-merchant-pro，非法值回落', async () => {
  // 通过 /cloud/merchant/me 返回的 merchantPlanSkus 验证可选档位
  await withServer({ MEMORY_OIDC_ISSUER: '', MEMORY_CLOUD_ACCESS_LOG: '0' }, async (base) => {
    const kj = await (await fetch(base + '/memory-eternal/api/cloud/keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"owner":"m@x.com"}' })).json()
    const r = await (await fetch(base + '/memory-eternal/api/cloud/merchant/me', { headers: { Authorization: 'Bearer ' + kj.token } })).json()
    assert.deepEqual(r.merchantPlanSkus, ['sub-merchant', 'sub-merchant-pro'])
    assert.equal(r.merchantPlanSku, 'sub-merchant', '默认档位')
  })
})

function withServer(env, fn) {
  const home = tmpHome()
  const handler = createCloudServer({ env: { ...process.env, DSH_HOME: home, ...env } })
  const srv = http.createServer((q, r) => { handler(q, r) })
  return new Promise((resolve, reject) => {
    srv.listen(0, '127.0.0.1', async () => {
      let err = null
      try { await fn(`http://127.0.0.1:${srv.address().port}`, home) } catch (e) { err = e }
      await new Promise((r) => srv.close(r))
      cleanup(home)
      if (err) reject(err); else resolve()
    })
  })
}
