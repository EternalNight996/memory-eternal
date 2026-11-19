// issue #67：面板「查看库」作用域。
// 现象：按项目隔离时写入走项目库，但面板/API 全读默认库 → 项目库的待审/日志/健康在 UI 里永远看不到。
// 修法：cookie `me_view_vault=<profile 名>` 只影响数据面路由，不改 activeVault / 默认库。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureVault, writeCard } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'
import { createApi } from '../lib/api.js'

let api, base, rootA, rootB, home, savedHome
const H = (name) => ({ cookie: 'me_view_vault=' + encodeURIComponent(name) })
const get = (p, headers) => fetch(base + p, { headers }).then((r) => r.json())

before(async () => {
  savedHome = process.env.DSH_HOME
  home = await fsp.mkdtemp(path.join(os.tmpdir(), 'me-view-scope-'))
  process.env.DSH_HOME = home // 隔离：/config 等系统路由不读本机真实配置
  rootA = path.join(home, 'vault-a')
  rootB = path.join(home, 'vault-b')
  await ensureVault(rootA)
  await ensureVault(rootB)
  const body = '这张卡的正文需要足够长，才能通过写卡校验并进入卡片列表，用来验证查看库作用域。'
  await writeCard(rootA, { kind: 'knowledge', title: '默认库卡', tags: ['scope'], body: body + 'A', status: 'approved', submittedBy: 'test' }, { dedup: false })
  await writeCard(rootB, { kind: 'knowledge', title: '项目库卡', tags: ['scope'], body: body + 'B', status: 'approved', submittedBy: 'test' }, { dedup: false })
  api = http.createServer(createApi({
    vaultDir: () => rootA,
    vaultRoots: () => [{ name: '', root: rootA }, { name: 'code', root: rootB }],
    getSettings: () => ({ vaultProfiles: [{ name: 'code', path: rootB }] }),
  }))
  await new Promise((r) => api.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + api.address().port + '/memory-eternal/api'
})

after(async () => {
  closeAllDb()
  if (api) await new Promise((r) => api.close(r))
  if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome
  try { await fsp.rm(home, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
})

test('默认：/cards 读默认库', async () => {
  const r = await get('/cards')
  assert.ok(r.ok, JSON.stringify(r))
  const titles = r.cards.map((c) => c.title)
  assert.ok(titles.includes('默认库卡'), JSON.stringify(titles))
  assert.ok(!titles.includes('项目库卡'), JSON.stringify(titles))
})

test('cookie 指定 profile：/cards、/overview、/audit/list 都跟随', async () => {
  const cards = await get('/cards', H('code'))
  assert.ok(cards.cards.some((c) => c.title === '项目库卡'), JSON.stringify(cards.cards.map((c) => c.title)))
  const ov = await get('/overview', H('code'))
  assert.equal(path.resolve(String(ov.vaultDir)), path.resolve(rootB), JSON.stringify(ov))
  const audit = await get('/audit/list', H('code'))
  assert.ok(audit.ok, JSON.stringify(audit))
})

test('未知 / 非法 cookie：回退默认库，不打开任意路径', async () => {
  for (const bad of ['nope', '..%2F..%2Fetc', '%00']) {
    const r = await get('/cards', { cookie: 'me_view_vault=' + bad })
    assert.ok(r.ok, 'cookie=' + bad + ' ' + JSON.stringify(r))
    assert.ok(r.cards.some((c) => c.title === '默认库卡'), 'cookie=' + bad)
    assert.ok(!r.cards.some((c) => c.title === '项目库卡'), 'cookie=' + bad)
  }
})

test('系统路由不跟随作用域（/vaults 仍按默认库）', async () => {
  const r = await get('/vaults', H('code'))
  assert.ok(r.ok, JSON.stringify(r))
  const list = Array.isArray(r.vaults) ? r.vaults : []
  const current = list.filter((v) => v.isCurrent).map((v) => path.resolve(String(v.path)))
  assert.ok(current.includes(path.resolve(rootA)), JSON.stringify(current))
})
