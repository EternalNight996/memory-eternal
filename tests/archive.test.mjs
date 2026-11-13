// 归档（archive）：把「可能是垃圾但不敢删」的卡藏起来，数据完整保留。
//
// 为什么需要：垃圾扫描给出的 neverRecalled / stale 只是弱证据，直接删风险太高。
// 归档 = 先藏起来 —— 默认检索看不到，需要时能翻出来、能一键恢复。
//
// 物理上它住在 quarantine 表（复用两套存储的隔离），所以主库检索天然看不到它，
// 不会重演「忘了加 WHERE 就泄漏」那类 bug。
//
// 守七件事：
//   ① 归档后主库没有它，quarantine 里 status='archived'；
//   ② 默认 search 看不到归档卡；
//   ③ includeArchived=true 能翻出来，且带 archived 标记、排在正常结果之后；
//   ④ listCards({status:'archived'}) 能列出；
//   ⑤ restoreCard 能把它放回主库；
//   ⑥ 归档卡**不计召回**（否则「从未被召回」的判据会失真）；
//   ⑦ /cards/bulk 支持 action=archive。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { search, writeCard, setCardStatus, restoreCard, listCards } from '../lib/vault.js'
import { getDb, closeDb, ARCHIVE_STATUS, QUARANTINE_STATUSES } from '../lib/db.js'
import { resetRecallState, flushRecall } from '../lib/recall-track.js'
import { createApi } from '../lib/api.js'

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'me-arch-'))
}

