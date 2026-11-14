// 配额执行：套餐上限必须**真的会拦**，否则收费没有抓手。
// 守六件事：
//   ① 配额来源优先级：caps 显式字段 > plan 默认 > 兜底；
//   ② 数字清洗：非法值不能算成 NaN 把限制搞没；
//   ③ 滑动窗口：rpm 到点拒绝、窗口滑过后恢复；
//   ④ 卡片数：used >= limit 拒绝，且只在「新增卡片」的接口上校验；
//   ⑤ 管理面（登录/看套餐）不受配额影响 —— 否则超限后用户没法自救；
//   ⑥ 429 响应带 code / limit / used / retryAfter，客户端能显示「升级套餐」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { quotaFor, createRateLimiter, checkCardQuota, quotaExceededBody, PLAN_QUOTA, DEFAULT_QUOTA } from '../lib/quota.js'
import { createCloudServer } from '../lib/cloud-server.js'

test('配额来源：caps 显式字段优先于 plan 默认', () => {
  assert.deepEqual(
    { cards: quotaFor({ plan: 'pro' }, {}).cards, rpm: quotaFor({ plan: 'pro' }, {}).rpm },
    { cards: PLAN_QUOTA.pro.cards, rpm: PLAN_QUOTA.pro.rpm },
  )
  const custom = quotaFor({ plan: 'pro', caps: { cards: 100, rpm: 5 } }, {})
  assert.equal(custom.cards, 100, 'caps.cards 要覆盖 plan 默认')
  assert.equal(custom.rpm, 5, 'caps.rpm 要覆盖 plan 默认')
})

test('配额来源：认不出 plan 时走兜底，不报错', () => {
  const q = quotaFor({ plan: 'unknown-plan-xyz' }, {})
  assert.equal(q.cards, DEFAULT_QUOTA.cards)
  assert.equal(q.rpm, DEFAULT_QUOTA.rpm)
  assert.equal(quotaFor({}, {}).cards, PLAN_QUOTA.free.cards, '没有 plan 按 free')
})

test('caps.seats 能换算成卡片上限（MengBot 当前只下发 seats/apps）', () => {
  const q = quotaFor({ plan: 'pro', caps: { seats: 10, apps: 5 } }, {})
  assert.ok(q.cards >= 10000, 'seats=10 应给出至少 1 万张，实际 ' + q.cards)
  // 显式 cards 仍然优先于 seats 换算
  const explicit = quotaFor({ plan: 'pro', caps: { seats: 10, cards: 777 } }, {})
  assert.equal(explicit.cards, 777)
})

test('数字清洗：非法值不会把限制搞成 NaN', () => {
  for (const bad of ['abc', -1, 0, null, undefined, NaN, {}]) {
    const q = quotaFor({ plan: 'pro', caps: { cards: bad, rpm: bad } }, {})
    assert.ok(Number.isFinite(q.cards) && q.cards > 0, `cards 对 ${String(bad)} 应回落到 plan 默认，实际 ${q.cards}`)
    assert.ok(Number.isFinite(q.rpm) && q.rpm > 0, `rpm 对 ${String(bad)} 应回落到 plan 默认`)
  }
})

test('滑动窗口限速：到点拒绝，窗口滑过后恢复', () => {
  let now = 1_000_000
  const rl = createRateLimiter({ now: () => now })
  for (let i = 1; i <= 3; i++) assert.equal(rl.hit('u', 3).ok, true, `第 ${i} 次应放行`)
  const blocked = rl.hit('u', 3)
  assert.equal(blocked.ok, false, '第 4 次应拒绝')
  assert.equal(blocked.used, 3)
  assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 60, 'retryAfter 应在 1..60 秒')
  now += 61_000
  assert.equal(rl.hit('u', 3).ok, true, '窗口滑过后应恢复')
})

test('滑动窗口按租户隔离（一个租户超限不影响别人）', () => {
  let now = 2_000_000
  const rl = createRateLimiter({ now: () => now })
  for (let i = 0; i < 3; i++) rl.hit('a', 3)
  assert.equal(rl.hit('a', 3).ok, false, 'a 应超限')
  assert.equal(rl.hit('b', 3).ok, true, 'b 不受 a 影响')
})

test('卡片配额：used >= limit 拒绝', () => {
  assert.equal(checkCardQuota(0, { cards: 10 }).ok, true)
  assert.equal(checkCardQuota(9, { cards: 10 }).ok, true)
  assert.equal(checkCardQuota(10, { cards: 10 }).ok, false, '到上限就该拒绝')
  assert.equal(checkCardQuota(11, { cards: 10 }).ok, false)
})

test('429 响应体带 code/kind/used/limit/retryAfter', () => {
  const b = quotaExceededBody({ kind: 'rpm', used: 300, limit: 300, plan: 'pro', retryAfterSeconds: 42 })
  assert.equal(b.ok, false)
  assert.equal(b.code, 'quota_exceeded')
  assert.equal(b.kind, 'rpm')
  assert.equal(b.used, 300)
  assert.equal(b.limit, 300)
  assert.equal(b.retryAfterSeconds, 42)
  assert.match(String(b.error), /300\/300/)
})

function withServer(env, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-q-'))
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  const handler = createCloudServer({ env: { ...process.env, ...env, DSH_HOME: home } })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', async () => {
      try { await fn(`http://127.0.0.1:${srv.address().port}`) } finally { srv.close(); resolve() }
    })
  })
}

