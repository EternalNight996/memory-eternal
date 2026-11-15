// 发号器（card_sequence）健壮性：丢了要能自愈，恢复出厂后不能把库变成"写不进卡的死库"
//
// 真实事故（2026-11-15）：用户在面板里「恢复出厂设置」后，自动沉淀 / 审核全部静默停工 ——
// 卡片列表一直是空的，没有任何报错弹窗。根因是清表时把 card_sequence 也 DELETE 了，
// 而只重建了 schema_version；于是下一次 nextCardId() 抛「card_sequence 未初始化」，写卡全部失败。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApi, API_PREFIX } from '../lib/api.js'
import { ensureVault, writeCard, listCards } from '../lib/vault.js'
import { getDb, closeAllDb, nextCardId, ensureCardSequence } from '../lib/db.js'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-seq-'))
const home = path.join(tmpRoot, 'home')
process.env.DSH_HOME = home
await fs.mkdir(home, { recursive: true })

const newVault = async (name) => {
  const dir = path.join(tmpRoot, name)
  await ensureVault(dir)
  return dir
}

after(async () => {
  closeAllDb()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

const fakeRes = () => {
  const out = { status: 0, body: '' }
  out.writeHead = (s) => { out.status = s }
  out.setHeader = () => {}
  out.end = (b) => { out.body = String(b || '') }
  out.on = () => {}
  out.once = () => {}
  out.emit = () => {}
  return out
}
const callApi = async (api, url, body) => {
  const res = fakeRes()
  const chunks = body === null || body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    url, method: 'POST', headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c },
  }
  await api(req, res)
  let json = null
  try { json = JSON.parse(res.body) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

test('发号器丢了：nextCardId 就地自愈（按两张表最大 id 校准），不再抛「未初始化」', async () => {
  const dir = await newVault('v1')
  await writeCard(dir, { kind: 'knowledge', title: '甲', tags: ['t'], body: '甲卡正文，用来占住一个 id 并验证自愈后的校准。', status: 'approved' })
  const db = getDb(dir)
  const before = Number(db.prepare("SELECT seq FROM card_sequence WHERE name='card'").get().seq)
  assert.ok(before >= 1)
  // 复刻事故现场：发号器行被清掉，但 cards 里还有数据
  db.prepare("DELETE FROM card_sequence WHERE name='card'").run()
  const id = nextCardId(db)
  assert.equal(typeof id, 'number')
  assert.ok(id > before, '自愈后必须接着已有最大 id 往后发，不能发重复 id：' + id + ' vs ' + before)
})

test('ensureCardSequence：空库补行后从 1 开始；重复调用幂等', async () => {
  const dir = await newVault('v2')
  const db = getDb(dir)
  db.prepare("DELETE FROM card_sequence WHERE name='card'").run()
  assert.equal(ensureCardSequence(db), 0)
  assert.equal(ensureCardSequence(db), 0, '第二次调用不能把 seq 弄乱')
  assert.equal(nextCardId(db), 1)
})

test('恢复出厂设置之后：仍然写得进卡（这是事故的正向回归）', async () => {
  const dir = await newVault('v3')
  await writeCard(dir, { kind: 'knowledge', title: '清空前', tags: ['t'], body: '清空前要有一张卡，便于验证清空真的发生。', status: 'approved' })
  await writeCard(dir, { kind: 'knowledge', title: '待审', tags: ['t'], body: '待审卡正文，用于验证隔离区也会被清空。', status: 'pending' })
  const api = createApi({ vaultDir: () => dir, getSettings: () => ({}) })
  const r = await callApi(api, API_PREFIX + '/factory-reset', { confirm: '恢复出厂设置', expected: '恢复出厂设置' })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.ok(r.json.backupPath, '清空前必须留下备份')
  assert.equal(Number(r.json.cardSeq) >= 0, true, '响应里要带回发号器状态')
  // 清空生效
  assert.equal((await listCards(dir)).length, 0)
  // 关键：还能继续写卡（发号器没丢）
  const w = await writeCard(dir, { kind: 'knowledge', title: '清空后', tags: ['t'], body: '清空之后新写的卡，必须能成功落库并进待审。', status: 'pending' })
  assert.equal(w.ok, true)
  assert.ok(String(w.path || '').length > 0)
  const pending = await listCards(dir, { status: ['pending'] })
  assert.equal(pending.length, 1)
})

test('恢复出厂不会清掉发号器表（清完仍有一行，且只影响当前库）', async () => {
  const other = await newVault('v4-other')
  await writeCard(other, { kind: 'knowledge', title: '别的库', tags: ['t'], body: '别的库里的卡，恢复出厂不该动它。', status: 'approved' })
  const dir = await newVault('v4')
  await writeCard(dir, { kind: 'knowledge', title: '当前库', tags: ['t'], body: '当前库里的卡，会被清空。', status: 'approved' })
  const api = createApi({ vaultDir: () => dir, getSettings: () => ({}) })
  const r = await callApi(api, API_PREFIX + '/factory-reset', { confirm: '恢复出厂设置', expected: '恢复出厂设置' })
  assert.equal(r.json.ok, true)
  assert.ok(!Array.isArray(r.json.cleared) || !r.json.cleared.includes('card_sequence'), 'card_sequence 不该出现在被清表清单里')
  const db = getDb(dir)
  const row = db.prepare("SELECT seq FROM card_sequence WHERE name='card'").get()
  assert.ok(row && Number(row.seq) >= 0, '发号器行必须还在')
  assert.equal((await listCards(other)).length, 1, '别的库一个字节都不该动')
})
