// 记忆核心 · SQLite 存储层（node:sqlite 内置，零依赖）
//
// 4 张表：config / cards / card_updates / feedback
// 首次启动自动从 .md 文件迁移（幂等）

import { DatabaseSync } from 'node:sqlite'
import { promises as fs, mkdirSync, existsSync, renameSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { parseCard, KIND_ROOTS } from './vault.js'

const DB_FILE = 'memory-eternal.db'

/**
 * 每个库的「打开时健康检查」结果（issue #33）。
 *
 * 为什么需要：老实现打开后只执行 `PRAGMA journal_mode=WAL` 就往下走 —— 而这条 PRAGMA
 * **失败时不抛错**（只是把实际模式当一行返回），文件/目录不可写时也不会当场抱怨；于是插件
 * 会以「写不进去」的状态一路静默运行：探针仍报健康、看门狗仍在保活、面板只是统计空掉，
 * 用户看到的是一句没有上下文的 `attempt to write a readonly database`（有时还伴随看门狗误判）。
 * 现在打开时**读回真实 journal 模式 + 真写一次探针**，把结论记在这里，由 /overview 与
 * `dsh-memory doctor` 如实报出来。
 */
const healthByRoot = new Map()

const CORRUPT_RE = /malformed|not a database|corrupt|disk image/i

/** 真的写一次主库（建探针表→删掉）：验证「这个库现在能不能写」。temp 库不算，必须是主库。 */
function probeWrite(db) {
  try {
    db.exec('CREATE TABLE IF NOT EXISTS _me_write_probe(x INTEGER)')
    db.exec('DROP TABLE IF EXISTS _me_write_probe')
    return { writable: true, error: '' }
  } catch (e) {
    return { writable: false, error: String((e && e.message) || e) }
  }
}

/**
 * 打开后的健康检查：真实的 journal 模式 + 写探针（+ 损坏判定）。
 * @returns {{journalMode:string, writable:boolean, error:string, corrupt:boolean, checkedAt:number}}
 */
export function checkDbHealth(db) {
  const out = { journalMode: '', writable: false, error: '', corrupt: false, checkedAt: Date.now() }
  try {
    out.journalMode = String(db.prepare('PRAGMA journal_mode').get().journal_mode || '')
  } catch (e) {
    out.error = String((e && e.message) || e)
  }
  const w = probeWrite(db)
  out.writable = w.writable
  if (!w.writable) out.error = out.error || w.error
  out.corrupt = CORRUPT_RE.test(out.error || '')
  return out
}

/** 这个错误是不是「库被别人锁着」（SQLite 的 BUSY / locked），而不是数据或语法问题。 */
export function isDbBusyError(e) {
  const m = String((e && e.message) || e)
  return /database is locked|database table is locked|SQLITE_BUSY/i.test(m)
}

/**
 * 撞锁时**在应用层异步重试**（issue #31/#33 的实测补充）。
 *
 * 为什么不用 `PRAGMA busy_timeout`：`node:sqlite` 的 `DatabaseSync` 是**同步 API**，
 * 忙等会阻塞宿主的事件循环（整个 DSH 卡住）—— 评审后**故意没做**。这里改成：失败 → 让出事件循环
 * 睡一小会儿 → 再试，最多几次。SQLite 在 BUSY 时不会留下半成品（事务回滚），所以重试是安全的；
 * 实测现场：外部进程持写事务时我方立刻拿到 `database is locked`，且对方被强杀后**仍然锁着** ——
 * 这种瞬时锁正好由短退避重试化解。
 *
 * @param {() => Promise<any>} fn
 * @param {{tries?:number, delayMs?:number}} opts
 */
export async function withDbRetry(fn, { tries = 3, delayMs = 120 } = {}) {
  const n = Math.max(1, Number(tries) || 3)
  let last
  for (let i = 0; i < n; i++) {
    try { return await fn() } catch (e) {
      last = e
      if (e && e.noRetry) throw e                       // 调用方显式禁止重试（例如响应已发出）
      if (!isDbBusyError(e) || i === n - 1) throw e
      await new Promise((r) => setTimeout(r, (Number(delayMs) || 120) * (i + 1)))   // 线性退避，异步让出
    }
  }
  throw last
}

/** 某个库最近一次打开时的健康结论（没打开过返回 null）。 */
export function dbStatus(root) {
  return healthByRoot.get(path.resolve(root)) || null
}

/** 损坏 / 不可写时给人看的下一步（引导，不自动动数据）。 */
export function rebuildGuidance(root, status) {
  const dir = path.resolve(root)
  const lines = []
  if (status && status.corrupt) {
    lines.push('数据库文件疑似损坏：' + status.error)
    lines.push('修复方式（不会自动删你的数据）：')
    lines.push('1) 先停下会写它的进程（退出 DSH / `dsh-memory stop --port 7999`），免得边恢复边写；')
    lines.push('2) 备份现场：把 ' + path.join(dir, DB_FILE) + '（连同 -wal / -shm）复制到别处留证；')
    lines.push('3) 查看可用备份：`dsh-memory doctor --vault "' + dir + '"`；')
    lines.push('4) 用备份替换（备份文件在 ' + path.join(dir, 'backups') + '）：把选中的 .db 复制成 ' + DB_FILE + '，并删掉同名 -wal / -shm；')
    lines.push('5) 重开 DSH，然后用 `dsh-memory doctor` 复核 writable=true。')
  } else if (status && !status.writable) {
    lines.push('数据库当前**不可写**：' + status.error)
    lines.push('配置仍可保存（配置不经过数据库），但卡片读写/审核/图谱会失败。')
    lines.push('排查方向：目录与文件的 ACL（' + dir + '）、盘符是否只读挂载、是否有别的进程以独占方式打开它。')
    lines.push('确认方式：`dsh-memory doctor --vault "' + dir + '"`。')
  }
  return lines
}

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
  // 打开即体检：WAL 到底生效没有、这个库现在能不能写（#33）。结论供 /overview 与 doctor 使用。
  const health = checkDbHealth(db)
  healthByRoot.set(resolved, health)
  if (!health.writable || (health.journalMode && health.journalMode !== 'wal')) {
    for (const line of rebuildGuidance(resolved, health)) console.error('[memory-eternal] ' + line)
  }
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

    -- 记忆账本：召回注入 / 蒸馏调用的开销流水（回答「到底省不省 token」）
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      session TEXT DEFAULT '',
      results INTEGER DEFAULT 0,
      chars INTEGER DEFAULT 0,
      chars_in INTEGER DEFAULT 0,
      llm_calls INTEGER DEFAULT 0,
      provider TEXT DEFAULT '',
      model TEXT DEFAULT '',
      ms INTEGER DEFAULT 0,
      ok INTEGER DEFAULT 1,
      note TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_ts ON ledger(ts);
    CREATE INDEX IF NOT EXISTS idx_ledger_kind ON ledger(kind);

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
  // 核心记忆必须人工审核：无论 auditMode / 免审名单如何配置，写入时一律待审。
  if (String(kind) === 'core') return 'pending'
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
/**
 * 拿只读连接**当场**检查一个 .db 文件是否可用（quick_check），并尽可能数出卡片数。
 * 为什么不复用 dbStatus()：那是**缓存**的打开时结论，文件可能在那之后被写坏/替换 ——
 * 恢复流程必须看**此刻**的真相。
 * @returns {{ok:boolean, cards:number, error:string}}
 */
export function probeDbFile(file) {
  let probe = null
  try {
    probe = new DatabaseSync(file, { readOnly: true })
    const row = probe.prepare('PRAGMA quick_check').get()
    const verdict = String((row && (row.quick_check || Object.values(row)[0])) || '')
    if (verdict.toLowerCase() !== 'ok') return { ok: false, cards: -1, error: 'quick_check 未通过：' + verdict }
    let cards = -1
    try { cards = Number(probe.prepare('SELECT count(*) AS n FROM cards').get().n) } catch { cards = -1 }
    return { ok: true, cards, error: '' }
  } catch (e) {
    return { ok: false, cards: -1, error: String((e && e.message) || e) }
  } finally {
    try { probe && probe.close() } catch { /* 忽略 */ }
  }
}

/**
 * 从备份恢复数据库（issue #31 的现实出路：WAL 头一旦损坏，代码修不了**数据**，只能用备份重建）。
 *
 * 硬约束 —— **宁可拒绝，也不破坏现场**：
 *   1. **不删任何东西**：当前库连同 -wal/-shm 一律改名成 `*.corrupt-<时间戳>` 留证；
 *   2. 替换前先**校验备份真的可用**（能打开 + `PRAGMA quick_check` 通过 + 能数出卡片）；
 *   3. 拒绝「拿正在使用的库当备份」（自己替换自己）；
 *   4. 当前库**明明可写**时需要显式 `force`（防止手滑覆盖好数据）；
 *   5. 恢复后**复核**（重新打开 + 写探针 + 卡片数），结果如实返回。
 *
 * @param {string} root vault 目录
 * @param {{from?:string, force?:boolean, dryRun?:boolean}} opts from：'latest' | 备份文件名 | 绝对路径
 */
export async function restoreFromBackup(root, { from = '', force = false, dryRun = false } = {}) {
  const dir = path.resolve(root)
  const dbPath = path.join(dir, DB_FILE)
  const backupsDir = path.join(dir, 'backups')
  let src = String(from || '').trim()
  if (!src) return { ok: false, error: '缺少备份来源（--restore latest 或 --restore <备份文件名>' + '）' }
  if (src === 'latest') {
    const files = (await fs.readdir(backupsDir).catch(() => []))
      .filter((f) => f.startsWith('memory-eternal-') && f.endsWith('.db')).sort().reverse()
    if (!files.length) return { ok: false, error: '没有可用备份：' + backupsDir }
    src = path.join(backupsDir, files[0])
  } else if (!src.includes('/') && !src.includes('\\')) {
    src = path.join(backupsDir, src)
  }
  src = path.resolve(src)
  if (src === path.resolve(dbPath)) return { ok: false, error: '备份文件不能是正在使用的库本身' }
  let st
  try { st = await fs.stat(src) } catch { return { ok: false, error: '备份文件不存在：' + src } }
  if (!st.isFile()) return { ok: false, error: '不是文件：' + src }

  // ② 校验备份可用（只读连接 + quick_check + 卡片数）
  const backup = probeDbFile(src)
  if (!backup.ok) return { ok: false, error: '备份不可用（' + src + '）：' + backup.error }
  const cards = backup.cards

  // ④ 当前库**此刻**仍然健康时要求显式 force（手滑保护）—— 用当场探测，别信缓存
  const curNow = existsSync(dbPath) ? probeDbFile(dbPath) : { ok: false }
  if (curNow.ok && !force) {
    return { ok: false, code: 'DB_HEALTHY', error: '当前库此刻是完好的（quick_check 通过），恢复会覆盖它 —— 确认要恢复请加 --force', cards }
  }
  if (dryRun) return { ok: true, dryRun: true, from: src, cards, note: '仅演练：未改任何文件' }

  // ① 先关掉本进程里这个库的连接（Windows 上不关会改名失败）
  try { closeDb(dir) } catch { /* 忽略 */ }
  // ② 现场留证：库 + -wal + -shm 全部改名（**不删**）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const movedAside = []
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix
    if (!existsSync(f)) continue
    const to = f + '.corrupt-' + stamp
    try { renameSync(f, to); movedAside.push(to) } catch (e) {
      return { ok: false, error: '现场留证失败（' + f + '）：' + String((e && e.message) || e) + '（未做任何替换）', movedAside }
    }
  }
  // ③ 备份 → 库
  try { copyFileSync(src, dbPath) } catch (e) {
    return { ok: false, error: '写入新库失败：' + String((e && e.message) || e), movedAside }
  }
  // ⑤ 复核
  try {
    const db = getDb(dir)
    const health = checkDbHealth(db)
    const n = Number(db.prepare('SELECT count(*) AS n FROM cards').get().n)
    return {
      ok: Boolean(health.writable),
      from: src,
      cards: n,
      backupCards: cards,
      health,
      movedAside,
      note: health.writable
        ? '已用备份重建；原现场已改名留证（可人工检查后再删）'
        : '已替换文件，但写探针仍失败：请贴 doctor 输出',
    }
  } catch (e) {
    return { ok: false, error: '复核失败：' + String((e && e.message) || e), movedAside, from: src }
  }
}

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
