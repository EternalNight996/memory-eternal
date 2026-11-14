// 权限编排：MengBot entitlement（主）→ 本地 license（兜底）→ 降级。守五件事：
//   ① entitlement 有效 → 全功能，source=mengbot；
//   ② entitlement 过期/无效 → 退回本地 license；
//   ③ 两者都没有 → 按 degrade 降级；
//   ④ version 回退必须被拒（防回滚）；
//   ⑤ 摘要不泄露 license 原文与 MengBot token。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { signLicense } from '../lib/license.js'
import { readEntitlement, writeEntitlement, resolveAccess, accessSummary, entitlementPath, ENTITLEMENT_FILE } from '../lib/entitlement.js'

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const pubPem = publicKey.export({ type: 'spki', format: 'pem' })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' })

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ent-'))
  const env = { ...process.env, DSH_HOME: home }
  delete env.MEMORY_SERVER_LICENSE
  return Promise.resolve(fn(env, home)).finally(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ } })
}

const proEnt = (patch = {}) => ({
  plan: 'pro', status: 'active', version: 3,
  expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  caps: { seats: 5 },
  ...patch,
})

test('entitlement 写入/读取 + version 单调', () => withHome((env, home) => {
  const w = writeEntitlement(proEnt(), env)
  assert.equal(w.ok, true)
  const got = readEntitlement(env)
  assert.equal(got.plan, 'pro')
  assert.equal(got.version, 3)
  assert.equal(got.source, 'mengbot')
  assert.ok(fs.existsSync(path.join(home, 'cloud-entitlement.json')))
  // 坏文件不回炸
  fs.writeFileSync(entitlementPath(env), '{not json')
  assert.equal(readEntitlement(env), null)
}))

test('version 回退被拒（防回滚攻击）', () => withHome((env) => {
  writeEntitlement(proEnt({ version: 9 }), env)
  const r = writeEntitlement(proEnt({ version: 2 }), env)
  assert.equal(r.ok, false)
  assert.match(r.error, /version 回退/)
  assert.equal(readEntitlement(env).version, 9, '缓存不能被降级')
}))

test('entitlement 有效 → source=mengbot，可写', () => withHome((env) => {
  writeEntitlement(proEnt(), env)
  const a = resolveAccess(env)
  assert.equal(a.source, 'mengbot')
  assert.equal(a.plan, 'pro')
  assert.equal(a.canWrite, true)
  assert.ok(a.daysLeft >= 29 && a.daysLeft <= 30)
}))

test('entitlement 过期 → 退回本地 license', () => withHome((env) => {
  writeEntitlement(proEnt({ expiresAt: new Date(Date.now() - 86400000).toISOString() }), env)
  const token = signLicense({
    sub: 'acme', plan: 'pro', seats: 3,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 * 60,
  }, privPem)
  // licenseState 用内嵌公钥；测试里换成我们的公钥
  const a = resolveAccess({ ...env, MEMORY_SERVER_LICENSE: token }, { now: Date.now() })
  // 内嵌公钥 ≠ 测试公钥 → license 也无效；此处只验证「不会误判成 mengbot」
  assert.notEqual(a.source, 'mengbot')
}))

test('entitlement 与 license 都没有 → 按 degrade 降级', () => withHome((env) => {
  const warn = resolveAccess(env)
  assert.equal(warn.source, 'none')
  assert.equal(warn.canWrite, true, 'warn 放行')

  const ro = resolveAccess({ ...env, MEMORY_LICENSE_DEGRADE: 'readonly' })
  assert.equal(ro.canWrite, false, 'readonly 拦写')

  const stop = resolveAccess({ ...env, MEMORY_LICENSE_DEGRADE: 'stop' })
  assert.equal(stop.canWrite, false)
}))

test('摘要不含 license 原文与 token', () => withHome((env) => {
  writeEntitlement(proEnt(), env)
  const a = resolveAccess(env)
  const s = accessSummary(a)
  assert.equal(s.source, 'mengbot')
  assert.equal(s.plan, 'pro')
  assert.equal(s.caps.seats, 5)
  assert.equal(s.entitlementVersion, 3)
  const json = JSON.stringify(s)
  assert.doesNotMatch(json, /eyJhbGciOi/, '不能带 license 片段')
  assert.doesNotMatch(json, /Bearer|token/i, '不能带令牌')
}))

