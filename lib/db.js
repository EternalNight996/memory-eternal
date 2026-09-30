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

/**
 * 建表。
 *
 * 存储模型（v0.10「两套存储体系」）：
 *   cards       = **主库 / 正常区**：物理上只存 approved。召回、检索、图谱、去重、
 *                 导出这些读路径**不再需要写 `WHERE status='approved'`** —— 查主库即安全。
 *   quarantine  = **隔离区 / 异常区**：pending（待审）/ rejected（驳回）/ deleted（回收站）。
 *                 审核中心与回收站的唯一数据源；除审核操作外无人读它。
 *
 * 这样做的原因：v0.9 及以前是「一张表 + status 列」，安全性依赖每一处 SQL 都记得加
 * 状态条件。审计发现三处漏了（去重池把新知识追加进待审卡、readCard 直读未审核正文、
 * /card 接口无状态校验）—— 只要有人再漏一处就会重演。物理分表后，漏写 `WHERE` 也不泄漏。
 */
function initTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL DEFAULT 'knowledge',
      title TEXT NOT NULL DEFAULT '',
      tags TEXT DEFAULT '[]',
      body TEXT NOT NULL DEFAULT '',
      summary TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'approved',
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

    -- 隔离区：结构与主库一致，另加 quarantined_at（进隔离区的时间）与 quarantine_reason
    CREATE TABLE IF NOT EXISTS quarantine (
      id INTEGER PRIMARY KEY,
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
      deleted_at TEXT,
      quarantined_at TEXT DEFAULT (datetime('now')),
      quarantine_reason TEXT DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_quarantine_status ON quarantine(status);
    CREATE INDEX IF NOT EXISTS idx_quarantine_kind ON quarantine(kind);
    CREATE INDEX IF NOT EXISTS idx_quarantine_deleted ON quarantine(deleted_at);

    -- 更新记录：card_id 指向 cards.id **或** quarantine.id（两表共享 id 空间）。
    -- 因此这里**不能**建外键：SQLite 的外键只认一张父表，卡被搬进隔离区时 FK 校验会直接失败
    -- （实测 FOREIGN KEY constraint failed）。永久删除卡片时由 deleteCard 手工清理更新记录。
    CREATE TABLE IF NOT EXISTS card_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_card_updates_card ON card_updates(card_id);

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

    -- 卡片 id 发号器（两张表**共用**）。
    --
    -- 为什么不用 AUTOINCREMENT：cards 与 quarantine 是两张 AUTOINCREMENT 表，各有一份
    -- sqlite_sequence 计数器，且都从 1 开始 —— 于是两张表会同时出现 id=1，而卡需要在
    -- 两表间搬家并保留 id，必然撞 UNIQUE constraint failed。实测确认：
    -- 共享 id 空间 + 双 AUTOINCREMENT 在 SQLite 里无法自洽。
    -- 改为「显式发号 + 单一持久计数器」：id 全库唯一、单调递增、删除后也不复用，
    -- 而且任何一次 renumber 都是显式 error，不会静默串记录。
    CREATE TABLE IF NOT EXISTS card_sequence (
      name TEXT PRIMARY KEY,
      seq INTEGER NOT NULL
    );
  `)
  // 种子：取两表最大 id（老库升级时把已有卡都覆盖进去）；没有则从 0 起
  db.prepare(`INSERT INTO card_sequence (name, seq) VALUES ('card', 0) ON CONFLICT(name) DO NOTHING`).run()
  db.prepare(`UPDATE card_sequence SET seq = (
      SELECT MAX(m) FROM (SELECT MAX(id) m FROM cards UNION ALL SELECT MAX(id) FROM quarantine)
    ) WHERE name = 'card' AND seq < (
      SELECT MAX(m) FROM (SELECT MAX(id) m FROM cards UNION ALL SELECT MAX(id) FROM quarantine)
    )`).run()
  migrateToQuarantine(db)
}

/** 分配一个新的卡片 id（跨两张表唯一、单调递增）。 */
export function nextCardId(db) {
  db.prepare("UPDATE card_sequence SET seq = seq + 1 WHERE name = 'card'").run()
  const row = db.prepare("SELECT seq FROM card_sequence WHERE name = 'card'").get()
  if (!row) throw new Error('card_sequence 未初始化')
  return row.seq
}

/** 主库里的每一个 status 常量：只有它算「正常区」。 */
export const MAIN_STATUS = 'approved'
/** 隔离区里的三个 status 常量。 */
export const QUARANTINE_STATUSES = ['pending', 'rejected', 'deleted']
/** 状态 → 它应该待在哪张表。 */
export function tableForStatus(status) {
  return String(status) === MAIN_STATUS ? 'cards' : 'quarantine'
}

/**
 * 迁移到两套存储（幂等，可重复执行，每次 getDb 都会跑一遍）：
 * 把主库里所有非 approved 的行搬进隔离区，并带上它们的 card_updates。
 *
 * 关键性质：**绝不删除任何内容**，只换表。老版本代码回滚后看不到隔离区（审核队列会
 * 显示为空），但数据还在同一个 .db 文件里，升级回来即恢复。
 */
export function migrateToQuarantine(db) {
  let pending = []
  try {
    pending = db.prepare("SELECT id, path FROM cards WHERE status <> ?").all(MAIN_STATUS)
  } catch { return 0 }
  if (!pending.length) return 0

  // 老库的 card_updates 有指向 cards(id) 的外键：把卡搬走时 FK 会拒绝删除主库行。
  // 迁移期间**临时关掉外键校验**（SQLite 允许 PRAGMA foreign_keys 在无事务时切换），
  // 搬完立刻恢复 —— 之后建表/写入仍受外键保护。
  let fkWasOn = false
  try {
    fkWasOn = db.prepare('PRAGMA foreign_keys').get().foreign_keys === 1
    if (fkWasOn) db.exec('PRAGMA foreign_keys = OFF')
  } catch { fkWasOn = false }

  const insertQuarantine = db.prepare(`
    INSERT OR IGNORE INTO quarantine
      (id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at, quarantined_at, quarantine_reason)
    SELECT id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at, datetime('now'), '迁移：主库只保留 approved'
    FROM cards WHERE id = ?
  `)
  const dropFromMain = db.prepare('DELETE FROM cards WHERE id = ?')

  let moved = 0
  for (const row of pending) {
    try {
      db.exec('BEGIN')
      const info = insertQuarantine.run(row.id)
      // card_updates 按 card_id 关联，id 不变 → 更新记录跟着卡一起走，无需改写
      if (info.changes) moved++
      dropFromMain.run(row.id)
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
      process.stderr.write(`[memory-eternal] 隔离迁移失败（${row.path}）：${e?.message || e}\n`)
    }
  }
  if (fkWasOn) { try { db.exec('PRAGMA foreign_keys = ON') } catch { /* 恢复失败：下次 getDb 会再设一次 */ } }
  if (moved) process.stderr.write(`[memory-eternal] 已把 ${moved} 张未审核卡搬进隔离区（主库只留 approved）\n`)
  return moved
}

/**
 * 一致性不变量：主库只能有 approved。
 * 供测试与「用量/今日」体检使用 —— 正常永远是 0，非 0 说明有代码绕过写入闸门。
 */
export function checkMainStoreInvariant(root) {
  const db = getDb(root)
  try {
    const bad = db.prepare('SELECT status, COUNT(*) n FROM cards WHERE status <> ? GROUP BY status').all(MAIN_STATUS)
    const total = db.prepare('SELECT COUNT(*) n FROM cards').get().n
    const quarantined = db.prepare('SELECT status, COUNT(*) n FROM quarantine GROUP BY status').all()
    return { ok: bad.length === 0, violations: bad, mainTotal: total, quarantine: quarantined }
  } catch (e) {
    return { ok: false, violations: [], mainTotal: 0, quarantine: [], error: String(e?.message || e) }
  }
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

/** 关闭全部缓存连接（测试清理用：Windows 上开着连接删目录会 EBUSY）。 */
export function closeAllDb() {
  for (const db of instances.values()) { try { db.close() } catch {} }
  instances.clear()
}

/**
 * SQLite 备份：用 VACUUM INTO 创建紧凑副本。
 * 保留最近 maxKeep 个备份，自动清理旧的。
 */
export async function backupDb(root, { maxKeep = 7 } = {}) {
  const resolved = path.resolve(root)
  const dbPath = path.join(resolved, DB_FILE)
  const backupDir = path.join(resolved, 'backups')
  await fs.mkdir(backupDir, { recursive: true })
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  const backupPath = path.join(backupDir, `memory-eternal-${date}_${time}.db`)
  try {
    const db = getDb(root)
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)
    // 清理旧备份：保留最近 maxKeep 个
    const files = await fs.readdir(backupDir)
    const dbBackups = files.filter(f => f.startsWith('memory-eternal-') && f.endsWith('.db')).sort().reverse()
    for (const old of dbBackups.slice(maxKeep)) {
      try { await fs.unlink(path.join(backupDir, old)) } catch {}
    }
    return { ok: true, path: backupPath, kept: Math.min(dbBackups.length, maxKeep) }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}
