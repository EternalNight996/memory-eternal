// 套餐到期判定：MengBot 下发的是 **epoch 毫秒数字**，旧实现 `Date.parse(数字)` 恒为 NaN
// → 付费租户被当成"已过期" → 掉到 license 兜底 → 套餐 caps（如 pro 的 10,000 张）不生效。
// 线上实测（0.48.4 部署后）日志出现「配额兜底：enterprise 未下发 caps.cards … 200000 张」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resolveAccess, readEntitlement } from '../lib/entitlement.js'

const homes = []
function homeWithEntitlement(ent) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'me-ent-'))
  homes.push(home)
  // ownerSlug = encodeURIComponent(owner)
  const slug = encodeURIComponent(ent.owner)
  writeFileSync(path.join(home, `cloud-entitlement-${slug}.json`), JSON.stringify(ent), { mode: 0o600 })
  return { DSH_HOME: home }
}

test.after(() => { for (const h of homes) { try { rmSync(h, { recursive: true, force: true }) } catch { /* 忽略 */ } } })

const NOW = Date.parse('2026-11-16T00:00:00Z')
const futureMs = NOW + 30 * 86400000
const pastMs = NOW - 1 * 86400000

test('epoch 毫秒数字：未到期 → 认 per-owner 套餐与 caps', () => {
  const env = homeWithEntitlement({ owner: 'a@b.com', plan: 'pro', status: 'active', expiresAt: futureMs, caps: { cards: 10000, rpm: 300 }, source: 'mengbot' })
  const acc = resolveAccess(env, { now: NOW, owner: 'a@b.com' })
  assert.equal(acc.source, 'mengbot', '数字 expiresAt 未过期时应走 per-owner entitlement')
  assert.equal(acc.plan, 'pro')
  assert.equal(acc.caps.cards, 10000, 'pro 的 10,000 张上限必须生效')
  assert.ok(acc.daysLeft >= 29 && acc.daysLeft <= 31, 'daysLeft 应按毫秒数算出来：' + acc.daysLeft)
})

test('epoch 毫秒数字：已过期 → 不再认 per-owner（回落 license/降级）', () => {
  const env = homeWithEntitlement({ owner: 'e@b.com', plan: 'pro', status: 'active', expiresAt: pastMs, caps: { cards: 10000 } })
  const acc = resolveAccess(env, { now: NOW, owner: 'e@b.com' })
  assert.notEqual(acc.source, 'mengbot')
})

test('epoch 秒（10 位）也认', () => {
  const env = homeWithEntitlement({ owner: 's@b.com', plan: 'pro', status: 'active', expiresAt: Math.floor(futureMs / 1000) })
  assert.equal(resolveAccess(env, { now: NOW, owner: 's@b.com' }).source, 'mengbot')
})

test('ISO 字符串照旧可用', () => {
  const env = homeWithEntitlement({ owner: 'i@b.com', plan: 'pro', status: 'active', expiresAt: new Date(futureMs).toISOString() })
  assert.equal(resolveAccess(env, { now: NOW, owner: 'i@b.com' }).source, 'mengbot')
})

test('没有 expiresAt 视为不过期；坏字符串按不过期处理（宁放行不误拒）', () => {
  const a = homeWithEntitlement({ owner: 'n@b.com', plan: 'pro', status: 'active' })
  assert.equal(resolveAccess(a, { now: NOW, owner: 'n@b.com' }).source, 'mengbot')
  const b = homeWithEntitlement({ owner: 'x@b.com', plan: 'pro', status: 'active', expiresAt: 'not-a-date' })
  assert.equal(resolveAccess(b, { now: NOW, owner: 'x@b.com' }).source, 'mengbot')
})

test('readEntitlement 能按 owner 读到 percent-encoded 文件名', () => {
  const env = homeWithEntitlement({ owner: '13048770337@163.com', plan: 'pro', status: 'active', expiresAt: futureMs })
  const ent = readEntitlement(env, '13048770337@163.com')
  assert.equal(ent.plan, 'pro')
})
