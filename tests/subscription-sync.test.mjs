// 套餐主动对账（lib/subscription-sync.js）。
//
// 背景：套餐状态原本 100% 依赖 webhook 推送，而 MengBot 的重试只有 1s/5s/30s 三次（36 秒）。
// 这 36 秒内我们一重启，事件永久丢失 —— 用户状态错到下一次事件（可能是下月续费）。
// 现在用 `mbt_` 打 `GET /api/v1/accounts/{email}/subscription` 兜底。
//
// **最危险的误操作是把付费用户降级**，所以策略刻意保守。守八件事：
//   ① 未配 mbt_ 令牌 → 静默跳过，不报错
//   ② 本地 free + 远端 pro → 升级（安全）
//   ③ 本地付费 + 远端未付费 → **不降级**（宁可不改）
//   ④ 本地够新 → 不打远端（省限流额度）
//   ⑤ force → 按远端覆盖（人工排查用）
//   ⑥ 对账失败 → 不抛错、不改本地
//   ⑦ 防串号：entitlement 属于别人时跳过（多租户共享一份 entitlement 的已知缺陷）
//   ⑧ version 回退仍被底层保护（不会用旧数据盖新数据）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { syncEntitlement, fetchSubscription, syncReady, isFresh, DEFAULT_STALE_MINUTES } from '../lib/subscription-sync.js'
import { writeEntitlement, readEntitlement } from '../lib/entitlement.js'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'me-sync-'))
}
function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
}
function envWith(home, extra = {}) {
  return { ...process.env, DSH_HOME: home, MEMORY_MENGBOT_API_BASE: 'https://api.test', MEMORY_MENGBOT_API_TOKEN: 'mbt_test', ...extra }
}
/** 造一个只回 entitlement 的假 fetch */
function fakeFetch(entitlement, { status = 200, throwErr = null } = {}) {
  return async () => {
    if (throwErr) throw throwErr
    return { ok: status >= 200 && status < 300, status, json: async () => ({ email: 'a@b.c', subscription: null, entitlement }) }
  }
}

test('未配 mbt_ 令牌 → 静默跳过（不报错、不改数据）', async () => {
  const home = tmpHome()
  const env = envWith(home, { MEMORY_MENGBOT_API_TOKEN: '' })
  assert.equal(syncReady(env), false)
  writeEntitlement({ owner: 'a@b.c', plan: 'free', status: 'inactive', version: 1 }, env)
  const r = await syncEntitlement('a@b.c', { env, staleMinutes: 0, fetchImpl: fakeFetch({ plan: 'pro', status: 'active', version: 2 }) })
  assert.equal(r.ok, false)
  assert.equal(r.changed, false)
  assert.match(String(r.reason), /未启用/)
  assert.equal(readEntitlement(env).plan, 'free', '不该改数据')
  cleanup(home)
})

test('本地 free + 远端 pro → 升级', async () => {
  const home = tmpHome()
  const env = envWith(home)
  writeEntitlement({ owner: 'a@b.c', plan: 'free', status: 'inactive', version: 1, fetchedAt: '2020-01-01T00:00:00Z' }, env)
  const r = await syncEntitlement('a@b.c', { env, staleMinutes: 0, fetchImpl: fakeFetch({ plan: 'pro', status: 'active', version: 2, expiresAt: '2027-01-01T00:00:00Z' }) })
  assert.equal(r.changed, true, r.reason)
  const now = readEntitlement(env)
  assert.equal(now.plan, 'pro')
  assert.equal(now.status, 'active')
  assert.equal(now.source, 'mengbot-sync')
  cleanup(home)
})

test('**本地付费 + 远端未付费 → 不降级**（最关键的安全约束）', async () => {
  const home = tmpHome()
  const env = envWith(home)
  writeEntitlement({ owner: 'a@b.c', plan: 'pro', status: 'active', version: 50, expiresAt: '2027-01-01T00:00:00Z' }, env)
  // 远端说 free，且 version 更高（排除 version 回退保护的干扰，确保测的就是"不降级"分支）
  const r = await syncEntitlement('a@b.c', { env, staleMinutes: 0, fetchImpl: fakeFetch({ plan: 'free', status: 'inactive', version: 999 }) })
  assert.equal(r.changed, false)
  assert.match(String(r.reason), /避免误降级/)
  const now = readEntitlement(env)
  assert.equal(now.plan, 'pro', '付费用户不能被误降级')
  assert.equal(now.status, 'active')
  cleanup(home)
})

