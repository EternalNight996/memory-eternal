// 记忆核心 · SQLite 存储层（node:sqlite 内置，零依赖）
//
// 4 张表：config / cards / card_updates / feedback
// 首次启动自动从 .md 文件迁移（幂等）

import { DatabaseSync } from 'node:sqlite'
import { promises as fs, mkdirSync, existsSync, renameSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import path from 'node:path'
import { parseCard, KIND_ROOTS } from './vault.js'
import { contentHash } from './card-hash.js'

/** 主库文件名（auto-restore / 备份工具都要拼它，别各自写死字符串）。 */
export const DB_FILE = 'memory-eternal.db'

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

/**
 * 带退避重试的改名（**异步版**：每次重试之间让出事件循环）。
 *
 * 为什么需要：win32 上 rename 在源文件被任何进程短暂打开时返回 EBUSY/EPERM —— 杀软扫描、
 * 搜索索引、以及我们自己几毫秒前刚打开过的 SQLite 连接（close 的完成还没落地）都算。
 * 留证改名一旦失败，整次恢复就被拒绝（"未做任何替换"），用户在最需要救命的时候被一个
 * 瞬时占用挡住。**根治**在"不要留句柄"（见 getDb 的失败放帧、probeDbFile 的文件头预检），
 * 这里只兜住外部进程造成的瞬时占用：给一段有限的退避窗口。
 *
 * 为什么重试之间要 await 而不是同步 sleep：恢复流程是异步的，同步阻塞（Atomics.wait）
 * 会把事件循环按住几百毫秒 —— 队列里正在收尾的文件操作回调全被推迟，等于自己制造占用。
 */
async function renameWithRetry(from, to, { retries = 15, delayMs = 200 } = {}) {
  for (let i = 0; ; i++) {
    try { renameSync(from, to); return }
    catch (e) {
      const code = e && e.code
      const retriable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
      if (!retriable || i >= retries) throw e
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
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
  let db = null
  try {
    db = new DatabaseSync(dbPath)
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
  } catch (e) {
    // 打开失败（文件是垃圾 / WAL 头坏了）**必须把帧放掉**：win32 上留着这个句柄，
    // 后面「现场留证」的整文件改名会一直 EBUSY，把本来能救回来的恢复挡在门外。
    try { if (db) db.close() } catch { /* 已经坏了就算了 */ }
    throw e
  }
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

    -- 审核制修改：待审副本 → 原卡。agent 只能提交副本，通过后由 setCardStatus 覆盖原卡。
    -- 单独建表（而不是给两张卡表加列）：旧库打开时 CREATE TABLE IF NOT EXISTS 即可补上，无需迁移。
    CREATE TABLE IF NOT EXISTS card_revisions (
      revision_path TEXT PRIMARY KEY,
      target_path TEXT NOT NULL,
      target_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_card_revisions_target ON card_revisions(target_path);

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
  migrateAddContentHash(db)
  migrateAddRecallCount(db)
}

/**
 * 加召回计数列（幂等）：`recall_count` + `last_recalled_at`。
 *
 * 为什么这两列是垃圾判定的关键：时间只是弱信号 —— 三年前的架构卡可能每周被召回，
 * 三天前生成的废话卡一次都没用过。`recall_count == 0` 才是真正的僵尸判据。
 *
 * 不回填历史：回填只能瞎猜（老数据没有召回记录）。全留 0 反而**语义正确**：
 * "加这列之前从没记录过"，扫描规则里用 created_at 区分「新卡还没机会被召回」
 * 与「老卡真的从来没用过」。
 */
export function migrateAddRecallCount(db) {
  for (const t of ['cards', 'quarantine']) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
      if (!cols.includes('recall_count')) db.exec(`ALTER TABLE ${t} ADD COLUMN recall_count INTEGER DEFAULT 0`)
      if (!cols.includes('last_recalled_at')) db.exec(`ALTER TABLE ${t} ADD COLUMN last_recalled_at TEXT`)
    } catch { /* 表还不存在就算了，下次 getDb 再来 */ }
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_cards_recall ON cards(recall_count)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_quarantine_recall ON quarantine(recall_count)')
  } catch { /* 同上 */ }
}

/**
 * 加 `content_hash` 列 + 索引，并回填已有行（幂等，每次 getDb 都会跑）。
 *
 * 为什么用列而不是另建一张表：去重要跟卡的生命周期同生共死（删卡时索引项也该消失），
 * 同一张表里加列最不容易出现「哈希表与卡不一致」的孤儿数据。
 *
 * 回填是分批的（每批 500），避免老库几万条时一次 UPDATE 把事件循环堵死。
 */
export function migrateAddContentHash(db) {
  for (const t of ['cards', 'quarantine']) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name)
      if (!cols.includes('content_hash')) db.exec(`ALTER TABLE ${t} ADD COLUMN content_hash TEXT`)
    } catch { /* 表还不存在就算了，下一次 getDb 再来 */ }
  }
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_cards_hash ON cards(content_hash)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_quarantine_hash ON quarantine(content_hash)')
  } catch { /* 同上 */ }

  // 回填：只处理还没有 hash 的行
  for (const t of ['cards', 'quarantine']) {
    try {
      let guard = 0
      for (;;) {
        if (++guard > 200) break // 十万条以内最多 200 批，防止异常情况下死循环
        const rows = db.prepare(`SELECT id, title, body FROM ${t} WHERE content_hash IS NULL OR content_hash = '' LIMIT 500`).all()
        if (!rows.length) break
        const upd = db.prepare(`UPDATE ${t} SET content_hash = ? WHERE id = ?`)
        db.exec('BEGIN')
        try {
          for (const r of rows) upd.run(contentHash(r.title, r.body), r.id)
          db.exec('COMMIT')
        } catch (e) {
          try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
          throw e
        }
      }
    } catch { /* 回填失败不影响主流程，下次再试 */ }
  }
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
/**
 * 归档状态：**不进主库检索，但数据完整保留**。
 *
 * 为什么需要它：垃圾清理时"从未被召回/陈旧"只是弱证据，直接删风险太高。
 * 归档等于「先藏起来」——搜索默认看不到，需要时能翻出来、能恢复。
 * 物理上它住在 quarantine 表（复用已有的两套存储隔离），所以主库检索天然看不到它，
 * 不会重演「忘了加 WHERE 就泄漏」那类问题。
 */