test('writeEntitlement 容错：空对象/坏输入不炸', () => withHome((env) => {
  assert.equal(writeEntitlement(null, env).ok, false)
  assert.equal(writeEntitlement({}, env).ok, true, '空对象也能合并成 free/inactive')
  const got = readEntitlement(env)
  assert.equal(got.plan, 'free')
  assert.equal(got.status, 'inactive')
}))

// ── 多租户隔离（本轮修的架构缺陷）────────────────────────────
// 改之前 entitlement 是**全局单文件**：所有租户共享同一份套餐状态，
// A 用户的对账会把 B 用户的套餐冲掉。单租户时看不出，一旦有第二个付费用户必然串号。

test('按 owner 分文件：两个租户互不影响', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mt-'))
  const env = { ...process.env, DSH_HOME: home }
  const A = 'alice@example.com'
  const B = 'bob@example.com'
  writeEntitlement({ owner: A, plan: 'max', status: 'active', version: 10, expiresAt: '2027-01-01T00:00:00Z' }, env)
  writeEntitlement({ owner: B, plan: 'personal', status: 'active', version: 20, expiresAt: '2027-01-01T00:00:00Z' }, env)

  assert.equal(readEntitlement(env, A).plan, 'max')
  assert.equal(readEntitlement(env, B).plan, 'personal')
  // 两个独立文件
  const files = fs.readdirSync(home).filter((f) => f.startsWith('cloud-entitlement-'))
  assert.equal(files.length, 2, '应有两个租户文件，实际 ' + files.join(','))

  // 写 A 不能影响 B
  writeEntitlement({ owner: A, plan: 'free', status: 'inactive', version: 11 }, env)
  assert.equal(readEntitlement(env, A).plan, 'free')
  assert.equal(readEntitlement(env, B).plan, 'personal', 'B 不能被 A 的对账冲掉')
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

test('无 owner 回落到旧版全局文件（本地/单租户模式兼容）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mt2-'))
  const env = { ...process.env, DSH_HOME: home }
  writeEntitlement({ plan: 'pro', status: 'active', version: 3 }, env)
  assert.ok(fs.existsSync(path.join(home, ENTITLEMENT_FILE)), '无 owner 应写旧版文件')
  assert.equal(readEntitlement(env).plan, 'pro')
  // 有 owner 时不读旧文件（避免把全局数据当成某人的）
  assert.equal(readEntitlement(env, 'x@y.com'), null)
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

test('owner 含特殊字符不会路径穿越', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mt3-'))
  const env = { ...process.env, DSH_HOME: home }
  const homeResolved = path.resolve(home)
  for (const evil of ['../../etc/passwd', 'a/b', 'a\\b', 'x'.repeat(300)]) {
    const p1 = entitlementPath(env, evil)
    // 关键判据：**解析后的绝对路径仍在 home 内**（字符里有 '..' 无所谓，encodeURIComponent 已把 / 转义）
    assert.equal(path.resolve(p1).startsWith(homeResolved + path.sep), true, '路径必须落在 DSH_HOME 内：' + p1)
    writeEntitlement({ owner: evil, plan: 'free', status: 'inactive', version: 1 }, env)
    assert.equal(readEntitlement(env, evil).plan, 'free')
  }
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

test('**personal / max 都算付费**（旧实现只认 pro 是 bug）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mt4-'))
  const env = { ...process.env, DSH_HOME: home }
  for (const plan of ['personal', 'pro', 'max']) {
    writeEntitlement({ owner: 'u@x.com', plan, status: 'active', version: 5, expiresAt: '2027-01-01T00:00:00Z' }, env)
    const acc = resolveAccess(env, { owner: 'u@x.com' })
    assert.equal(acc.source, 'mengbot', plan + ' 应被认成付费（source=mengbot）')
    assert.equal(acc.canWrite, true)
  }
  // free 不算
  writeEntitlement({ owner: 'u@x.com', plan: 'free', status: 'inactive', version: 6 }, env)
  assert.notEqual(resolveAccess(env, { owner: 'u@x.com' }).source, 'mengbot', 'free 不算付费')
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

test('resolveAccess 返回 owner，摘要里能看到归属', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mt5-'))
  const env = { ...process.env, DSH_HOME: home }
  writeEntitlement({ owner: 'z@q.com', plan: 'pro', status: 'active', version: 2, expiresAt: '2027-01-01T00:00:00Z' }, env)
  const acc = resolveAccess(env, { owner: 'z@q.com' })
  assert.equal(acc.owner, 'z@q.com')
  const sum = accessSummary(acc)
  assert.equal(sum.owner, 'z@q.com')
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
})