test('本地够新 → 不打远端（省限流额度）', async () => {
  const home = tmpHome()
  const env = envWith(home)
  writeEntitlement({ owner: 'a@b.c', plan: 'pro', status: 'active', version: 2 }, env)  // fetchedAt = now
  let called = 0
  const fetchImpl = async () => { called++; return { ok: true, status: 200, json: async () => ({ entitlement: { plan: 'max', status: 'active', version: 9 } }) } }
  const r = await syncEntitlement('a@b.c', { env, fetchImpl })
  assert.equal(called, 0, '够新就不该打远端')
  assert.equal(r.changed, false)
  assert.match(String(r.reason), /够新/)
  cleanup(home)
})

test('force → 按远端覆盖（即使本地付费、远端也付费但套餐不同）', async () => {
  const home = tmpHome()
  const env = envWith(home)
  writeEntitlement({ owner: 'a@b.c', plan: 'pro', status: 'active', version: 2 }, env)
  const r = await syncEntitlement('a@b.c', { env, force: true, fetchImpl: fakeFetch({ plan: 'max', status: 'active', version: 3, expiresAt: '2027-06-01T00:00:00Z' }) })
  assert.equal(r.changed, true, r.reason)
  assert.equal(readEntitlement(env).plan, 'max')
  assert.equal(readEntitlement(env).source, 'mengbot-sync-forced')
  cleanup(home)
})

test('对账失败 → 不抛错、不改本地', async () => {
  const home = tmpHome()
  const env = envWith(home)
  writeEntitlement({ owner: 'a@b.c', plan: 'pro', status: 'active', version: 2 }, env)
  const r = await syncEntitlement('a@b.c', { env, staleMinutes: 0, fetchImpl: fakeFetch(null, { status: 500 }) })
  assert.equal(r.ok, false)
  assert.equal(r.changed, false)
  assert.equal(readEntitlement(env).plan, 'pro', '失败不该动数据')
  // 网络异常也一样
  const r2 = await syncEntitlement('a@b.c', { env, staleMinutes: 0, fetchImpl: fakeFetch(null, { throwErr: new Error('ECONNREFUSED') }) })
  assert.equal(r2.ok, false)
  assert.equal(readEntitlement(env).plan, 'pro')
  cleanup(home)
})

test('防串号：entitlement 属于别人 → 跳过（多租户共享一份的已知缺陷）', async () => {
  const home = tmpHome()
  const env = envWith(home)
  writeEntitlement({ owner: 'a@b.c', plan: 'pro', status: 'active', version: 2 }, env)
  const r = await syncEntitlement('other@x.com', { env, force: true, fetchImpl: fakeFetch({ plan: 'max', status: 'active', version: 9 }) })
  assert.equal(r.changed, false)
  assert.match(String(r.reason), /属于 a@b\.c/)
  assert.equal(readEntitlement(env).plan, 'pro', '不该被人家的对账冲掉')
  cleanup(home)
})

test('isFresh：0 或负数表示"永不算新"', () => {
  const ent = { fetchedAt: new Date().toISOString() }
  assert.equal(isFresh(ent, 10), true)
  assert.equal(isFresh(ent, 0), false, '0 必须返回 false（对账测试要用）')
  assert.equal(isFresh(ent, -1), false)
  assert.equal(isFresh(null, 10), false)
  assert.equal(isFresh({}, 10), false)
  assert.equal(isFresh({ fetchedAt: '不是时间' }, 10), false)
})

test('fetchSubscription：令牌与地址缺一不可', async () => {
  const home = tmpHome()
  const noBase = { ...envWith(home), MEMORY_MENGBOT_API_BASE: '' }
  assert.equal(syncReady(noBase), false)
  const r = await fetchSubscription('a@b.c', { env: noBase })
  assert.equal(r.ok, false)
  assert.equal(r.skipped, true)
  const noOwner = await fetchSubscription('', { env: envWith(home) })
  assert.equal(noOwner.ok, false)
  assert.match(String(noOwner.error), /缺少 owner/)
  cleanup(home)
})

test('默认对账周期是 10 分钟', () => {
  assert.equal(DEFAULT_STALE_MINUTES, 10)
})
