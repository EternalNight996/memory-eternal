// 支付闭环 e2e：登录态 → 拿到 subscribe 深链 → webhook 回推 → 套餐生效
//
// 注意链路已经**简化**了（MengBot 第 4 封 Q2）：不再代用户调 checkout 端点，
// 所以这里不需要假 MengBot 的 /checkout，也不需要 access_token。
// 现在只需要验证：
//   ① /cloud/billing/checkout 返回正确的 subscribe 深链（纯本地拼接，零网络）
//   ② webhook 推 entitlement.updated 后 /cloud/billing/plan 立刻变
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createCloudServer } from '../lib/cloud-server.js'

function withHome(env, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-bille2e-'))
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  const handler = createCloudServer({
    env: {
      ...process.env,
      DSH_HOME: home,
      MEMORY_WEBHOOK_SECRET: 'whsec_e2e',
      MEMORY_CLOUD_PUBLIC_URL: 'http://127.0.0.1',
      MEMORY_CLOUD_ACCESS_LOG: '0',
      ...env,
    },
  })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  return new Promise((resolve, reject) => {
    srv.listen(0, '127.0.0.1', async () => {
      let err = null
      try { await fn(`http://127.0.0.1:${srv.address().port}`, home) } catch (e) { err = e }
      await new Promise((r) => srv.close(r))
      try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
      if (err) reject(err); else resolve()
    })
  })
}

const sign = (secret, body) => 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')

test('支付闭环：登录 → 拿 subscribe 深链 → webhook 回推 → 套餐生效', () => withHome({}, async (base) => {
  const API = base + '/memory-eternal/api'
  // ① 签一把租户密钥当"已登录"
  const kj = await (await fetch(API + '/cloud/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"owner":"yg@example.com"}',
  })).json()
  const H = { Authorization: 'Bearer ' + kj.token }

  // ② 下单：应拿到 subscribe 深链，且整个过程零网络
  const co = await (await fetch(API + '/cloud/billing/checkout', {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plan: 'pro', source: 'memory-eternal' }),
  })).json()
  assert.equal(co.ok, true, JSON.stringify(co))
  assert.equal(co.url, 'https://pay.mengbot.com.cn/subscribe?sku=sub-pro&source=memory-eternal')
  assert.equal(co.sku, 'sub-pro')

  // ③ 支付成功 → MengBot 推 webhook
  const payload = JSON.stringify({
    id: 'evt_e2e_1', event: 'entitlement.updated', account: 'yg@example.com',
    plan: 'pro', status: 'active', version: 101,
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    caps: { seats: 10, apps: 5, cards: 10000, rpm: 300, vaults: 1 },
  })
  const wh = await fetch(API + '/cloud/webhook/mengbot', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-MengBot-Signature': sign('whsec_e2e', payload),
      'X-MengBot-Event': 'entitlement.updated',
      'X-MengBot-Event-Id': 'evt_e2e_1',
    },
    body: payload,
  })
  assert.equal(wh.status, 200)
  const wj = await wh.json()
  assert.equal(wj.applied, true, JSON.stringify(wj))

  // ④ 套餐立刻生效，且 caps 用的是**显式字段**（不是 seats 兜底）
  const pv = await (await fetch(API + '/cloud/billing/plan', { headers: H })).json()
  assert.equal(pv.ok, true)
  assert.equal(pv.plan.plan, 'pro')
  assert.equal(pv.plan.status, 'active')
  assert.equal(pv.plan.caps.cards, 10000, '显式 caps.cards 要落库')
  assert.equal(pv.plan.canCheckout, true, '登录后就能下单')
}))
