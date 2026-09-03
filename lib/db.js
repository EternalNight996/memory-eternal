// 记忆核心 · SQLite 存储层（node:sqlite 内置，零依赖）
//
// 4 张表：config / cards / card_updates / feedback
// 首次启动自动从 .md 文件迁移（幂等）

import { DatabaseSync } from 'node:sqlite'
import { promises as fs, mkdirSync } from 'node:fs'
import path from 'node:path'
import { parseCard, KIND_ROOTS } from './vault.js'

const DB_FILE = 'memory-eternal.db'

/** 获取或创建 SQLite 数据库连接（单例 per root）。 */
const instances = new Map()
export function getDb(root) {
  const resolved = path.resolve(root)
  if (instances.has(resolved)) return instances.get(resolved)
  // 确保目录存在（SQLite 需要目录才能创建 .db 文件）
  mkdirSync(resolved, { recursive: true })
  const dbPath = path.join(resolved, DB_FILE)
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=ON')
  initTables(db)
  instances.set(resolved, db)
  return db
}

function initTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL DEFAULT 'knowledge',
      title TEXT NOT NULL DEFAULT '',
      tags TEXT DEFAULT '[]',
      body TEXT NOT NULL DEFAULT '',
      summary TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT DEFAULT '',
      submitted_by TEXT DEFAULT '',
      severity TEXT DEFAULT 'info',
      reason TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      deleted_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
    CREATE INDEX IF NOT EXISTS idx_cards_kind ON cards(kind);
    CREATE INDEX IF NOT EXISTS idx_cards_deleted ON cards(deleted_at);

    CREATE TABLE IF NOT EXISTS card_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      card_path TEXT NOT NULL,
      useful INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
}

/** 从 .md 文件迁移到 SQLite（幂等：已存在的卡跳过）。 */
export async function migrateFromMarkdown(root) {
  const db = getDb(root)
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM cards').get()
  if (existing.cnt > 0) return { migrated: 0, skipped: existing.cnt }

  let migrated = 0
  const walk = async (dir, base) => {
    let ents = []
    try { ents = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const ent of ents) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) { await walk(full, base); continue }
      if (!ent.name.endsWith('.md')) continue
      try {
        const text = await fs.readFile(full, 'utf8')
        const { meta, body, summary } = parseCard(text)
        const rel = path.relative(base, full).split(path.sep).join('/')
        const stat = await fs.stat(full)
        db.prepare(`
          INSERT OR IGNORE INTO cards (path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          rel,
          meta.kind || 'knowledge',
          meta.title || rel.replace(/\.[^.]*$/, '').replace(/^[^/]*\//, ''),
          JSON.stringify(meta.tags || []),
          body.trim(),
          summary,
          meta.status || 'pending',
          meta.source || '',
          meta.submittedBy || '',
          meta.severity || 'info',
          meta.reason || '',
          meta.created || stat.mtime.toISOString(),
          meta.updated || stat.mtime.toISOString(),
          meta.deletedAt || null,
        )
        migrated++
      } catch { /* 跳过坏文件 */ }
    }
  }
  await walk(root, root)
  return { migrated, skipped: 0 }
}

export function closeDb(root) {
  const resolved = path.resolve(root)
  const db = instances.get(resolved)
  if (db) { db.close(); instances.delete(resolved) }
}
