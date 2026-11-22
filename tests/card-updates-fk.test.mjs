// card_updates 遗留外键迁移（2026-11-23 实测：清理带更新记录的卡报 FOREIGN KEY constraint failed）。
//
// 设计契约：两张卡表共享 id 空间，card_updates 不建外键 —— 卡搬进隔离区时
// card_id 要改绑成隔离区的新 id，而外键只认 cards 一张父表。
// 老库（早期 schema）里留着这个外键，必须打开库时自动重建表，且**不能丢数据**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDb, closeDb, migrateDropCardUpdatesFk } from '../lib/db.js'

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'me-caufk-'))
}

function cleanup(root) {
  try { closeDb(root) } catch { /* 忽略 */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

/** 把 card_updates 重建回「带外键」的老形态，模拟历史库。 */
function makeLegacyFk(db) {
  db.exec('DROP TABLE IF EXISTS card_updates')
  db.exec(`CREATE TABLE card_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
}

test('新库没有外键：迁移是空操作（幂等）', () => {
  const root = tmpVault()
  const db = getDb(root)
  assert.equal(db.prepare('PRAGMA foreign_key_list(card_updates)').all().length, 0)
  assert.equal(migrateDropCardUpdatesFk(db), false, '没有外键时返回 false，不重建')
  cleanup(root)
})

test('老库带外键：打开时自动重建表，数据与索引都保留', () => {
  const root = tmpVault()
  const db = getDb(root)
  makeLegacyFk(db)
  db.prepare("INSERT INTO cards (id, path, kind, title, body) VALUES (1, 'a.md', 'knowledge', 'A', '正文足够长的测试卡片内容')").run()
  db.prepare("INSERT INTO card_updates (card_id, content, created_at) VALUES (1, '一条更新记录', '2026-01-01 00:00:00')").run()
  assert.ok(db.prepare('PRAGMA foreign_key_list(card_updates)').all().length > 0, '前置：确实带上了外键')
  closeDb(root)

  const db2 = getDb(root)  // 打开即迁移
  assert.equal(db2.prepare('PRAGMA foreign_key_list(card_updates)').all().length, 0, '外键必须被移除')
  const row = db2.prepare('SELECT card_id, content FROM card_updates').get()
  assert.equal(row.card_id, 1)
  assert.equal(row.content, '一条更新记录', '更新记录不能丢')
  const idx = db2.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_card_updates_card'").get()
  assert.ok(idx, '索引要重建')
  cleanup(root)
})

test('迁移后：带更新记录的卡可以真的搬进隔离区（原故障场景）', async () => {
  const root = tmpVault()
  const db0 = getDb(root)
  makeLegacyFk(db0)
  closeDb(root)
  const db = getDb(root)   // 重新打开 → 迁移生效
  assert.equal(db.prepare('PRAGMA foreign_key_list(card_updates)').all().length, 0, '前置：外键已移除')
  const { writeCard, deleteCard, closeAllDb } = await import('../lib/vault.js')
  const w = await writeCard(root, { kind: 'knowledge', title: '带更新记录的卡', body: '正文足够长，用于验证搬进隔离区不会触发外键错误。', status: 'approved' })
  assert.equal(w.ok, true, JSON.stringify(w))
  const row = db.prepare('SELECT id FROM cards WHERE path = ?').get(w.path)
  assert.ok(row, '卡片应写入主库')
  db.prepare("INSERT INTO card_updates (card_id, content) VALUES (?, '历史更新')").run(row.id)
  try {
    const r = await deleteCard(root, w.path)
    assert.equal(r.ok, true, JSON.stringify(r))
    const q = db.prepare('SELECT status FROM quarantine WHERE path = ?').get(w.path)
    assert.equal(q && q.status, 'deleted', '应软删进回收站')
    assert.equal(db.prepare('SELECT COUNT(*) n FROM card_updates WHERE content = ?').get('历史更新').n, 1, '更新记录随卡迁移，不能丢')
  } finally {
    try { closeAllDb() } catch { /* 忽略 */ }
    cleanup(root)
  }
})