export const ARCHIVE_STATUS = 'archived'
/** 隔离区里的状态常量（含归档）。 */
export const QUARANTINE_STATUSES = ['pending', 'rejected', 'deleted', ARCHIVE_STATUS]
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
  // 核心记忆 / 技能卡必须人工审核：无论 auditMode / 免审名单如何配置，写入时一律待审。
  // 技能卡由「实际安装的技能」系统生成（submittedBy=skill-sync），不是 agent 沉淀，
  // 但仍要人确认后才进主库 —— 否则技能定义里的任意内容会绕过审核直接注入召回。
  if (String(kind) === 'core') return 'pending'
  // 技能卡同理：由系统从实际技能生成，但不是 agent 沉淀，仍须人工确认。
  if (String(kind) === 'skill') return 'pending'
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

// ── 备份清单 / 保留策略 / 「上次成功备份时间」 ─────────────────────────────
//
// 为什么这些要放在 db.js：定时器（index.js）、HTTP 状态接口（lib/api.js）、
// 容灾还原（lib/auto-restore.js）与 CLI 演练（scripts/backup-drill.mjs）都读同一份
// 备份目录。各自 `readdirSync` 一遍就会出现「面板说有 5 份、定时器认为只有 3 份」
// 这种各说各话的现场。

/** 备份目录（与主库同盘）。 */
export function backupDirOf(root) {
  return path.join(path.resolve(root), 'backups')
}

