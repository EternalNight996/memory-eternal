// 记忆核心 · 回收中心（issue #57）
//
// 现场：审核里点「驳回」的卡在回收站永远看不到；「清空回收站」点了没反应，
// 只能一张一张去点永久删除。本文件锁定四条不变式：
//   1. 回收站列表同时收 deleted 与 rejected（过去只查 deleted）；
//   2. 「清空」= 永久删除全部回收项，不是只清过期；
//   3. 保留期参数 days=0 不会再被 `|| 30` 吞掉（这才是「点了没反应」的根因）；
//   4. 驳回卡的「恢复」只能退回审核队列，不得直接变 approved（否则回收站成审核旁路）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ensureVault, writeCard, recycleList, setCardStatus, deleteCard, restoreCard,
  purgeExpired, purgeAllRecycle, listCards,
} from '../lib/vault.js'
import { getDb, closeAllDb, MAIN_STATUS } from '../lib/db.js'
import { parseRetentionDays } from '../lib/api.js'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-recycle-'))
after(async () => {
  closeAllDb()
  try { await fs.rm(tmpRoot, { recursive: true, force: true }) } catch { /* Windows 句柄未释放时忽略 */ }
})

let n = 0
const freshRoot = async () => {
  const root = path.join(tmpRoot, `vault-${n++}`)
  await ensureVault(root)
  return root
}

// 正文必须互不相同：writeCard 默认做 bigram Jaccard 去重（阈值 0.62），
// 模板化的相似句会被拦成 duplicate，测的就不是回收逻辑了。
let seq = 0
const body = (tag) => {
  seq++
  let s = ''
  for (let i = 0; i < 40; i++) s += String.fromCharCode(0x4e00 + ((seq * 37 + i * 11) % 3000))
  return `[${tag}] ${s}`
}

const makePending = async (root, title) => {
  const out = await writeCard(root, { kind: 'knowledge', title, body: body(title), status: 'pending', submittedBy: 'test' })
  return out.path
}

test('回收站列表同时包含已删除与已驳回（issue #57 主症状）', async () => {
  const root = await freshRoot()
  const pRej = await makePending(root, '被驳回的卡')
  const pDel = await makePending(root, '被删除的卡')
  await setCardStatus(root, pRej, 'rejected', { changedBy: 'user', reason: '内容不对' })
  await deleteCard(root, pDel)

  const items = await recycleList(root)
  const byStatus = items.map((c) => c.status).sort()
  assert.deepEqual(byStatus, ['deleted', 'rejected'], '驳回卡必须进回收站，否则用户以为删不掉')
  assert.ok(items.some((c) => c.path === pRej))
  assert.ok(items.some((c) => c.path === pDel))
})

test('purgeAllRecycle 永久删除全部回收项（deleted + rejected）', async () => {
  const root = await freshRoot()
  const pRej = await makePending(root, '待清驳回卡')
  const pDel = await makePending(root, '待清删除卡')
  await setCardStatus(root, pRej, 'rejected', { changedBy: 'user' })
  await deleteCard(root, pDel)

  const r = await purgeAllRecycle(root)
  assert.equal(r.purged, 2)
  assert.equal(r.failed.length, 0)
  assert.equal((await recycleList(root)).length, 0, '清空后列表必须真的空')
  const left = getDb(root).prepare('SELECT COUNT(*) n FROM quarantine').get().n
  assert.equal(left, 0, '隔离区不得残留')
})

test('purgeExpired(days=0) 会清掉刚删的卡（保留期为 0 不能被当成 30）', async () => {
  const root = await freshRoot()
  const pDel = await makePending(root, '刚删的卡')
  await deleteCard(root, pDel)
  const r = await purgeExpired(root, 0)
  assert.equal(r.purged, 1, 'days=0 的语义是「立刻全部过期」')
  assert.equal((await recycleList(root)).length, 0)
})

test('parseRetentionDays：区分「没传」与「传 0」（旧实现 || 30 的回归）', () => {
  assert.equal(parseRetentionDays(null), 30)
  assert.equal(parseRetentionDays(undefined), 30)
  assert.equal(parseRetentionDays(''), 30)
  assert.equal(parseRetentionDays('0'), 0, '显式 0 必须保留，这正是清空回收站的入参')
  assert.equal(parseRetentionDays('7'), 7)
  assert.throws(() => parseRetentionDays('-1'))
  assert.throws(() => parseRetentionDays('abc'))
})

test('驳回卡的「恢复」只退回审核队列，不得直接 approved（审核旁路）', async () => {
  const root = await freshRoot()
  const p = await makePending(root, '驳回后恢复的卡')
  await setCardStatus(root, p, 'rejected', { changedBy: 'user' })

  const r = await restoreCard(root, p)
  assert.equal(r.status, 'pending')
  const row = getDb(root).prepare('SELECT status FROM quarantine WHERE path = ?').get(p)
  assert.equal(row.status, 'pending', '应回到待审')
  const inMain = getDb(root).prepare('SELECT COUNT(*) n FROM cards WHERE path = ?').get(p).n
  assert.equal(inMain, 0, '主库只存 approved，驳回卡不能借恢复直接入库')
  assert.equal((await listCards(root, { status: [MAIN_STATUS] })).length, 0)
})

test('已删除卡的「恢复」仍回主库 approved（原行为不回退）', async () => {
  const root = await freshRoot()
  const p = await makePending(root, '删除后恢复的卡')
  await deleteCard(root, p)
  const r = await restoreCard(root, p)
  assert.equal(r.status, MAIN_STATUS)
  assert.equal(getDb(root).prepare('SELECT COUNT(*) n FROM cards WHERE path = ?').get(p).n, 1)
})
