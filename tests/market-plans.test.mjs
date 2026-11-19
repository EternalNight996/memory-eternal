// 套餐价格只有一个来源：MengBot 的 GET /api/pricing（无需鉴权）。
// 契约要点（2026-11-19 对接说明）：
//   · plans[].tier 是权益等级（personal/pro/max），sku 是下单凭据（sub-personal / sub-pro-year）
//   · priceFen 是权威值，price 仅供展示
//   · 半年/年付从 periodPlans 取，不要自己 ×5.5 / ×10
//   · sub-memory-* 已停用，传过去会「未知 SKU」
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchMarketPlans } from '../lib/billing.js'

const env = { MEMORY_MENGBOT_PAY_BASE: 'https://pay.example.test' }

function fakeFetch(payload, { ok = true, throwIt = false, seen = null } = {}) {
  return async (url) => {
    if (seen) seen.url = url
    if (throwIt) throw new Error('network down')
    return { ok, json: async () => payload }
  }
}

const PAYLOAD = {
  merchant: null,
  view: 'personal',
  currency: 'CNY',
  plans: [
    { sku: 'sub-personal', name: '个人版', priceFen: 1800, price: 18, days: 30, tier: 'personal', caps: { cards: 2000, rpm: 150, vaults: 1 }, backup: { days: 7, dr: false } },
    { sku: 'sub-pro', name: '团队版', priceFen: 11800, price: 118, days: 30, tier: 'pro', caps: { cards: 10000, rpm: 300, vaults: 1 }, backup: { days: 14, dr: false } },
    { sku: 'sub-max', name: '旗舰版', priceFen: 39900, price: 399, days: 30, tier: 'max', caps: { cards: 100000, rpm: 1000, vaults: 5 }, backup: { days: 30, dr: true } },
  ],
  periodPlans: {
    half: [{ sku: 'sub-personal-half', name: '个人版（半年）', priceFen: 9900, price: 99, days: 182, tier: 'personal' }],
    year: [{ sku: 'sub-pro-year', name: '团队版（年付）', priceFen: 118000, price: 1180, days: 365, tier: 'pro' }],
  },
}

test('命中 /api/pricing（不是 /api/v1/market/plans）', async () => {
  const seen = {}
  await fetchMarketPlans({ env, fetchImpl: fakeFetch(PAYLOAD, { seen }) })
  assert.equal(seen.url, 'https://pay.example.test/api/pricing')
})

test('解析月付三档：tier 作 plan 键、sku 原样保留、priceFen 权威', async () => {
  const out = await fetchMarketPlans({ env, fetchImpl: fakeFetch(PAYLOAD) })
  assert.equal(out.plans.length, 3)
  const p = out.plans[0]
  assert.equal(p.plan, 'personal')
  assert.equal(p.sku, 'sub-personal', 'sku 必须原样保留（下单要用）')
  assert.equal(p.price, 18)
  assert.equal(p.priceFen, 1800)
  assert.equal(p.cards, 2000)
  assert.equal(p.rpm, 150)
  assert.equal(p.backupDays, 7)
  assert.equal(out.plans[2].backupDr, true)
  assert.equal(out.currency, 'CNY')
})

test('半年 / 年付从 periodPlans 取，不自己算', async () => {
  const out = await fetchMarketPlans({ env, fetchImpl: fakeFetch(PAYLOAD) })
  assert.equal(out.periodPlans.half[0].sku, 'sub-personal-half')
  assert.equal(out.periodPlans.half[0].price, 99)
  assert.equal(out.periodPlans.year[0].sku, 'sub-pro-year')
  assert.equal(out.periodPlans.year[0].price, 1180)
})

test('失败一律返回 null（面板不能因为拿不到价格就崩）', async () => {
  assert.equal(await fetchMarketPlans({ env, fetchImpl: fakeFetch({}, { ok: false }) }), null)
  assert.equal(await fetchMarketPlans({ env, fetchImpl: fakeFetch({}, { throwIt: true }) }), null)
  assert.equal(await fetchMarketPlans({ env, fetchImpl: fakeFetch({ plans: [] }) }), null)
})