// memory-eternal-YYYY-MM-DD_HHMM.db（插件/定时器）或 memory-eternal-YYYY-MM-DD.db（drill 镜像）
const BACKUP_NAME_RE = /^memory-eternal-(\d{4})-(\d{2})-(\d{2})(?:[_-]\d{2,4})?\.db$/

/**
 * 从备份文件名里取出「哪一天」（`YYYY-MM-DD`）；认不出返回 ''。
 *
 * 为什么按文件名而不按 mtime：复制 / 镜像 / 从另一台机器救回来的备份，mtime 全是
 * 「被复制的那一刻」，按 mtime 算保留期会把这些备份集体当新的留下、把真该留的删掉。
 * 文件名里的日期是备份**那一刻**的时间，也是 restore 排序（latest）用的同一个口径。
 */
export function backupDayOf(name) {
  const m = BACKUP_NAME_RE.exec(String(name || ''))
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

const pad2 = (n) => String(n).padStart(2, '0')
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/**
 * 列出备份清单（新 → 旧）。
 * @returns {Promise<Array<{name:string,path:string,at:string,atMs:number,sizeMB:number,day:string}>>}
 */
export async function listBackupFiles(root) {
  const dir = backupDirOf(root)
  let names = []
  try { names = await fs.readdir(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    if (!name.startsWith('memory-eternal-') || !name.endsWith('.db')) continue
    const file = path.join(dir, name)
    let st
    try { st = await fs.stat(file) } catch { continue }
    if (!st.isFile()) continue
    out.push({
      name,
      path: file,
      // at 给前端展示（「最近一次备份时间」），mtime 只是文件时间；文件名表示备份时点，
      // 但对 `memory-eternal-YYYY-MM-DD_HHMM.db` 来说两者相差不到一分钟，用 mtime 更精确到分钟。
      at: new Date(st.mtimeMs).toISOString(),
      atMs: st.mtimeMs,
      sizeMB: +(st.size / 1048576).toFixed(2),
      day: backupDayOf(name),
    })
  }
  // 文件名里带日期+时间，字典序 = 时间序（同一天内 HHMM 也单调）
  out.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  return out
}

/** 「上次成功备份」状态文件：<vault>/backups/.last-backup.json（进程重启也要记得）。 */
export function backupStatePath(root) {
  return path.join(backupDirOf(root), '.last-backup.json')
}

/** 读「上次成功备份」状态（没有 / 坏了都返回空状态，不抛）。 */
export function readBackupState(root) {
  const empty = { at: '', atMs: 0, name: '', cards: null, kept: 0, pruned: 0 }
  try {
    const d = JSON.parse(readFileSync(backupStatePath(root), 'utf8'))
    if (!d || typeof d !== 'object') return empty
    const atMs = Number(d.atMs) || (d.at ? Date.parse(String(d.at)) || 0 : 0)
    return {
      at: String(d.at || (atMs ? new Date(atMs).toISOString() : '')),
      atMs,
      name: String(d.name || ''),
      cards: Number.isFinite(Number(d.cards)) && Number(d.cards) >= 0 ? Number(d.cards) : null,
      kept: Number(d.kept) || 0,
      pruned: Number(d.pruned) || 0,
    }
  } catch { return empty }
}

/** 原子写「上次成功备份」状态（写失败不影响备份本身）。 */
export function writeBackupState(root, info = {}) {
  const dir = backupDirOf(root)
  const at = String(info.at || new Date().toISOString())
  const atMs = Number(info.atMs) || Date.parse(at) || Date.now()
  const data = {
    at,
    atMs,
    name: String(info.name || ''),
    cards: Number.isFinite(Number(info.cards)) ? Number(info.cards) : null,
    kept: Number(info.kept) || 0,
    pruned: Number(info.pruned) || 0,
  }
  try {
    mkdirSync(dir, { recursive: true })
    const file = backupStatePath(root)
    const tmp = file + '.' + process.pid + '.tmp'
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch { /* 状态文件写不进去不影响备份可用性 */ }
  return data
}

/**
 * 「上次成功备份是什么时候」（毫秒）。定时器只靠它判断周期 —— 进程内变量一重启就归零，
 * 会导致每次重启都立刻补一遍备份、或反过来一整天不再备份。
 *
 * 优先状态文件；没有（老版本 / 只用 scripts/backup-drill.mjs 备过）时退回最新备份文件的 mtime，
 * 这样升级后第一次也不会因为「没有状态文件」而立刻重复备份。
 */
export function lastBackupAt(root) {
  const st = readBackupState(root)
  if (st.atMs > 0) return st.atMs
  try {
    const dir = backupDirOf(root)
    let newest = 0
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('memory-eternal-') || !name.endsWith('.db')) continue
      try { newest = Math.max(newest, statSync(path.join(dir, name)).mtimeMs) } catch { /* 忽略单个文件 */ }
    }
    return newest
  } catch { return 0 }
}

/**
 * 归一保留参数。
 *   keepDays：按天过期（<=0 = 关闭按天过期）
 *   maxKeep ：份数上限（<=0 = 不限份数，只受 keepDays 约束）
 *
 * 为什么 maxKeep 默认从 7 改成「不限」：同日去重已经保证「一天最多一份」，
 * 30 天保留期自然会收敛到 30 份；再用一个 7 份的硬上限去兜底，等于把 keepDays
 * 变成摆设（永远只有 7 天历史）。需要硬上限的场景（CI / 小磁盘）显式传 maxKeep 即可。
 */
export function normalizeRetention({ maxKeep = 0, keepDays = 30 } = {}) {
  const days = Number(keepDays)
  const keep = Number(maxKeep)
  return {
    keepDays: Number.isFinite(days) && days > 0 ? Math.floor(days) : 0,
    maxKeep: Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 0,
  }
}

/**
 * 这份备份是否已超过保留天数（按文件名里的日期算；当天算第 1 天）。
 * 认不出日期的一律**不删**（宁可留着，也不猜）。
 */
export function isExpiredBackup(name, keepDays, now = new Date()) {
  const days = Number(keepDays) || 0
  if (days <= 0) return false
  const day = backupDayOf(name)
  if (!day) return false
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  cutoff.setDate(cutoff.getDate() - (days - 1))
  // ISO 日期字符串的字典序 = 时间序，直接比字符串，避免时区换算
  return day < dayKey(cutoff)
}

/**
 * 拿只读连接**当场**检查一个 .db 文件是否可用（quick_check），并尽可能数出卡片数。
 * 为什么不复用 dbStatus()：那是**缓存**的打开时结论，文件可能在那之后被写坏/替换 ——
 * 恢复流程必须看**此刻**的真相。
 * @returns {{ok:boolean, cards:number, error:string}}
 */
/**
 * 文件头是不是 SQLite 库（`SQLite format 3\0`）。
 *
 * 为什么先看头再打开：win32 上对**已经坏掉的文件**调 `new DatabaseSync(...)` + `PRAGMA quick_check`
 * 时，语句报错后连接 close() 可能返回 SQLITE_BUSY（未 finalize 的语句），句柄要等 GC 才释放；
 * 紧接着「现场留证」的整文件改名就会撞 EBUSY，把一次本来能成功的恢复拒掉。
 * 只读头 16 字节就足以判定「这不是库」，既准确又完全不产生 SQLite 句柄。
 * 空文件（0 字节）算可用：SQLite 会把它当成空库打开。
 */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1')
function looksLikeSqlite(file) {
  let fd = -1
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(16)
    const n = readSync(fd, buf, 0, 16, 0)
    if (n === 0) return true
    return n === 16 && buf.equals(SQLITE_MAGIC)
  } catch {
    return true // 读不到就交给 SQLite 自己判定，别在这里改变语义
  } finally {
    if (fd >= 0) { try { closeSync(fd) } catch { /* 忽略 */ } }
  }
}

