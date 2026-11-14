// 支付：**直接拼 subscribe 深链**，不代用户调 MengBot 端点。
// （MengBot 第 4 封 Q2 确认：`?sku=` 是深链，`order` 非必需，`source` 会写进订单 note）
//
// 这样做的收益：不需要 omc_ 设备令牌、不需要 OIDC access_token/refresh_token、
// 支付会话不经过第三方服务端。代价是拿不到 priceFen（可读 /api/v1/market/plans 补）。
//
// 守六件事：
//   ① plan 白名单是 personal/pro/max（对方 B2 定稿），废弃的 team/enterprise 要拒；
//   ② 也接受直接传 sku（sub-xxx）；
//   ③ 拼出的 URL 是 https://pay.mengbot.com.cn/subscribe?sku=...&source=...；
//   ④ 没有 owner 就不能下单（必须先登录）；
//   ⑤ 不做任何网络调用（纯字符串拼接，不可能因网络失败）；
//   ⑥ planView 的 canCheckout 不再依赖 access_token。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCheckout, planView, CHECKOUT_PLANS } from '../lib/billing.js'
import { writeEntitlement } from '../lib/entitlement.js'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'me-bill-'))
}
function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
}
const envWith = (home, extra = {}) => ({ ...process.env, DSH_HOME: home, ...extra })

test('plan 白名单是 personal/pro/max（MengBot B2 定稿）', () => {
  assert.deepEqual(CHECKOUT_PLANS, ['personal', 'pro', 'max'])
})

test('废弃的 plan 被拒（team / enterprise 不存在了）', async () => {
  for (const bad of ['team', 'enterprise', 'whatever', '']) {
    const r = await createCheckout({ plan: bad, owner: 'u@x.com', env: {} })
    assert.equal(r.ok, false, bad + ' 应被拒')
    if (bad) assert.match(String(r.error), /不支持的套餐/)
  }
})

test('拼出 subscribe 深链：sku + source', async () => {
  const r = await createCheckout({ plan: 'max', owner: 'u@x.com', source: 'memory-eternal', env: {} })
  assert.equal(r.ok, true)
  assert.equal(r.url, 'https://pay.mengbot.com.cn/subscribe?sku=sub-max&source=memory-eternal')
  assert.equal(r.sku, 'sub-max')
  assert.equal(r.plan, 'max')
  assert.equal(r.via, 'subscribe-deeplink')
})

test('直接传 sku 也认（sub-pro）', async () => {
  const r = await createCheckout({ plan: 'sub-pro', owner: 'u@x.com', env: {} })
  assert.equal(r.ok, true)
  assert.equal(r.sku, 'sub-pro')
  assert.equal(r.plan, 'pro')
})

test('没有 owner 不能下单（必须先登录）', async () => {
  const r = await createCheckout({ plan: 'pro', env: {} })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /必须先登录/)
})

test('可配置支付域（MEMORY_MENGBOT_PAY_BASE）', async () => {
  const r = await createCheckout({ plan: 'pro', owner: 'u@x.com', env: { MEMORY_MENGBOT_PAY_BASE: 'https://pay.test/' } })
  assert.equal(r.ok, true)
  assert.ok(String(r.url).startsWith('https://pay.test/subscribe?'), '去掉尾部斜杠再拼')
})

test('**不做网络调用**：给个会抛错的 fetchImpl 也不该被用上', async () => {
  const r = await createCheckout({
    plan: 'pro', owner: 'u@x.com', env: {},
    fetchImpl: () => { throw new Error('不该被调用') },
  })
  assert.equal(r.ok, true, '纯拼接，不依赖网络')
})

test('planView：读本地 entitlement，canCheckout 只看有没有 owner', () => {
  const home = tmpHome()
  const env = envWith(home)
  writeEntitlement({ owner: 'u@x.com', plan: 'pro', status: 'active', version: 3, expiresAt: '2027-01-01T00:00:00Z' }, env)
  const v = planView('u@x.com', env)
  assert.equal(v.plan, 'pro')
  assert.equal(v.status, 'active')
  assert.equal(v.canCheckout, true, '登录了就能下单（不再依赖 access_token）')
  assert.equal(v.canCheckoutReason, 'subscribe-deeplink')
  assert.deepEqual(v.plans, ['personal', 'pro', 'max'])
  // 未登录
  const anon = planView('', env)
  assert.equal(anon.canCheckout, false)
  assert.equal(anon.canCheckoutReason, 'need-login')
  cleanup(home)
})
