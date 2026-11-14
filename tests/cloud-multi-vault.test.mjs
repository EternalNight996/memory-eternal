// 回归：云端多库（每个租户可有多个记忆库）+ caps.vaults 校验。
//
// 布局：cloud-vaults/<owner>/memory-eternal.db            ← 默认库（原位，零迁移）
//       cloud-vaults/<owner>/vaults/<slug>/memory-eternal.db ← 命名库
//
// 为什么要独立于本地多库：本地库是用户自己放在 .dsh 下的目录，不受 API 管理；
// 云端库由租户通过 API 创建，必须受 caps.vaults 约束（订阅页承诺了库数量）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApi } from '../lib/api.js'
import { normalizeVaultSlug, createNamedVault, listOwnerVaults, namedVaultRoot } from '../lib/cloud-vaults.js'

/** 起一个"云端租户实例"：vaultRoot 在 cloud-vaults/<owner> 下，caps 可注入。 */
async function bootTenant({ caps = {}, seedDefault = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mv-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  const ownerRoot = path.join(tmp, 'cloud-vaults', 'yg')
  fs.mkdirSync(ownerRoot, { recursive: true })
  if (seedDefault) fs.writeFileSync(path.join(ownerRoot, 'memory-eternal.db'), 'x')
  const h = createApi({
    vaultDir: () => ownerRoot,
    vaultRoots: () => [{ name: 'yg', root: ownerRoot }],
    getSettings: () => ({}),
    getCaptureLog: () => null,
    getCaps: () => caps,
  })
  const srv = http.createServer((q, r) => h(q, r))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/memory-eternal/api`
  return {
    base, ownerRoot,
    call: async (p, opt) => { const r = await fetch(base + p, opt); return { status: r.status, body: await r.json().catch(() => ({})) } },
    create: (name) => fetch(base + '/vaults/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) })),
    close() {
      srv.close()
      if (prevHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prevHome
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* SQLite 句柄未关时会失败，忽略 */ }
    },
  }
}

test('slug 校验：合法 / 非法 / 穿越 / 保留名', () => {
  assert.equal(normalizeVaultSlug('work'), 'work')
  assert.equal(normalizeVaultSlug('My-Vault_1'), 'my-vault_1')
  assert.equal(normalizeVaultSlug(''), null)
  assert.equal(normalizeVaultSlug('../etc'), null, '路径穿越必须拒绝')
  assert.equal(normalizeVaultSlug('..'), null)
  assert.equal(normalizeVaultSlug('con'), null, 'Windows 保留名必须拒绝')
  assert.equal(normalizeVaultSlug('a'.repeat(33)), null, '超长必须拒绝')
  assert.equal(normalizeVaultSlug('中文'), null, '非 ASCII 必须拒绝')
  assert.equal(normalizeVaultSlug('a b'), null)
})

test('namedVaultRoot 对非法 slug 返回空串（不产生可写路径）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-nv-'))
  try {
    assert.equal(namedVaultRoot(tmp, '../x'), '')
    assert.equal(namedVaultRoot(tmp, 'ok'), path.join(path.resolve(tmp), 'vaults', 'ok'))
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('建库幂等：第二次 created=false', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-cn-'))
  try {
    assert.equal(createNamedVault(tmp, 'work').created, true)
    assert.equal(createNamedVault(tmp, 'work').created, false)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('枚举：默认库在前，命名库按名字排序', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ls-'))
  try {
    fs.writeFileSync(path.join(tmp, 'memory-eternal.db'), 'x')
    createNamedVault(tmp, 'zeta')
    createNamedVault(tmp, 'alpha')
    const list = listOwnerVaults(tmp)
    assert.equal(list[0].kind, 'default', '默认库必须排第一')
    assert.deepEqual(list.map((v) => v.name), ['default', 'alpha', 'zeta'])
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('云端建库：caps 未设时不限，建几个都行', async () => {
  const t = await bootTenant({ caps: {} })
  try {
    assert.equal((await t.create('a')).status, 200)
    assert.equal((await t.create('b')).status, 200)
    assert.equal((await t.create('c')).status, 200)
  } finally { t.close() }
})

test('云端建库：caps.vaults=3 时第 4 个被 403 拦，带 limit/used/upgrade', async () => {
  const t = await bootTenant({ caps: { vaults: 3 } })
  try {
    assert.equal((await t.create('a')).body.ok, true)
    assert.equal((await t.create('b')).body.ok, true)
    const over = await t.create('c')
    assert.equal(over.status, 403)
    assert.equal(over.body.error, 'quota_exceeded')
    assert.equal(over.body.field, 'vaults')
    assert.equal(over.body.limit, 3)
    assert.equal(over.body.used, 3, 'used 应含默认库')
    assert.ok(String(over.body.upgrade || '').includes('subscribe'), '要带升级链接')
  } finally { t.close() }
})

test('重名幂等优先于配额：满了也能重复建同名（返回 created=false）', async () => {
  const t = await bootTenant({ caps: { vaults: 2 } })
  try {
    await t.create('work')
    // 现在 2 个（default + work）已满
    const dup = await t.create('work')
    assert.equal(dup.status, 200, '重名应幂等成功，不该被配额拦：' + JSON.stringify(dup.body))
    assert.equal(dup.body.created, false)
  } finally { t.close() }
})

test('/vaults 的 quota 字段：limit 来自 caps，used 含所有库', async () => {
  const t = await bootTenant({ caps: { vaults: 5 } })
  try {
    await t.create('work')
    const r = await t.call('/vaults')
    assert.equal(r.body.quota.limit, 5)
    assert.equal(r.body.quota.used, 2, '默认库 + work')
    assert.equal(r.body.quota.limited, true)
    assert.equal(r.body.quota.field, 'vaults')
  } finally { t.close() }
})

test('新建的库立刻出现在枚举里（即便 .db 还没建）', async () => {
  const t = await bootTenant({ caps: { vaults: 5 } })
  try {
    await t.create('work')
    const r = await t.call('/vaults')
    const names = r.body.vaults.map((v) => v.name)
    assert.ok(names.includes('work'), '刚建的库必须可见，实际：' + names.join(','))
    const w = r.body.vaults.find((v) => v.name === 'work')
    assert.equal(w.vaultKind, 'named')
  } finally { t.close() }
})

test('本地实例不许建库（避免 API 在用户 .dsh 下随意创建目录）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-lc-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  try {
    const h = createApi({ vaultDir: () => tmp, vaultRoots: () => [{ name: '', root: tmp }], getSettings: () => ({}), getCaptureLog: () => null })
    const srv = http.createServer((q, r) => h(q, r))
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${srv.address().port}/memory-eternal/api`
    const r = await fetch(base + '/vaults/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })
    const d = await r.json()
    srv.close()
    assert.equal(r.status, 400)
    assert.match(String(d.error || ''), /云端租户实例/)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