export function probeDbFile(file) {
  if (!looksLikeSqlite(file)) return { ok: false, cards: -1, error: 'file is not a database（文件头不是 SQLite）' }
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
    // close 可能因为残留语句返回 BUSY：试几次，别把句柄留给 GC（Windows 上会卡住后续改名）
    for (let i = 0; probe && i < 3; i++) {
      try { probe.close(); probe = null; break } catch { /* 再试一次 */ }
    }
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

  // ④ 当前库**此刻**仍然健康时要求显式 force（手滑保护）—— 用当场探测，别信缓存。
  //    force 已经给了就不必再探：目的只是「拦手滑」，而 force 表示用户明确要覆盖。
  //    少一次打开还有一个实际好处——Windows 上刚被探测过（哪怕是只读、哪怕文件是坏的）
  //    的库文件，句柄释放有延迟，紧接着的整文件改名会撞 EBUSY。
  const curNow = (!force && existsSync(dbPath)) ? probeDbFile(dbPath) : { ok: false }
  if (curNow.ok && !force) {
    return { ok: false, code: 'DB_HEALTHY', error: '当前库此刻是完好的（quick_check 通过），恢复会覆盖它 —— 确认要恢复请加 --force', cards }
  }
  if (dryRun) return { ok: true, dryRun: true, from: src, cards, note: '仅演练：未改任何文件' }

  // ① 先关掉本进程里这个库的连接（Windows 上不关会改名失败）
  try { closeDb(dir) } catch { /* 忽略 */ }
  // ② 现场留证：**顺序很关键** —— 先挪 -wal / -shm（它们最容易被别的进程锁着），
  //    最后才挪主库。老实现是主库优先，一旦 -wal 改名 EBUSY，主库已经挪走、WAL 还在原地，
  //    结果就是「库文件凭空消失 + 打开报 malformed」的半残状态（真实踩过）。
  //    任何一步失败都把已挪的**改回原名**，最坏情况是「什么都没变」。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const movedAside = []
  const movedPairs = []
  const rollback = () => {
    for (let i = movedPairs.length - 1; i >= 0; i--) {
      const [from, to] = movedPairs[i]
      try { renameSync(to, from) } catch { /* 回滚失败只能如实报告 */ }
    }
  }
  for (const suffix of ['-wal', '-shm', '']) {
    const f = dbPath + suffix
    if (!existsSync(f)) continue
    const to = f + '.corrupt-' + stamp
    try {
      renameWithRetry(f, to)
      movedAside.push(to)
      movedPairs.push([f, to])
    } catch (e) {
      rollback()
      return {
        ok: false,
        error: '现场留证失败（' + f + '）：' + String((e && e.message) || e) +
          '（已改名的文件已还原，本次未做任何替换。别的进程还占着库时，先完全退出 DSH 再试）',
        movedAside: [],
      }
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

/**
 * SQLite 备份：用 `VACUUM INTO` 创建紧凑副本，备份后立刻自校验。
 *
 * 保留策略（两条**都**生效，先按天过期、再按份数兜底）：
 *   keepDays = 30  超过保留天数的备份删掉（按文件名里的日期算，当天算第 1 天）
 *   maxKeep  = 0   份数上限（0 = 不限；同日去重后一天最多一份，份数天然收敛）
 *
 * @param {string} root vault 目录
 * @param {{maxKeep?:number, keepDays?:number}} [opts]
 * @returns {Promise<{ok:boolean, path?:string, cards?:number, kept?:number, pruned?:number,
 *   prunedExpired?:number, prunedMaxKeep?:number, deduped?:number, retention?:object, error?:string}>}
 */
export async function backupDb(root, { maxKeep = 0, keepDays = 30 } = {}) {
  const resolved = path.resolve(root)
  const dbPath = path.join(resolved, DB_FILE)
  const backupDir = path.join(resolved, 'backups')
  await fs.mkdir(backupDir, { recursive: true })
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  const backupPath = path.join(backupDir, `memory-eternal-${date}_${time}.db`)
  const listBackups = async () => (await fs.readdir(backupDir).catch(() => []))
    .filter(f => f.startsWith('memory-eternal-') && f.endsWith('.db')).sort().reverse()
  try {
    const db = getDb(root)
    // VACUUM INTO 遇到已存在的目标文件会直接报 "output file already exists"，
    // 而同一分钟内重复触发（手动点备份、进程重启后补跑）是完全正常的 —— 先让路。
    try { await fs.unlink(backupPath) } catch { /* 不存在就算了 */ }
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`)

    // ① 备份后**立刻**自校验：写坏的备份必须在这里被抓住，不能等它把保留窗口里
    //    唯一一份好备份挤掉之后才发现（原来的实现只报 ok，实际上等于不校验）。
    const probe = probeDbFile(backupPath)
    let liveCards = -1
    try { liveCards = Number(db.prepare('SELECT count(*) AS n FROM cards').get().n) } catch { liveCards = -1 }
    const short = probe.ok && probe.cards >= 0 && liveCards >= 0 && probe.cards < liveCards
    if (!probe.ok || short) {
      try { await fs.unlink(backupPath) } catch { /* 忽略 */ }
      return {
        ok: false,
        error: '备份自校验失败（坏备份已删除）：' + (probe.error || `备份 ${probe.cards} 张 < 主库 ${liveCards} 张`),
      }
    }

    // ② 同一天只留最新一份：小时级重复触发（进程重启、手动点备份）会把保留窗口
    //    挤成只覆盖更少的天数，这里按「天」去重。
    let deduped = 0
    for (const f of await listBackups()) {
      if (f === path.basename(backupPath)) continue
      if (!f.startsWith(`memory-eternal-${date}`)) continue
      try { await fs.unlink(path.join(backupDir, f)); deduped++ } catch { /* 忽略 */ }
    }

    // ③ 保留策略：**先**按天过期清理，**再**按份数上限兜底（两条都生效）。
    //    顺序有意义：先删过期的，份数上限才不会因为「过期文件还占着名额」而误删近期备份。
    const retention = normalizeRetention({ maxKeep, keepDays })
    let prunedExpired = 0
    if (retention.keepDays) {
      for (const f of await listBackups()) {
        if (f === path.basename(backupPath)) continue
        if (!isExpiredBackup(f, retention.keepDays)) continue
        try { await fs.unlink(path.join(backupDir, f)); prunedExpired++ } catch { /* 忽略 */ }
      }
    }
    let prunedMaxKeep = 0
    if (retention.maxKeep) {
      for (const old of (await listBackups()).slice(retention.maxKeep)) {
        try { await fs.unlink(path.join(backupDir, old)); prunedMaxKeep++ } catch { /* 忽略 */ }
      }
    }
    const remain = await listBackups()
    const pruned = prunedExpired + prunedMaxKeep

    // ④ 记下「上次成功备份时间」：定时器跨越进程重启也要知道该不该再备（见 lastBackupAt）
    writeBackupState(resolved, {
      at: new Date().toISOString(),
      atMs: Date.now(),
      name: path.basename(backupPath),
      cards: probe.cards,
      kept: remain.length,
      pruned,
    })

    return {
      ok: true,
      path: backupPath,
      kept: remain.length,
      cards: probe.cards,
      // pruned = 本次被保留策略清掉的份数（过期 + 超限），与 kept 分开报，便于前端展示「清理了 N 份」
      pruned,
      prunedExpired,
      prunedMaxKeep,
      deduped,
      retention,
    }
  } catch (e) {
    try { await fs.unlink(backupPath) } catch { /* 忽略 */ }
    return { ok: false, error: String(e.message || e) }
  }
}
