// 召回计数与「从未被召回的僵尸卡」判定。
//
// 为什么需要这个能力：判断垃圾时时间只是弱信号 —— 三年前的架构卡可能每周被召回，
// 三天前生成的废话卡一次都没用过。`recall_count == 0` 才是硬证据。
//
// 守六件事：
//   ① bumpRecall 只记内存（不写库），攒够才 flush；
//   ② flush 批量写进两张表（审核流转会搬表，path 不变）；
//   ③ search() 命中后自动计数（覆盖 MCP 与 Web 两条召回路径）；
//   ④ neverRecalled 规则要求「创建够久」+「0 次召回」；
//   ⑤ 有召回历史的老卡不该被判僵尸；
//   ⑥ 计数不影响召回结果本身（失败也不能让搜索挂掉）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { search, writeCard } from '../lib/vault.js'
import { bumpRecall, flushRecall, resetRecallState, flushAllRecall, FLUSH_THRESHOLD } from '../lib/recall-track.js'
import { getDb, closeDb } from '../lib/db.js'
import { scanJunk, NEVER_RECALLED_DAYS } from '../lib/junk.js'
import { contentHash } from '../lib/card-hash.js'

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'me-recall-'))
}

async function cleanup(root) {
  resetRecallState(root)
  try { closeDb(root) } catch { /* 忽略 */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

/** 直接插卡（绕过审核闸门，专注测计数与判定）。 */
function seed(root, rows) {
  const db = getDb(root)
  const ins = db.prepare(`
    INSERT INTO cards (id, path, kind, title, tags, body, summary, status, source, created_at, updated_at, content_hash, recall_count)
    VALUES (?, ?, 'knowledge', ?, '[]', ?, '', 'approved', '', ?, ?, ?, ?)
  `)
  rows.forEach((r, i) => ins.run(i + 1, r.path, r.title, r.body, r.created || '2026-11-01 00:00:00', r.updated || r.created || '2026-11-01 00:00:00', contentHash(r.title, r.body), r.recall || 0))
  return db
}

test('迁移：cards 与 quarantine 都有 recall_count / last_recalled_at', async () => {
  const root = tmpVault()
  const db = getDb(root)
  for (const t of ['cards', 'quarantine']) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
    assert.ok(cols.includes('recall_count'), t + ' 缺 recall_count')
    assert.ok(cols.includes('last_recalled_at'), t + ' 缺 last_recalled_at')
  }
  await cleanup(root)
})

test('bumpRecall 只记内存，flushRecall 才写库', async () => {
  const root = tmpVault()
  const db = seed(root, [{ path: 'a.md', title: 'A', body: '正文 A，长度足够用于测试。' }])
  bumpRecall(root, 'a.md')
  bumpRecall(root, 'a.md')
  // 还没 flush → 库里仍是 0
  assert.equal(db.prepare('SELECT recall_count n FROM cards WHERE path = ?').get('a.md').n, 0, 'bump 不该立刻写库')
  const r = flushRecall(root)
  assert.ok(r.flushed >= 1, 'flush 应写入')
  const row = db.prepare('SELECT recall_count n, last_recalled_at t FROM cards WHERE path = ?').get('a.md')
  assert.equal(row.n, 2, '两次 bump 应累计为 2')
  assert.ok(row.t, 'last_recalled_at 应有值')
  await cleanup(root)
})

test('flush 能写进隔离区的卡（审核流转搬表后 path 不变）', async () => {
  const root = tmpVault()
  const db = getDb(root)
  db.prepare(`
    INSERT INTO quarantine (id, path, kind, title, tags, body, summary, status, source, created_at, updated_at, quarantined_at, quarantine_reason, content_hash, recall_count)
    VALUES (1, 'q.md', 'knowledge', 'Q', '[]', '隔离区正文，长度足够用于测试。', '', 'pending', '', '2026-11-01 00:00:00', '2026-11-01 00:00:00', datetime('now'), '待审', ?, 0)
  `).run(contentHash('Q', '隔离区正文，长度足够用于测试。'))
  bumpRecall(root, 'q.md', 3)
  flushRecall(root)
  assert.equal(db.prepare('SELECT recall_count n FROM quarantine WHERE path = ?').get('q.md').n, 3)
  await cleanup(root)
})

test('达到 FLUSH_THRESHOLD 会立刻自动刷写', async () => {
  const root = tmpVault()
  const db = seed(root, Array.from({ length: FLUSH_THRESHOLD + 5 }, (_, i) => ({
    path: `p${i}.md`, title: `P${i}`, body: `第 ${i} 张的正文，长度足够用于测试批量刷写。`,
  })))
  const paths = Array.from({ length: FLUSH_THRESHOLD }, (_, i) => `p${i}.md`)
  bumpRecall(root, paths) // 一次塞满阈值
  const counted = db.prepare('SELECT COUNT(*) n FROM cards WHERE recall_count > 0').get().n
  assert.ok(counted >= FLUSH_THRESHOLD - 1, `攒满阈值应自动刷写，实际只写了 ${counted} 条`)
  await cleanup(root)
})

test('search() 命中后自动计数，未命中的卡不计', async () => {
  const root = tmpVault()
  await writeCard(root, { kind: 'knowledge', title: 'Redis 持久化', body: 'Redis 的 AOF 与 RDB 持久化取舍说明，内容长度足够。', status: 'approved' })
  await writeCard(root, { kind: 'knowledge', title: '完全无关', body: '这张卡讲的是别的事情，与缓存无关，用于对照测试。', status: 'approved' })

  const hits = await search(root, 'Redis 持久化')
  assert.ok(hits.length >= 1, '应搜到 Redis 那张')
  flushRecall(root)

  const db = getDb(root)
  const rows = db.prepare('SELECT path, recall_count FROM cards').all()
  const redis = rows.find((r) => /redis/.test(r.path))
  const other = rows.find((r) => !/redis/.test(r.path))
  assert.ok(redis.recall_count >= 1, '被召回的那张应计数，实际 ' + redis.recall_count)
  assert.equal(other.recall_count, 0, '没被命中的卡不该计数')
  await cleanup(root)
})

test('neverRecalled：只有「够老 + 0 次召回」才算僵尸', async () => {
  const root = tmpVault()
  const old = '2026-08-01 00:00:00' // 距今 > 90 天
  const fresh = new Date().toISOString()
  seed(root, [
    { path: 'old-never.md', title: '老卡从未召回', body: '这是一张很老且从未被召回过的卡，内容长度足够。', created: old, updated: old, recall: 0 },
    { path: 'old-used.md', title: '老卡经常召回', body: '这是一张很老但经常被召回过的卡，内容长度足够。', created: old, updated: old, recall: 12 },
    { path: 'new-never.md', title: '新卡还没机会', body: '这是一张新卡，还没机会被召回，内容长度足够。', created: fresh, updated: fresh, recall: 0 },
  ])
  const r = scanJunk(root, { neverRecalledDays: NEVER_RECALLED_DAYS, staleDays: 3650 })
  const never = r.candidates.filter((c) => c.reason === 'neverRecalled')
  assert.equal(never.length, 1, '只该有 1 张，实际 ' + never.map((c) => c.title).join(','))
  assert.equal(never[0].title, '老卡从未召回')
  assert.match(String(never[0].detail), /从未被召回/)
  assert.equal(r.summary.neverRecalled, 1)
  await cleanup(root)
})

test('召回一次后就不再是僵尸候选', async () => {
  const root = tmpVault()
  const old = '2026-08-01 00:00:00'
  seed(root, [{ path: 'z.md', title: '僵尸候选', body: '这张卡原本从未被召回，长度足够用于测试。', created: old, updated: old, recall: 0 }])
  assert.equal(scanJunk(root, { neverRecalledDays: 90, staleDays: 3650 }).candidates.filter((c) => c.reason === 'neverRecalled').length, 1)
  bumpRecall(root, 'z.md')
  flushRecall(root)
  assert.equal(scanJunk(root, { neverRecalledDays: 90, staleDays: 3650 }).candidates.filter((c) => c.reason === 'neverRecalled').length, 0, '召回后不该再判僵尸')
  await cleanup(root)
})

test('flushAllRecall 能把所有库的待刷计数写下去', async () => {
  const a = tmpVault()
  const b = tmpVault()
  seed(a, [{ path: 'x.md', title: 'XA', body: '库 A 的卡，长度足够用于测试。' }])
  seed(b, [{ path: 'y.md', title: 'YB', body: '库 B 的卡，长度足够用于测试。' }])
  bumpRecall(a, 'x.md')
  bumpRecall(b, 'y.md')
  flushAllRecall()
  assert.equal(getDb(a).prepare('SELECT recall_count n FROM cards WHERE path = ?').get('x.md').n, 1)
  assert.equal(getDb(b).prepare('SELECT recall_count n FROM cards WHERE path = ?').get('y.md').n, 1)
  await cleanup(a)
  await cleanup(b)
})
