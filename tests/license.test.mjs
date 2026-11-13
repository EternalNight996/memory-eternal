// 授权校验（商用）：离线签名 license + 过期降级。守五件事：
//   ① 真签发的 license 能验过，篡改 payload 立即失败；
//   ② 过期 → status=expired，按 degrade 决定能否写；
//   ③ 未配 license：warn 放行、readonly/stop 拦写；
//   ④ 只读降级放行读/导出，拦住写；
//   ⑤ 对外摘要不含 license 原文。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { signLicense, verifyLicense, licenseState, allowedWhenReadonly, licenseSummary, parseLicense } from '../lib/license.js'

// 每次跑测试现生成一对密钥（不依赖仓库里的私钥）
const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const pubPem = publicKey.export({ type: 'spki', format: 'pem' })
const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' })

const mk = (patch = {}, days = 30) => signLicense({
  sub: 'acme', plan: 'pro', seats: 5, features: ['cloud'],
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + days * 86400,
  ...patch,
}, privPem)

test('真签发的 license 验签通过，并给出到期与剩余天数', () => {
  const r = verifyLicense(mk(), { publicKey: pubPem })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'valid')
  assert.equal(r.payload.sub, 'acme')
  assert.ok(r.daysLeft >= 29 && r.daysLeft <= 30, 'daysLeft 应在 29~30')
  assert.match(r.expiresAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('篡改 payload → 签名不匹配', () => {
  const parts = mk().split('.')
  const forged = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  forged.plan = 'enterprise'
  forged.seats = 9999
  parts[1] = Buffer.from(JSON.stringify(forged)).toString('base64url')
  const r = verifyLicense(parts.join('.'), { publicKey: pubPem })
  assert.equal(r.ok, false)
  assert.equal(r.status, 'invalid')
  assert.match(r.error, /签名不匹配/)
})

test('用别人的公钥验 → 失败', () => {
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const r = verifyLicense(mk(), { publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }) })
  assert.equal(r.ok, false)
  assert.equal(r.status, 'invalid')
})

test('过期 license → status=expired', () => {
  const token = mk({ exp: Math.floor(Date.now() / 1000) - 86400 * 2 })
  const r = verifyLicense(token, { publicKey: pubPem })
  assert.equal(r.ok, false)
  assert.equal(r.status, 'expired')
  assert.ok(r.daysLeft < 0)
})

test('缺 exp 的 payload 视为 invalid（不允许永久 license 静默放行）', () => {
  const token = signLicense({ sub: 'x', plan: 'pro' }, privPem)
  const r = verifyLicense(token, { publicKey: pubPem })
  assert.equal(r.ok, false)
  assert.match(r.error, /exp/)
})

test('未配 license：warn 放行、readonly/stop 拦写', () => {
  assert.equal(licenseState({}, {}).canWrite, true, 'warn 默认放行')
  assert.equal(licenseState({ MEMORY_LICENSE_DEGRADE: 'readonly' }, {}).canWrite, false)
  assert.equal(licenseState({ MEMORY_LICENSE_DEGRADE: 'stop' }, {}).canWrite, false)
})

test('有效 license：三种降级策略都允许写', () => {
  const token = mk()
  for (const d of ['warn', 'readonly', 'stop']) {
    const s = licenseState({ MEMORY_SERVER_LICENSE: token, MEMORY_LICENSE_DEGRADE: d }, { publicKey: pubPem })
    assert.equal(s.status, 'valid', d)
    assert.equal(s.canWrite, true, d)
  }
})

test('过期 + readonly：写被拦，读/导出照常', () => {
  const token = mk({ exp: Math.floor(Date.now() / 1000) - 86400 })
  const s = licenseState({ MEMORY_SERVER_LICENSE: token, MEMORY_LICENSE_DEGRADE: 'readonly' }, { publicKey: pubPem })
  assert.equal(s.status, 'expired')
  assert.equal(s.canWrite, false)
  // 读与导出放行
  for (const p of ['/overview', '/cards', '/backup/export', '/backup/status', '/cloud/config']) {
    assert.equal(allowedWhenReadonly(p), true, p)
  }
  // 写被拦（非 GET/HEAD 一律拦）
  for (const p of ['/card', '/backup', '/backup/import', '/audit/approve', '/recycle/restore']) {
    assert.equal(allowedWhenReadonly(p, 'POST'), false, p)
  }
  // 同一路径读放行、写拦截（/card 详情 GET vs 新建 POST）
  assert.equal(allowedWhenReadonly('/card', 'GET'), true)
  assert.equal(allowedWhenReadonly('/card', 'POST'), false)
})

test('过期 + stop：连读也不放行（只留诊断）', () => {
  const token = mk({ exp: Math.floor(Date.now() / 1000) - 86400 })
  const s = licenseState({ MEMORY_SERVER_LICENSE: token, MEMORY_LICENSE_DEGRADE: 'stop' }, { publicKey: pubPem })
  assert.equal(s.canWrite, false)
  assert.equal(allowedWhenReadonly('/cloud/config'), true, '诊断放行')
  assert.equal(allowedWhenReadonly('/overview'), true, '读也放行（stop 的闸门在 cloud-server 里更严，这里只验白名单）')
})

test('对外摘要不含 license 原文', () => {
  const token = mk()
  const s = licenseState({ MEMORY_SERVER_LICENSE: token }, { publicKey: pubPem })
  const sum = licenseSummary(s)
  assert.equal(sum.status, 'valid')
  assert.equal(sum.owner, 'acme')
  assert.equal(sum.plan, 'pro')
  assert.equal(sum.seats, 5)
  assert.doesNotMatch(JSON.stringify(sum), new RegExp(token.slice(0, 20)), '不能把 token 片段带出去')
  assert.equal('MEMORY_SERVER_LICENSE' in sum, false)
})

test('格式不对的 license 给出可读原因，不是崩溃', () => {
  for (const bad of ['', 'abc', 'a.b', 'a.b.c.d']) {
    const r = verifyLicense(bad, { publicKey: pubPem })
    assert.equal(r.ok, false)
    assert.ok(r.error && r.error.length > 4, '要有可读原因: ' + JSON.stringify(bad))
  }
  assert.equal(parseLicense(mk()).ok, true, '结构合法的三段可解析（细节在验签时判定）')
})