async function cleanup(root) {
  resetRecallState(root)
  try { closeDb(root) } catch { /* 忽略 */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

function withApi(root, fn) {
  const handler = createApi({ vaultDir: () => root, vaultRoots: () => [{ name: 'v', root }], getSettings: () => ({}) })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  return new Promise((resolve, reject) => {
    srv.listen(0, '127.0.0.1', async () => {
      let err = null
      try { await fn(`http://127.0.0.1:${srv.address().port}/memory-eternal/api`) } catch (e) { err = e }
      await new Promise((r) => srv.close(r))
      if (err) reject(err); else resolve()
    })
  })
}

const BODY = '这是一张用于验证归档能力的卡片，讲的是 Kubernetes 滚动更新策略与回滚预案。'

test('常量：archived 属于隔离区状态', () => {
  assert.equal(ARCHIVE_STATUS, 'archived')
  assert.ok(QUARANTINE_STATUSES.includes(ARCHIVE_STATUS), 'archived 应算隔离区状态（不进主库）')
})

test('归档后主库消失、隔离区标记 archived', async () => {
  const root = tmpVault()
  const w = await writeCard(root, { kind: 'knowledge', title: '归档测试卡', body: BODY, status: 'approved' })
  assert.equal(w.store, 'cards', '新卡应先在主库')

  const r = await setCardStatus(root, w.path, 'archived', { changedBy: 't', reason: '验证' })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'archived')
  assert.equal(r.store, 'quarantine', '归档卡应搬到隔离区')

  const db = getDb(root)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM cards WHERE path = ?').get(w.path).n, 0, '主库不该再有它')
  assert.equal(db.prepare('SELECT status FROM quarantine WHERE path = ?').get(w.path).status, 'archived')
  await cleanup(root)
})

test('默认 search 看不到归档卡；includeArchived 能翻出来', async () => {
  const root = tmpVault()
  const w = await writeCard(root, { kind: 'knowledge', title: '归档测试卡', body: BODY, status: 'approved' })
  assert.ok((await search(root, 'Kubernetes 滚动更新')).length >= 1, '归档前应能搜到')

  await setCardStatus(root, w.path, 'archived', { changedBy: 't', reason: '验证' })
  assert.equal((await search(root, 'Kubernetes 滚动更新')).length, 0, '归档后默认搜索应为空')

  const withArch = await search(root, 'Kubernetes 滚动更新', { includeArchived: true })
  assert.equal(withArch.length, 1, 'includeArchived 应能翻出归档卡')
  assert.equal(withArch[0].archived, true, '应带 archived 标记')
  assert.equal(withArch[0].where, 'archived')
  await cleanup(root)
})

test('归档卡排在正常结果之后（不挤掉日常召回）', async () => {
  const root = tmpVault()
  // 两张都含 "Redis" 但正文差异要够大 —— 否则会被去重（相似度 ≥0.62）拦下，
  // 那就造不出"同时有正常卡与归档卡"的场景了。
  const a = await writeCard(root, { kind: 'knowledge', title: 'AOF 重写策略', body: 'Redis 持久化之 AOF 重写：触发条件、fsync 策略与磁盘 IO 的权衡记录。', status: 'approved' })
  const b = await writeCard(root, { kind: 'knowledge', title: '哨兵选举', body: 'Redis 集群拓扑与哨兵选举机制，包含故障转移的完整流程与常见坑。', status: 'approved' })
  assert.equal(a.ok, true, '第一张应写入')
  assert.equal(b.ok, true, '第二张应写入（与第一张差异足够）')
  await setCardStatus(root, b.path, 'archived', { changedBy: 't', reason: '验证' })

  const hits = await search(root, 'Redis', { includeArchived: true })
  assert.ok(hits.length >= 2, '应同时有正常卡与归档卡，实际 ' + hits.length)
  assert.ok(!hits[0].archived, '第一条必须是正常卡（归档排后面）')
  assert.equal(hits[hits.length - 1].archived, true, '最后一条应是归档卡')
  await cleanup(root)
})

test('listCards 能列出归档', async () => {
  const root = tmpVault()
  const w = await writeCard(root, { kind: 'knowledge', title: '列出测试', body: BODY, status: 'approved' })
  await setCardStatus(root, w.path, 'archived', { changedBy: 't', reason: '验证' })
  // status 传字符串（不是数组）也要能用 —— storesFor 必须容忍
  const rows = await listCards(root, { status: 'archived', limit: 10 })
  assert.equal(rows.length, 1, '应能列出 1 张归档卡')
  assert.equal(rows[0].path, w.path)
  await cleanup(root)
})

test('restoreCard 把归档卡放回主库', async () => {
  const root = tmpVault()
  const w = await writeCard(root, { kind: 'knowledge', title: '恢复测试', body: BODY, status: 'approved' })
  await setCardStatus(root, w.path, 'archived', { changedBy: 't', reason: '验证' })
  const r = await restoreCard(root, w.path)
  assert.equal(r.ok, true)
  assert.equal(r.status, 'approved')
  assert.ok((await search(root, 'Kubernetes')).length >= 1, '恢复后应重新可搜到')
  await cleanup(root)
})

test('归档卡不计召回（否则「从未被召回」判据失真）', async () => {
  const root = tmpVault()
  const w = await writeCard(root, { kind: 'knowledge', title: '计数测试', body: BODY, status: 'approved' })
  await search(root, 'Kubernetes')           // 主库阶段记一次
  flushRecall(root)
  const db = getDb(root)
  const before = db.prepare('SELECT recall_count n FROM cards WHERE path = ?').get(w.path).n
  assert.ok(before >= 1, '主库阶段应计到召回')

  await setCardStatus(root, w.path, 'archived', { changedBy: 't', reason: '验证' })
  const archivedBefore = db.prepare('SELECT recall_count n FROM quarantine WHERE path = ?').get(w.path).n || 0

  await search(root, 'Kubernetes', { includeArchived: true })
  flushRecall(root)
  const archivedAfter = db.prepare('SELECT recall_count n FROM quarantine WHERE path = ?').get(w.path).n || 0
  assert.equal(archivedAfter, archivedBefore, '归档卡被翻出来不该增加召回计数')
  await cleanup(root)
})

test('/cards/bulk 支持 action=archive（默认 dryRun 不改数据）', async () => {
  const root = tmpVault()
  const w = await writeCard(root, { kind: 'knowledge', title: '批量归档', body: BODY, status: 'approved' })
  await withApi(root, async (base) => {
    const dry = await (await fetch(base + '/cards/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive', paths: [w.path] }),
    })).json()
    assert.equal(dry.dryRun, true, '默认预演')
    const mid = await listCards(root, { status: 'archived' })
    assert.equal(mid.length, 0, '预演不该改数据')

    const real = await (await fetch(base + '/cards/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive', paths: [w.path], dryRun: false }),
    })).json()
    assert.ok(real.done >= 1, '应真的归档')
    const after = await listCards(root, { status: 'archived' })
    assert.equal(after.length, 1, '归档列表应有 1 张')
  })
  await cleanup(root)
})

test('/search?includeArchived=1 走通 API', async () => {
  const root = tmpVault()
  const w = await writeCard(root, { kind: 'knowledge', title: 'API 归档', body: BODY, status: 'approved' })
  await setCardStatus(root, w.path, 'archived', { changedBy: 't', reason: '验证' })
  await withApi(root, async (base) => {
    const plain = await (await fetch(base + '/search?q=' + encodeURIComponent('Kubernetes'))).json()
    assert.equal(plain.hits.length, 0, '默认不返回归档')
    const withArch = await (await fetch(base + '/search?q=' + encodeURIComponent('Kubernetes') + '&includeArchived=1')).json()
    assert.equal(withArch.hits.length, 1, 'includeArchived=1 应返回')
    assert.equal(withArch.includeArchived, true)
  })
  await cleanup(root)
})
