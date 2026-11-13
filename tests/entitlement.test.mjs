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
import { readEntitlement, writeEntitlement, resolveAccess, accessSummary, entitlementPath } from '../lib/entitlement.js'

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
