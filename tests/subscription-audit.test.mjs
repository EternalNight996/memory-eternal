// 订阅全量核对（lib/subscription-audit.js）。
//
// 为什么要有它：webhook 是推送（对方重试只有 1s/5s/30s 共 36 秒），我们一重启就永久丢；
// 按需对账只在**有人访问**时才发生 —— 一个付费用户一个月不登录，状态就错一个月。
//
// **最关键的设计约束：只记差异，绝不自动改。**
// 批量 force 对账一旦 owner 映射出错（tenantVault 有损转义会碰撞），
// 会一次性把一批付费用户降级 —— 那是灾难性的。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runAudit, readAudit, listKnownOwners, auditDue, AUDIT_DEFAULTS } from '../lib/subscription-audit.js'
import { writeEntitlement, readEntitlement } from '../lib/entitlement.js'

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-audit-'))
  const env = { ...process.env, DSH_HOME: home, MEMORY_MENGBOT_API_BASE: 'https://api.test', MEMORY_MENGBOT_API_TOKEN: 'mbt_x' }
  fs.mkdirSync(path.join(home, 'cloud-vaults'), { recursive: true })
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({
    version: 1,
    keys: [{ owner: 'paid@x.com', revoked: false }, { owner: 'free@x.com', revoked: false }],
    mengbot: { sessions: [{ owner: 'expired@x.com' }] },
  }))
  return { home, env }
}
const cleanup = (home) => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ } }
const mkFetch = (map) => async (url) => {
  const m = /accounts\/([^/]+)\/subscription/.exec(String(url))
  const email = m ? decodeURIComponent(m[1]) : ''
  return { ok: true, status: 200, json: async () => ({ email, entitlement: map[email] || { plan: 'free', status: 'inactive', version: 1 } }) }
}

test('枚举已知租户：密钥 + 会话 + entitlement 文件名，三处合并', () => {
  const { home, env } = setup()
  writeEntitlement({ owner: 'from-file@x.com', plan: 'pro', status: 'active', version: 1 }, env)
  const owners = listKnownOwners(env)
  for (const o of ['paid@x.com', 'free@x.com', 'expired@x.com', 'from-file@x.com']) {
    assert.ok(owners.includes(o), '应包含 ' + o + '，实际 ' + owners.join(','))
  }
  // 撤销的密钥不算
  cleanup(home)
})

test('核对能发现「漏推送」与「退款未收到」两类差异', async () => {
  const { home, env } = setup()
  writeEntitlement({ owner: 'paid@x.com', plan: 'free', status: 'inactive', version: 1 }, env)
  writeEntitlement({ owner: 'expired@x.com', plan: 'pro', status: 'active', version: 2, expiresAt: '2027-01-01T00:00:00Z' }, env)
  const map = {
    'paid@x.com': { plan: 'pro', status: 'active', version: 9, expiresAt: '2027-01-01T00:00:00Z', caps: { cards: 10000 } },
    'expired@x.com': { plan: 'free', status: 'inactive', version: 10 },
    'free@x.com': { plan: 'free', status: 'inactive', version: 1 },
  }
  const r = await runAudit({ env, fetchImpl: mkFetch(map), ratePerSec: 1000 })
  assert.equal(r.ok, true)
  const byOwner = Object.fromEntries(r.diffs.map((d) => [d.owner, d.type]))
  assert.equal(byOwner['paid@x.com'], 'missing_local', '远端付费本地 free = 漏推送')
  assert.equal(byOwner['expired@x.com'], 'missing_remote', '本地付费远端 free = 退款未收到')
  assert.equal(byOwner['free@x.com'], undefined, '两边都 free 不算差异')
  cleanup(home)
})

test('**核对不改任何数据**（这是最重要的约束）', async () => {
  const { home, env } = setup()
  writeEntitlement({ owner: 'paid@x.com', plan: 'free', status: 'inactive', version: 1 }, env)
  writeEntitlement({ owner: 'expired@x.com', plan: 'pro', status: 'active', version: 2, expiresAt: '2027-01-01T00:00:00Z' }, env)
  const before = {
    paid: JSON.stringify(readEntitlement(env, 'paid@x.com')),
    expired: JSON.stringify(readEntitlement(env, 'expired@x.com')),
  }
  await runAudit({
    env, ratePerSec: 1000,
    fetchImpl: mkFetch({
      'paid@x.com': { plan: 'max', status: 'active', version: 99, caps: { cards: 999999 } },
      'expired@x.com': { plan: 'free', status: 'inactive', version: 99 },
    }),
  })
  assert.equal(JSON.stringify(readEntitlement(env, 'paid@x.com')), before.paid, 'paid 的 entitlement 不能被核对改掉')
  assert.equal(JSON.stringify(readEntitlement(env, 'expired@x.com')), before.expired, 'expired 的也不能被改掉')
  cleanup(home)
})

test('caps 漂移与 plan 漂移', async () => {
  const { home, env } = setup()
  writeEntitlement({ owner: 'paid@x.com', plan: 'pro', status: 'active', version: 2, expiresAt: '2027-01-01T00:00:00Z', caps: { cards: 5000, rpm: 300 } }, env)
  const r = await runAudit({
    env, ratePerSec: 1000,
    fetchImpl: mkFetch({
      'paid@x.com': { plan: 'pro', status: 'active', version: 3, expiresAt: '2027-01-01T00:00:00Z', caps: { cards: 10000, rpm: 300 } },
      'free@x.com': { plan: 'free', status: 'inactive', version: 1 },
    }),
  })
  const d = r.diffs.find((x) => x.owner === 'paid@x.com')
  assert.ok(d, '应有差异：' + JSON.stringify(r.diffs))
  assert.equal(d.type, 'caps_drift')
  assert.match(d.detail, /cards/)
  cleanup(home)
})

test('未配 mbt_ 令牌 → 不跑，明确报未启用', async () => {
  const { home, env } = setup()
  const noTok = { ...env, MEMORY_MENGBOT_API_TOKEN: '' }
  const r = await runAudit({ env: noTok, ratePerSec: 1000 })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /未启用/)
  cleanup(home)
})

test('结果落盘 + auditDue 在跑完后变 false', async () => {
  const { home, env } = setup()
  assert.equal(auditDue(env), true, '没跑过时应 due')
  await runAudit({ env, ratePerSec: 1000, fetchImpl: mkFetch({}) })
  assert.ok(readAudit(env), '应落盘')
  assert.equal(auditDue(env), false, '刚跑完不该 due')
  cleanup(home)
})

test('maxTenants 限流上限与默认限速', async () => {
  const { home, env } = setup()
  const r = await runAudit({ env, ratePerSec: 1000, maxTenants: 2, fetchImpl: mkFetch({}) })
  assert.equal(r.checked + r.unreachable, 2, '最多核 2 个')
  assert.ok(r.skipped >= 1, '剩余的记入 skipped')
  assert.equal(AUDIT_DEFAULTS.ratePerSec, 5, '默认 5/s（mbt_ 额度 300/min 的一半，留裕度）')
  cleanup(home)
})