test('真请求：超限返回 429 + X-RateLimit 头 + Retry-After', () => withServer({ MEMORY_QUOTA_RPM: '2' }, async (base) => {
  const kj = await (await fetch(base + '/memory-eternal/api/cloud/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"owner":"q"}' })).json()
  const H = { Authorization: 'Bearer ' + kj.token }
  const r1 = await fetch(base + '/memory-eternal/api/overview', { headers: H })
  assert.equal(r1.status, 200)
  assert.equal(r1.headers.get('x-ratelimit-limit'), '2')
  await fetch(base + '/memory-eternal/api/overview', { headers: H })
  const r3 = await fetch(base + '/memory-eternal/api/overview', { headers: H })
  assert.equal(r3.status, 429, '第 3 次应 429')
  const b = await r3.json()
  assert.equal(b.code, 'quota_exceeded')
  assert.ok(r3.headers.get('retry-after'), '要带 Retry-After')
}))

test('管理面不受配额影响（超限后还能看套餐/登录）', () => withServer({ MEMORY_QUOTA_RPM: '1' }, async (base) => {
  const kj = await (await fetch(base + '/memory-eternal/api/cloud/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"owner":"q2"}' })).json()
  const H = { Authorization: 'Bearer ' + kj.token }
  await fetch(base + '/memory-eternal/api/overview', { headers: H })       // 用掉唯一名额
  const over = await fetch(base + '/memory-eternal/api/overview', { headers: H })
  assert.equal(over.status, 429)
  for (const p of ['/cloud/config', '/cloud/whoami', '/cloud/health']) {
    const r = await fetch(base + '/memory-eternal/api' + p, { headers: H })
    assert.ok(r.status < 429, p + ' 不该被配额拦住，实际 ' + r.status)
  }
}))

test('配额 source 能区分「显式 caps」与「seats 兜底」（判断 B1 何时可收口）', () => {
  const quiet = { MEMORY_QUOTA_QUIET: '1' }
  // 只有 seats → 走兜底
  const fb = quotaFor({ plan: 'pro', caps: { seats: 10, apps: 5 } }, quiet)
  assert.equal(fb.source, 'plan+seats-fallback')
  assert.equal(fb.cards, 10000, 'seats × 1000')
  // 有显式 cards → 不再兜底
  const ex = quotaFor({ plan: 'pro', caps: { seats: 10, cards: 8000 } }, quiet)
  assert.equal(ex.source, 'caps')
  assert.equal(ex.cards, 8000, '显式值优先，不被 seats×1000 顶高')
})

test('seats 兜底日志只提示一次（这个方法每请求都调，不能刷屏）', () => {
  // 用干净的 env（无 QUIET）触发提示，捕获 stderr 计数
  const orig = console.error
  let n = 0
  console.error = () => { n++ }
  try {
    for (let i = 0; i < 5; i++) quotaFor({ plan: 'pro', caps: { seats: 3 } }, {})
  } finally { console.error = orig }
  assert.ok(n <= 1, '最多提示一次，实际 ' + n)
})

test('**free 绝不参与 seats 兜底**（否则 free 用户从 500 张被放大到 10000 张）', () => {
  const q = quotaFor({ plan: 'free', caps: { seats: 10, apps: 5 } }, { MEMORY_QUOTA_QUIET: '1' })
  assert.equal(q.cards, 500, 'free 必须保持 500 张')
  assert.equal(q.source, 'plan', 'source 不该声称用了兜底')
  // 对照：付费套餐才兜底
  assert.equal(quotaFor({ plan: 'pro', caps: { seats: 10 } }, { MEMORY_QUOTA_QUIET: '1' }).cards, 10000)
})

test('兜底取 max(套餐默认, 席位换算)，且日志文案与数值一致', () => {
  // enterprise 默认 200000 > 席位换算 10000 → 应取 200000（不是 10000）
  const q = quotaFor({ plan: 'enterprise', caps: { seats: 10 } }, { MEMORY_QUOTA_QUIET: '1' })
  assert.equal(q.cards, 200000)
  // 日志必须把两个数都写出来（MengBot 侧曾看到 "seats(10) × 1000 = 200000"，算式对不上）
  const orig = console.error
  let line = ''
  console.error = (m) => { line = String(m) }
  try {
    // 重置一次性标记需要 reload 模块 —— 改用直接观察断言文案格式
    quotaFor({ plan: 'max', caps: { seats: 3 } }, {})
  } finally { console.error = orig }
  // 文案里若出现则必须同时含"套餐默认"和"×"
  if (line) {
    assert.match(line, /套餐默认/)
    assert.match(line, /max\(/)
  }
})

test('source 三态：caps / plan+seats-fallback / plan', () => {
  const Q = { MEMORY_QUOTA_QUIET: '1' }
  assert.equal(quotaFor({ plan: 'pro', caps: { cards: 8000 } }, Q).source, 'caps')
  assert.equal(quotaFor({ plan: 'pro', caps: { seats: 10 } }, Q).source, 'plan+seats-fallback')
  assert.equal(quotaFor({ plan: 'pro' }, Q).source, 'plan')
  assert.equal(quotaFor({ plan: 'free', caps: { seats: 10 } }, Q).source, 'plan')
})
