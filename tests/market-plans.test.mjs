// 套餐价格必须**只有一个来源**：MengBot 的 /api/v1/market/plans。
// 面板自己硬编码一份必然开叉（面板 ¥18 / 支付页 ¥39），比不显示更糟。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchMarketPlans } from '../lib/billing.js'

const env = { MEMORY_MENGBOT_API_BASE: 'https://api.example.test' }

function fakeFetch(payload, { ok = true, throwIt = false } = {}) {
  return async () => {
    if (throwIt) throw new Error('network down')
    return { ok, json: async () => payload }
  }
}

test('解析 {plans:[...]}：priceFen → 元、caps 透传', async () => {
  const out = await fetchMarketPlans({
    env,
    fetchImpl: fakeFetch({ plans: [
      { id: 'sub-personal', name: '个人版', priceFen: 1800, caps: { cards: 10000, rpm: 300, vaults: 3 } },
      { plan: 'pro', title: '团队版', price: 118 },
    ] }),
  })
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { plan: 'personal', name: '个人版', price: 18, priceFen: 1800, cards: 10000, rpm: 300, vaults: 3 })
  assert.equal(out[1].plan, 'pro')
  assert.equal(out[1].price, 118)
})

test('也接受裸数组', async () => {
  const out = await fetchMarketPlans({ env, fetchImpl: fakeFetch([{ id: 'max', priceFen: 39900 }]) })
  assert.equal(out[0].plan, 'max')
  assert.equal(out[0].price, 399)
})

test('失败一律返回 null（面板不能因为拿不到价格就崩）', async () => {
  assert.equal(await fetchMarketPlans({ env, fetchImpl: fakeFetch({}, { ok: false }) }), null)
  assert.equal(await fetchMarketPlans({ env, fetchImpl: fakeFetch({}, { throwIt: true }) }), null)
  assert.equal(await fetchMarketPlans({ env, fetchImpl: fakeFetch({ plans: [] }) }), null)
  assert.equal(await fetchMarketPlans({ env: {}, fetchImpl: fakeFetch([]) }), null, '没配 apiBase 时直接 null')
})
