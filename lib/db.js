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

    -- 审核日志：记录所有 status 变更，不可篡改
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_path TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT NOT NULL,
      changed_by TEXT DEFAULT 'system',
      reason TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
}

/**
 * 审核守卫：根据 config 表的审核规则决定新卡 status。
 * 所有写入路径必须经过此函数，杜绝越权。
 *
 * 规则：
 * - config 表无 auditMode 记录 → 用 fallback（调用方传入的 status）
 * - auditMode = 'none' → approved（全部免审）
 * - auditMode = 'all' → 检查免审白名单，命中→approved，否则→pending
 *
 * @param {string} root - vault 根目录
 * @param {string} kind - 卡片类型
 * @param {string} submittedBy - 提交者
 * @param {string} fallback - 调用方传入的 status（无配置时使用）
 * @returns {'pending' | 'approved'}
 */
export function enforceAudit(root, kind, submittedBy, fallback = 'pending') {
  const db = getDb(root)
  const get = (key) => { try { return db.prepare('SELECT value FROM config WHERE key = ?').get(key)?.value } catch { return null } }
  const mode = get('auditMode')
  // 无配置 → 用调用方传入的 status
  if (!mode) return fallback
  if (mode === 'none') return 'approved'
  const agentsRaw = get('auditExemptAgents') || '[]'
  const kindsRaw = get('auditExemptKinds') || '[]'
  let agents = [], kinds = []
  try { agents = JSON.parse(agentsRaw) } catch { agents = agentsRaw.split(',').map(s => s.trim()).filter(Boolean) }
  try { kinds = JSON.parse(kindsRaw) } catch { kinds = kindsRaw.split(',').map(s => s.trim()).filter(Boolean) }
  if (agents.includes('__all__') || agents.includes(submittedBy)) return 'approved'
  if (kinds.includes('__all__') || kinds.includes(kind)) return 'approved'
  return 'pending'
}

/** 写入审核配置到 config 表（供 index.js 同步 DSH settings）。 */
export function setAuditConfig(root, { auditMode, auditExemptAgents, auditExemptKinds }) {
  const db = getDb(root)
  const upsert = db.prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
  if (auditMode !== undefined) upsert.run('auditMode', String(auditMode))
  if (auditExemptAgents !== undefined) upsert.run('auditExemptAgents', JSON.stringify(auditExemptAgents))
  if (auditExemptKinds !== undefined) upsert.run('auditExemptKinds', JSON.stringify(auditExemptKinds))
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
