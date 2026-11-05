// 记忆核心 · SQLite Vault 存储层
//
// 纯工具函数保持不变；IO 函数全部改用 SQL。
// 底层依赖 lib/db.js 的 getDb(root) → DatabaseSync 实例。

import path from 'node:path'
import fs from 'node:fs'
import { getDb, enforceAudit, nextCardId, MAIN_STATUS, QUARANTINE_STATUSES, tableForStatus } from './db.js'
import { minhashSignature, lshCandidates } from './minhash.js'

/** 主题目录根。 */
export const KIND_ROOTS = {
  core: '09-Core',
  project: '02-Projects',
  knowledge: '03-Knowledge',
  content: '04-Content',
  prompt: '05-Prompts',
  business: '06-Business',
  tool: '07-Tools',
  mistake: '08-Mistakes',
  skill: '10-Skills',
}

/** 核心记忆：人工批准后，每次会话注入 systemPrompt 的卡片类型。 */
export const CORE_KIND = 'core'

export const CAPTURE_KINDS = ['project', 'knowledge', 'content', 'prompt', 'business', 'tool', 'mistake', 'skill']

/** 从 Markdown 文本提取 frontmatter 与正文。 */
export function parseCard(text) {
  const meta = { title: '', kind: 'knowledge', tags: [], created: '', updated: '', source: '', formatVersion: 0, status: 'pending', submittedBy: '', severity: 'info', reason: '', deletedAt: '' }
  let body = text
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (m) {
    body = text.slice(m[0].length)
    for (const line of m[1].split(/\r?\n/)) {
      const eq = line.indexOf(':')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (key === 'tags') {
        value = value.replace(/^\[/, '').replace(/\]$/, '')
        meta.tags = value.split(',').map((t) => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
        continue
      }
      if (key === 'formatVersion') {
        meta.formatVersion = Number(value) || 0
      } else if (key === 'kind' || key === 'title' || key === 'created' || key === 'updated' || key === 'source' || key === 'status' || key === 'submittedBy' || key === 'severity' || key === 'reason' || key === 'deletedAt') {
        meta[key] = value.replace(/^['"]|['"]$/g, '')
      }
    }
  }
  if (!meta.status) meta.status = 'pending'
  if (!meta.title) {
    const h = /^#\s+(.+)$/m.exec(body)
    meta.title = h ? h[1].trim() : body.trim().split(/\r?\n/)[0].slice(0, 60)
  }
  const summary = body.trim().slice(0, 200)
  return { meta, body: body.trim(), summary }
}

/** 生成安全 slug（中文保留、非法字符替换为 -）。 */
export function safeSlug(name) {
  const base = String(name || 'card')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\w\u4e00-\u9fff-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return base || 'card'
}

/** 字符 bigram 集合（textSimilarity 的预处理部分，单独暴露供 O(n²) 场景复用）。 */
export function bigramSet(text) {
  const cleaned = String(text)
    .replace(/[\s#*_`|[\]()（）\-—・]+/g, '')
    .toLowerCase()
  const out = new Set()
  for (let i = 0; i < cleaned.length - 1; i++) out.add(cleaned.slice(i, i + 2))
  if (cleaned.length === 1) out.add(cleaned)
  return out
}

/**
 * 与 bigramSet 同规则（同一套清洗），但把每个 bigram 压成 32 位整数再入集合。
 * 为什么单独一份：Set<number> 的构建与求交都比 Set<string> 快数倍，
 * 而 **去重判定** 仍必须用字符串版（语义不能变）—— 所以图谱专用、互不干扰。
 */
export function bigramHashSet(text) {
  const cleaned = String(text)
    .replace(/[\s#*_`|[\]()（）\-—・]+/g, '')
    .toLowerCase()
  const out = new Set()
  for (let i = 0; i < cleaned.length - 1; i++) out.add(hash32(cleaned.slice(i, i + 2)))
  if (cleaned.length === 1) out.add(hash32(cleaned))
  return out
}

/** 32 位 FNV-1a：把 bigram 压成整数键。 */
function hash32(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 用预算好的 bigram 集合算 Jaccard（结果与 textSimilarity 完全一致）。
 *
 * `minRatio` 是数学上界剪枝：J ≤ min(|A|,|B|)/max(|A|,|B|)，所以长度比低于阈值时
 * 必然 `J < 阈值`，可直接返回 0 **不迭代**（对「J ≥ 阈值」的判定无损，不是近似）。
 * 图谱的 O(n²) 配对就靠这一步从「每次重新分词两段正文」变成「集合求交」。
 */
export function jaccardSets(ba, bb, minRatio = 0) {
  if (!ba || !bb || ba.size === 0 || bb.size === 0) return 0
  const [small, large] = ba.size <= bb.size ? [ba, bb] : [bb, ba]
  if (minRatio > 0 && small.size / large.size < minRatio) return 0
  let inter = 0
  for (const g of small) if (large.has(g)) inter++
  return inter / (ba.size + bb.size - inter)
}

/** Jaccard-like 相似度：字符 bigram 集合。 */
export function textSimilarity(a, b) {
  return jaccardSets(bigramSet(a), bigramSet(b))
}

/** CJK 感知查询词：整词 + 中文字符 bigram。 */
export function queryTerms(query) {
  const tokens = new Set(String(query).split(/[^\w\u4e00-\u9fff]+/).filter(Boolean))
  for (let i = 0; i < query.length - 1; i++) {
    const c1 = query[i]
    const c2 = query[i + 1]
    if (/[\u4e00-\u9fff]/.test(c1) && /[\u4e00-\u9fff]/.test(c2)) tokens.add(c1 + c2)
  }
  return tokens
}

/**
 * 在目标目录中找与候选文本最相似的现有卡（去重守卫）。比较正文。
 *
 * 只比对 **approved**（P0 修复）：命中后调用方会 `appendUpdate` 往这张卡里追加内容，
 * 而 pending / rejected 是不该再长内容的状态——旧实现只按 `deleted_at IS NULL` 过滤，
 * 会把新知识追加进待审垃圾卡或已被驳回的卡，等于绕过审核往废弃卡里灌数据。
 */
export async function dedupCheck(root, text, threshold = 0.62) {
  return bestDuplicate(await mainStoreBodies(root), text, threshold)
}

/**
 * 主库已审核卡的 `(path, body)` 快照。
 *
 * 批量写入（导入备份）必须用它做**导入前**基线：否则同一份备份里互相近似的卡会在写入
 * 过程中互相判重，把备份当成「重复」丢掉一批（备份是真相源，不能被自己人吞）。
 */
export async function mainStoreBodies(root) {
  const db = getDb(root)
  return db.prepare("SELECT path, body FROM cards WHERE status = 'approved' AND deleted_at IS NULL").all()
}

/** 在一组候选里找与给定文本最相似的一张（≥ 阈值）。候选集合由调用方提供，供快照比对复用。 */
export function bestDuplicate(candidates, text, threshold = 0.62) {
  let best = null
  for (const row of Array.isArray(candidates) ? candidates : []) {
    const score = textSimilarity(text, row?.body || '')
    if (score >= threshold && (!best || score > best.score)) best = { path: row?.path, score }
  }
  return best
}

// 目录名 → kind 推断
function kindFromDir(topDir) {
  for (const [k, v] of Object.entries(KIND_ROOTS)) { if (v.toLowerCase() === String(topDir || '').toLowerCase()) return k }
  return 'knowledge'
}

/** 确保 vault 目录结构存在（即确保 DB 存在）。 */
export async function ensureVault(root) {
  // getDb 会自动建表
  getDb(root)
}

/** 将 SQL 行还原为调用方期望的卡片摘要对象。 */
function rowToCard(row) {
  return {
    path: row.path,
    kind: row.kind,
    title: row.title,
    tags: normalizeTags(row.tags),
    summary: row.summary || '',
    created: row.created_at,
    updated: row.updated_at,
    mtime: new Date(row.updated_at).getTime(),
    status: row.status,
    submittedBy: row.submitted_by || '',
    severity: row.severity || 'info',
    reason: row.reason || '',
    deletedAt: row.deleted_at || '',
  }
}

/** 将 SQL 行还原为完整 Markdown 文本（frontmatter + body）。 */
function rowToMarkdown(row) {
  const tags = normalizeTags(row.tags)
  const lines = [
    '---',
    `formatVersion: 1`,
    `kind: ${row.kind}`,
    `title: ${yamlString(row.title)}`,
    `tags: [${tags.map((t) => yamlString(t)).join(', ')}]`,
    `created: ${row.created_at}`,
    `updated: ${row.updated_at}`,
    `status: ${row.status}`,
    ...(row.deleted_at ? [`deletedAt: ${row.deleted_at}`] : []),
    ...(row.submitted_by ? [`submittedBy: ${yamlString(row.submitted_by)}`] : []),
    ...(row.severity && row.severity !== 'info' ? [`severity: ${row.severity}`] : []),
    ...(row.reason ? [`reason: ${yamlString(row.reason)}`] : []),
    ...(row.source ? [`source: ${row.source}`] : []),
    '---',
    '',
    `# ${row.title}`,
    '',
    row.body.trim(),
    '',
  ]
  // 附加 card_updates
  return { text: lines.join('\n'), tags }
}

/**
 * 智能体署名归一（与客户端 normAgent 同一套规则，供 SQL 过滤用）：
 * 空 / agent / unknown / session:* / DeepSeek Harness → deepseek-harness；claude-code* → claude；其余精确匹配。
 */
function agentWhere(agent, args) {
  const a = String(agent || '').toLowerCase()
  if (a === 'deepseek-harness') {
    args.push('', 'agent', 'unknown', 'deepseek-harness', 'deepseek harness')
    return "(LOWER(COALESCE(submitted_by,'')) IN (?,?,?,?,?) OR submitted_by LIKE 'session:%')"
  }
  if (a === 'claude') { args.push('claude', 'claude-code%'); return "(LOWER(COALESCE(submitted_by,'')) = ? OR submitted_by LIKE ?)" }
  args.push(a)
  return "LOWER(COALESCE(submitted_by,'')) = ?"
}

// ---- 两套存储：主库（cards，只存 approved）/ 隔离区（quarantine，pending·rejected·deleted）--
//
// 下面三个函数负责「把状态白名单翻译成对两张表的查询」。读路径默认只碰主库：
// 主库物理上不含非 approved 行，所以查主库**不需要写状态条件**，也就没有「漏写状态条件」这种 bug 面。

/** 状态白名单 → 需要读的表清单。 */
function storesFor(want) {
  const hasMain = want.includes(MAIN_STATUS)
  const hasQuarantine = want.some((s) => QUARANTINE_STATUSES.includes(s))
  if (hasMain && !hasQuarantine) return [{ table: 'cards', statuses: null }]
  if (hasQuarantine && !hasMain) return [{ table: 'quarantine', statuses: want.filter((s) => QUARANTINE_STATUSES.includes(s)) }]
  return [
    { table: 'cards', statuses: null },
    { table: 'quarantine', statuses: want.filter((s) => QUARANTINE_STATUSES.includes(s)) },
  ]
}

/**
 * 生成一条「跨两套存储」的查询。
 * @param sel    选择列表（如 '*' 或 'path, title'）
 * @param stores storesFor() 的结果
 * @param extra  { kind, agent, tail } —— tail 是 ORDER BY / LIMIT 片段（默认按 updated_at 倒序）
 */
function multiStoreQuery(sel, stores, { kind = '', agent = '', tag = '', tail = 'ORDER BY updated_at DESC' } = {}) {
  const parts = []
  const args = []
  for (const store of stores) {
    const where = []
    const wargs = []
    if (store.statuses) {
      where.push(`status IN (${store.statuses.map(() => '?').join(',')})`)
      wargs.push(...store.statuses)
    }
    if (kind) { where.push('kind = ?'); wargs.push(kind) }
    if (agent) where.push(agentWhere(agent, wargs))
    // 标签过滤（issue #46 后的界面改进）：tags 列是 JSON 数组字符串（["a","b"]），
    // 用 instr 找带引号的完整标签：既不受 LIKE 通配符影响，也不会把 "ab" 匹配成 "a"。
    if (tag) { where.push('instr(lower(tags), lower(?)) > 0'); wargs.push('"' + String(tag) + '"') }
    parts.push(`SELECT ${sel} FROM ${store.table}${where.length ? ' WHERE ' + where.join(' AND ') : ''}`)
    args.push(...wargs)
  }
  return { sql: parts.join(' UNION ALL ') + ' ' + tail, args }
}

/** 在两张表里按 path 找一行（跨存储读取用，返回 { table, row }）。 */
function findCardRow(db, rel) {
  const inMain = db.prepare('SELECT * FROM cards WHERE path = ?').get(rel)
  if (inMain) return { table: 'cards', row: inMain }
  const inQuarantine = db.prepare('SELECT * FROM quarantine WHERE path = ?').get(rel)
  if (inQuarantine) return { table: 'quarantine', row: inQuarantine }
  return null
}

/** 某个 path 是否已被占用（两张表任意一张里有，就算占用）。 */
function pathTaken(db, rel) {
  if (db.prepare('SELECT 1 FROM cards WHERE path = ?').get(rel)) return true
  return !!db.prepare('SELECT 1 FROM quarantine WHERE path = ?').get(rel)
}

/** 标题排序用的中文排序器（拼音 + 数字感知）；固定 zh-Hans-CN，避免随进程 locale 漂移。 */
export const TITLE_COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/**
 * 列出卡片。
 *
 * 两套存储下 status 的语义：'approved' → 只查主库（**不加状态条件**，主库物理上只有 approved）；
 * 'pending'/'rejected'/'deleted' → 查隔离区；'all' → 两张表 UNION（审核中心用）。
 *
 * @param opts.status  状态白名单（默认 approved = 主库）
 * @param opts.kind    类型过滤（SQL）
 * @param opts.agent   署名过滤（服务端归一，如 deepseek-harness / claude）
 * @param opts.limit   返回条数上限（缺省=全部，供内部调用保持原语义）
 * @param opts.offset  偏移（配合 limit 做真分页）
 * @param opts.sort    'recent'（updated_at DESC，默认）| 'title'（拼音升序，跨页全局有序）
 */
export async function listCards(root, { status, kind, agent, tag = '', limit, offset = 0, sort = 'recent' } = {}) {
  const want = status ?? [MAIN_STATUS]
  const db = getDb(root)
  const stores = storesFor(want)

  if (sort === 'title') {
    // SQLite 的 ORDER BY 是 UTF-8 字节序，中文标题看着就是乱的 → 只取 path/title 用拼音排好，
    // 再回表取这一页的正文（避免为了排序把所有正文读进内存）。
    const { sql, args } = multiStoreQuery('path, title', stores, { kind, agent, tag, tail: '' })
    const light = db.prepare(sql).all(...args)
    light.sort((a, b) => TITLE_COLLATOR.compare(a.title || '', b.title || ''))
    const start = Math.max(0, offset | 0)
    const page = Number.isInteger(limit) && limit > 0 ? light.slice(start, start + limit) : light.slice(start)
    if (page.length === 0) return []
    const paths = page.map((r) => r.path)
    const rows = []
    for (const store of stores) {
      const ph = paths.map(() => '?').join(',')
      rows.push(...db.prepare(`SELECT * FROM ${store.table} WHERE path IN (${ph})`).all(...paths))
    }
    const byPath = new Map(rows.map((r) => [r.path, rowToCard(r)]))
    return page.map((r) => byPath.get(r.path)).filter(Boolean)
  }

  const tail = Number.isInteger(limit) && limit > 0
    ? `ORDER BY updated_at DESC LIMIT ? OFFSET ?`
    : 'ORDER BY updated_at DESC'
  // 注意：两张表的列数不同（quarantine 多 quarantined_at / quarantine_reason），
  // UNION ALL 必须显式列出公共列，不能用 `*`（否则列会错位）。
  const { sql, args } = multiStoreQuery(
    'id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at',
    stores,
    { kind, agent, tag, tail },
  )
  const finalArgs = Number.isInteger(limit) && limit > 0 ? [...args, limit, Math.max(0, offset | 0)] : args
  return db.prepare(sql).all(...finalArgs).map(rowToCard)
}

/** 计数（分页接口要用 total 判断还有没有下一页）。 */
export async function countCards(root, { status, kind, agent, tag = '' } = {}) {
  const db = getDb(root)
  const stores = storesFor(status ?? [MAIN_STATUS])
  const { sql, args } = multiStoreQuery('COUNT(*) n', stores, { kind, agent, tag, tail: '' })
  return db.prepare(`SELECT SUM(n) n FROM (${sql})`).get(...args).n || 0
}

/** 审核队列：status=pending 或 rejected。 */
export async function auditQueue(root) {
  const cards = await listCards(root, { status: ['pending', 'rejected'] })
  return { pending: cards.filter((c) => c.status === 'pending'), rejected: cards.filter((c) => c.status === 'rejected') }
}

/** 同一个事务里执行 fn（失败自动回滚）。跨表搬家必须原子，否则会丢卡。 */
function inTransaction(db, fn) {
  db.exec('BEGIN')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
    throw e
  }
}

/**
 * 把一张卡从一张表搬到另一张表（重建行、保住内容 / 时间戳 / 更新记录）。
 *
 * 为什么不用同一个 id：两张表共享 `path` 命名空间，但 id 由 `card_sequence` 单一发号器
 * 保证**全库唯一**；跨表插入时旧 id 可能已被目标表占用（实测 `UNIQUE constraint failed`）。
 * 所以搬家时重新领号，并把 `card_updates.card_id` 一起改绑 —— 用户视角「更新记录还在」。
 * 之所以要原子：INSERT 成功而 DELETE 失败会留下重复卡；反过来则直接丢卡。
 */
function moveCardBetweenStores(db, from, to, rel, { status, deletedAt = null, quarantineReason = '', updatedAt } = {}) {
  const now = updatedAt || new Date().toISOString()
  return inTransaction(db, () => {
    const src = db.prepare(`SELECT * FROM ${from} WHERE path = ?`).get(rel)
    if (!src) throw new Error(`卡片不在 ${from}: ${rel}`)
    const newId = nextCardId(db)

    if (to === 'quarantine') {
      db.prepare(`
        INSERT INTO quarantine
          (id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at, quarantined_at, quarantine_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
      `).run(newId, src.path, src.kind, src.title, src.tags, src.body, src.summary, status, src.source, src.submitted_by, src.severity, src.reason, src.created_at, now, deletedAt, quarantineReason)
    } else {
      db.prepare(`
        INSERT INTO cards
          (id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(newId, src.path, src.kind, src.title, src.tags, src.body, src.summary, status, src.source, src.submitted_by, src.severity, src.reason, src.created_at, now, deletedAt)
    }
    // 更新记录跟着卡走（id 变了，按新 id 改绑）
    db.prepare('UPDATE card_updates SET card_id = ? WHERE card_id = ?').run(newId, src.id)
    db.prepare(`DELETE FROM ${from} WHERE path = ?`).run(rel)
    return { ok: true, status, table: to, oldId: src.id, newId }
  })
}

/** 回收站：隔离区里 status=deleted，按 deleted_at 倒序。 */
export async function recycleList(root) {
  const db = getDb(root)
  const rows = db.prepare('SELECT * FROM quarantine WHERE status = ? ORDER BY deleted_at DESC').all('deleted')
  return rows.map(rowToCard)
}

/** 清理超过 retentionDays 天的回收卡（永久删除）。 */
export async function purgeExpired(root, retentionDays = 30) {
  const db = getDb(root)
  const cut = new Date(Date.now() - retentionDays * 86400000).toISOString()
  const rows = db.prepare('SELECT path FROM quarantine WHERE status = ? AND deleted_at IS NOT NULL AND deleted_at < ?').all('deleted', cut)
  let purged = 0
  for (const row of rows) {
    try { await deleteCard(root, row.path, { permanent: true }); purged++ } catch {}
  }
  return { ok: true, purged }
}

/**
 * 读取一张卡（返回 Markdown 文本）。
 *
 * 两套存储下的语义：
 * - 默认**只读主库**（主库物理上只含 approved）→ 想读未审核内容，必须显式 `allowUnapproved`。
 * - `allowUnapproved: true` 时（审核中心 / 回收站预览）走两张表。
 * 「不存在」与「存在但未审核」是两种不同的错误码，方便上层区分。
 */
export async function readCard(root, rel, { allowUnapproved = false } = {}) {
  const db = getDb(root)
  const mainRow = db.prepare('SELECT * FROM cards WHERE path = ?').get(rel)
  let row = mainRow
  if (!row && allowUnapproved) row = db.prepare('SELECT * FROM quarantine WHERE path = ?').get(rel)
  if (!row) {
    // path 可能在隔离区而不在主库 —— 这种情况不能当成「不存在」，否则审核中心会误判
    const inQuarantine = db.prepare('SELECT status FROM quarantine WHERE path = ?').get(rel)
    const err = new Error(inQuarantine
      ? `卡片在隔离区（${statusLabel(inQuarantine.status)}），未通过审核不能读取正文：${rel}`
      : `卡片不存在: ${rel}`)
    err.code = inQuarantine ? 'CARD_NOT_APPROVED' : 'CARD_NOT_FOUND'
    if (inQuarantine) err.status = inQuarantine.status
    throw err
  }
  const status = String(row.status || '')
  const { text } = rowToMarkdown(row)
  const updates = db.prepare('SELECT content, created_at FROM card_updates WHERE card_id = ? ORDER BY created_at ASC').all(row.id)
  if (updates.length > 0) {
    const updateLines = updates.map((u) => `- ${u.created_at.slice(0, 10)}：${u.content}`)
    return { path: rel, status, store: mainRow ? 'main' : 'quarantine', text: text + '\n## 更新记录\n\n' + updateLines.join('\n') + '\n' }
  }
  return { path: rel, status, store: mainRow ? 'main' : 'quarantine', text }
}

/** 状态中文标签（错误信息与日志用）。 */
function statusLabel(status) {
  const s = String(status || '')
  return s === 'pending' ? '待审核' : s === 'rejected' ? '已驳回' : s === 'deleted' ? '回收站中' : s
}

/**
 * 删除卡片。
 * - 永久删除：从**任一张表**里抹掉（含更新记录，靠外键 CASCADE）。
 * - 软删（默认）：主库卡 → 搬进隔离区并置 deleted；隔离区卡 → 原地置 deleted。
 */
export async function deleteCard(root, rel, { permanent = false } = {}) {
  const db = getDb(root)
  if (permanent) {
    // 先按 path 取 id（两张表共享 id 空间），再清理按 id 关联的更新记录 —— card_updates
    // 不带外键（卡会在两表间搬家），所以级联必须在这里手工做。
    const ids = []
    const mainRow = db.prepare('SELECT id FROM cards WHERE path = ?').get(rel)
    if (mainRow) ids.push(mainRow.id)
    const qRow = db.prepare('SELECT id FROM quarantine WHERE path = ?').get(rel)
    if (qRow) ids.push(qRow.id)
    if (!ids.length) throw new Error('卡片不存在: ' + rel)
    inTransaction(db, () => {
      for (const id of ids) {
        db.prepare('DELETE FROM card_updates WHERE card_id = ?').run(id)
        db.prepare('DELETE FROM feedback WHERE card_path = ?').run(rel)
      }
      db.prepare('DELETE FROM cards WHERE path = ?').run(rel)
      db.prepare('DELETE FROM quarantine WHERE path = ?').run(rel)
    })
    return { ok: true, permanent: true }
  }
  const existing = findCardRow(db, rel)
  if (!existing) throw new Error('卡片不存在: ' + rel)
  if (existing.table === 'cards') {
    const r = moveCardBetweenStores(db, 'cards', 'quarantine', rel, { status: 'deleted', deletedAt: new Date().toISOString(), quarantineReason: '移入回收站' })
    db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)').run(rel, existing.row.status, 'deleted', 'delete', '软删进回收站')
    return { ok: true, soft: true, ...r }
  }
  const now = new Date().toISOString()
  db.prepare('UPDATE quarantine SET status = ?, deleted_at = ?, updated_at = ? WHERE path = ?').run('deleted', now, now, rel)
  db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)').run(rel, existing.row.status, 'deleted', 'delete', '软删进回收站')
  return { ok: true, soft: true }
}

/** 恢复回收站的卡：从隔离区搬回主库，status=approved。写审计日志。 */
export async function restoreCard(root, rel) {
  const db = getDb(root)
  const existing = db.prepare('SELECT status FROM quarantine WHERE path = ?').get(rel)
  if (!existing) throw new Error('卡片不在回收站/隔离区: ' + rel)
  const r = moveCardBetweenStores(db, 'quarantine', 'cards', rel, { status: MAIN_STATUS, deletedAt: null })
  db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)').run(rel, existing.status, MAIN_STATUS, 'restore', '回收站恢复')
  return { ok: true, restored: true, ...r }
}

/**
 * 更新卡状态（审核操作，唯一入口）。写审计日志。
 *
 * 两套存储的关键点：status 决定这张卡**住在哪张表**。
 * → approved：搬进主库（agent 可召回）；pending/rejected/deleted：留在/搬进隔离区。
 */
export async function setCardStatus(root, rel, status, { changedBy = 'system', reason = '' } = {}) {
  const db = getDb(root)
  const target = String(status)
  const existing = findCardRow(db, rel)
  if (!existing) throw new Error('卡片不存在: ' + rel)

  if (target === MAIN_STATUS) {
    if (existing.table === 'cards') {
      db.prepare('UPDATE cards SET status = ?, updated_at = ? WHERE path = ?').run(target, new Date().toISOString(), rel)
    } else {
      moveCardBetweenStores(db, 'quarantine', 'cards', rel, { status: target, deletedAt: null })
    }
  } else {
    if (existing.table === 'cards') {
      moveCardBetweenStores(db, 'cards', 'quarantine', rel, { status: target, deletedAt: target === 'deleted' ? new Date().toISOString() : null, quarantineReason: reason || '审核流转' })
    } else {
      db.prepare('UPDATE quarantine SET status = ?, deleted_at = ?, updated_at = ? WHERE path = ?')
        .run(target, target === 'deleted' ? new Date().toISOString() : null, new Date().toISOString(), rel)
    }
  }
  db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)').run(rel, existing.row.status, target, changedBy, reason)
  return { ok: true, status: target, store: tableForStatus(target) }
}

/**
 * 原子写卡；先去重，命中返回 {duplicate}。审核守卫在数据库层强制。
 *
 * 两套存储：enforceAudit 判定出的 status 决定**写进哪张表** ——
 * approved → 主库（可被召回）；pending/rejected/deleted → 隔离区（只有审核中心能看）。
 *
 * `dedupAgainst` 传入候选集合时，去重只跟**这些**卡比（导入备份用：基线取导入前的快照，
 * 让同一批里互相近似的卡不会互吞）。
 */
/**
 * 把各种形态的 tags 归一化成字符串数组（issue #41 的根因）。
 *
 * 现场：调用方通过 /write 传了**字符串**（`"[\"a\",\"b\"]"`），而 writeCard 直接 `JSON.stringify(tags)`
 * → 落库变成「一个字符串的 JSON 表示」（双重编码）→ 读出来仍是字符串 → 前端 `tags.slice(...).map` 抛错
 * → **整页黑屏**（React 根组件挂载失败）。自动沉淀路径本来就有 Array.isArray 检查，只有 /write 等直连入口漏了。
 * 这里做成唯一入口：数组 / JSON 字符串 / 逗号串 / 双重编码的旧数据，全都收敛成数组。
 */
export function normalizeTags(tags) {
  let v = tags
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s) return []
    // 最多剥两层：正常 JSON（["a","b"]）+ 双重编码（"[\"a\",\"b\"]" —— #41 的现场，
    // 它以引号开头，所以只判断 startsWith('[') 会漏掉）。剥不动就按逗号串处理。
    let cur = s
    for (let i = 0; i < 2; i++) {
      if (typeof cur !== 'string') break
      const t = cur.trim()
      if (!(t.startsWith('[') || t.startsWith('"'))) break
      try { cur = JSON.parse(t) } catch { break }
    }
    v = typeof cur === 'string' ? cur.split(',') : cur
  }
  if (!Array.isArray(v)) return []
  return v
    .map((t) => String(t == null ? '' : t).trim())
    .filter(Boolean)
    .map((t) => t.slice(0, 30))
    .slice(0, 20)
}

/**
 * 把一张已批准的卡片设为核心记忆（kind=core），或恢复成普通知识卡。
 * 只有主库（approved）卡片可以设为核心；审核中的卡必须先批准。
 */
export async function setCardKind(root, rel, kind) {
  const db = getDb(root)
  const target = String(kind || '').trim()
  const existing = findCardRow(db, rel)
  if (!existing) throw new Error('卡片不存在: ' + rel)
  if (existing.table !== 'cards') throw new Error('只有已批准卡片才能设为核心记忆，请先在审核中心批准')
  if (target !== CORE_KIND && !CAPTURE_KINDS.includes(target)) throw new Error('不支持的卡片类型: ' + target)
  const now = new Date().toISOString()
  db.prepare('UPDATE cards SET kind = ?, updated_at = ? WHERE path = ?').run(target, now, rel)
  return { ok: true, path: rel, kind: target, updatedAt: now }
}

export async function writeCard(root, { kind, title, tags = [], body, source = '', status = 'pending', submittedBy = '', severity = 'info', reason = '', deletedAt = '' }, { threshold = 0.62, dedup = true, dedupAgainst = null } = {}) {
  const db = getDb(root)
  const kindRoot = KIND_ROOTS[kind] || KIND_ROOTS.knowledge
  // 唯一归一化入口：任何调用方（/write、MCP、脚本、自动沉淀）传字符串都不会再双重编码
  tags = normalizeTags(tags)

  // 审核守卫：数据库层强制，调用方传的 status 仅作 fallback
  const enforcedStatus = enforceAudit(root, kind, submittedBy, status)
  const targetTable = tableForStatus(enforcedStatus)

  // 去重只在主库（approved）里找 —— 把新知识追加进隔离区里的待审/驳回卡是绕过审核
  if (dedup) {
    const hit = dedupAgainst ? bestDuplicate(dedupAgainst, body, threshold) : await dedupCheck(root, body, threshold)
    if (hit) return { ok: false, duplicate: { ...hit, path: hit.path } }
  }

  const slug = safeSlug(title)
  let rel = `${kindRoot}/${slug}.md`
  let index = 2
  while (pathTaken(db, rel)) {
    rel = `${kindRoot}/${slug}-${index}.md`
    index++
  }

  const now = new Date().toISOString()
  const summary = body.trim().slice(0, 200)
  const id = nextCardId(db) // 跨两张表唯一的 id，由 card_sequence 单一发号器分配
  if (targetTable === 'cards') {
    db.prepare(`
      INSERT INTO cards (id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, rel, kind, title, JSON.stringify(tags), body.trim(), summary,
      enforcedStatus, source, submittedBy, severity, reason, now, now, deletedAt || null,
    )
  } else {
    db.prepare(`
      INSERT INTO quarantine (id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at, quarantined_at, quarantine_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(
      id, rel, kind, title, JSON.stringify(tags), body.trim(), summary,
      enforcedStatus, source, submittedBy, severity, reason, now, now, deletedAt || null,
      '新卡待审核',
    )
  }
  return { ok: true, path: rel, kind, status: enforcedStatus, store: targetTable }
}

/**
 * 向已存在的卡追加更新记录（跨两张表找，因为审核流转会把卡搬表，但 id 不变）。
 *
 * 注意：调用方（沉淀管线）只在**主库命中去重**时才追加，所以这里不会把新知识灌进隔离区卡。
 */
export async function appendUpdate(root, rel, updateText) {
  const db = getDb(root)
  const found = findCardRow(db, rel)
  if (!found) throw new Error('卡片不存在: ' + rel)
  const row = found.row
  const now = new Date().toISOString()
  db.prepare('INSERT INTO card_updates (card_id, content, created_at) VALUES (?, ?, ?)').run(row.id, updateText.trim(), now)
  db.prepare(`UPDATE ${found.table} SET updated_at = ? WHERE id = ?`).run(now, row.id)
  return { ok: true, path: rel, updated: now, store: found.table }
}

/**
 * 原地更新一张卡的内容（标题 / 标签 / 正文 / 原因），不改变它的状态与所在表。
 *
 * 仅供「技能卡同步」这类**系统生成**路径使用：技能定义变了，待审卡应就地刷新，
 * 而不是每轮扫描都新建一张重复的待审卡。人工卡审核流转仍走 setCardStatus。
 *
 * @returns {{ok:boolean, path:string, store:'cards'|'quarantine', updated:string}}
 */
export async function updateCardContent(root, rel, { title, tags, body, reason } = {}) {
  const db = getDb(root)
  const found = findCardRow(db, rel)
  if (!found) throw new Error('卡片不存在: ' + rel)
  const row = found.row
  const now = new Date().toISOString()
  const nextTitle = title === undefined ? row.title : String(title)
  const nextTags = tags === undefined ? normalizeTags(row.tags) : normalizeTags(tags)
  const nextBody = body === undefined ? row.body : String(body).trim()
  const nextReason = reason === undefined ? row.reason : String(reason)
  db.prepare(
    `UPDATE ${found.table} SET title = ?, tags = ?, body = ?, summary = ?, reason = ?, updated_at = ? WHERE path = ?`,
  ).run(nextTitle, JSON.stringify(nextTags), nextBody, nextBody.slice(0, 200), nextReason, now, rel)
  return { ok: true, path: rel, store: found.table, updated: now }
}

/** 合并多张卡为一张。 */
export async function mergeCards(root, paths) {
  const list = (Array.isArray(paths) ? paths : []).map((p) => String(p || '').trim()).filter(Boolean)
  if (list.length < 2) return { ok: false, error: '至少选 2 张卡' }
  const db = getDb(root)

  const rows = []
  for (const p of list) {
    const found = findCardRow(db, p)
    if (found) rows.push(found.row)
  }
  if (rows.length < 2) return { ok: false, error: '读取失败' }

  const first = rows[0]
  const tags = new Set(normalizeTags(first.tags))
  let combined = ''
  rows.forEach((row, i) => {
    const rowTags = normalizeTags(row.tags)
    rowTags.forEach((t) => tags.add(t))
    combined += (i ? '\n\n---\n\n' : '') + row.body.trim()
  })

  const title = (first.title || '合并记忆') + '（合并）'
  const r = await writeCard(root, { kind: first.kind || 'knowledge', title, tags: [...tags], body: combined, source: 'merge', status: 'pending', submittedBy: 'merge', reason: '多卡合并' }, { dedup: false })
  if (!r.ok) return { ok: false, error: '写入失败' }
  for (const row of rows) { try { await deleteCard(root, row.path, { permanent: true }) } catch {} }
  return { ok: true, path: r.path, merged: rows.length }
}

/** 检索：整词/中文 bigram 命中。 */
export async function search(root, query, { limit = 30, minScore = 0, semantic = false } = {}) {
  const q = String(query || '').trim()
  if (!q) return []
  const db = getDb(root)
  // 两套存储后这里**不再需要状态条件**：主库物理上只含 approved。
  const rows = db.prepare('SELECT * FROM cards ORDER BY updated_at DESC').all()
  const wanted = queryTerms(q)
  const out = []
  for (const row of rows) {
    const card = rowToCard(row)
    const haystack = `${card.path}\n${card.title}\n${row.body}`.toLowerCase()
    let score = 0
    if (haystack.includes(q.toLowerCase())) score = 3
    for (const term of wanted) {
      if (haystack.includes(term.toLowerCase())) score += 1
    }
    if (semantic) score += Math.round(textSimilarity(q, `${card.title} ${card.summary}`) * 6)
    if (score > 0 && score >= minScore) {
      out.push({ ...card, score, excerpt: row.body.trim().slice(0, 300) })
    }
  }

  // 反馈反哺排序
  const fb = await readFeedback(root)
  const ql = q.toLowerCase()
  const fbByPath = {}
  for (const f of fb) {
    if (!f.path) continue
    const fq = String(f.query || '').toLowerCase()
    const overlap = fq && (fq === ql || ql.includes(fq) || fq.includes(ql) || queryTerms(f.query).some((term) => wanted.includes(term)))
    if (!overlap) continue
    const rec = fbByPath[f.path] = fbByPath[f.path] || { useful: 0, irr: 0 }
    if (f.useful) rec.useful += 1; else rec.irr += 1
  }
  for (const hit of out) {
    const rec = fbByPath[hit.path]
    if (rec) hit.score += rec.useful * 2 - rec.irr * 2
  }
  out.sort((a, b) => b.score - a.score || b.mtime - a.mtime)
  return out.slice(0, limit)
}

/** 用量趋势：最近 N 天每天新增卡片数。 */
export async function dailyCounts(root, days = 30) {
  const db = getDb(root)
  const cut = new Date(Date.now() - days * 86400000).toISOString()
  const rows = db.prepare("SELECT DATE(created_at) as d, COUNT(*) as cnt FROM cards WHERE created_at >= ? GROUP BY DATE(created_at)").all(cut)
  const map = new Map(rows.map((r) => [r.d, r.cnt]))
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000)
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
    out.push({ date: key, count: map.get(key) || 0 })
  }
  return out
}

/**
 * 导出全部卡片原始 Markdown（**含隔离区**：用户做备份/迁移时不应该只拿到主库）。
 * 顺带给出 store 字段，导入方可以据此判断这张卡该回主库还是回隔离区。
 */
export async function exportCards(root) {
  const db = getDb(root)
  const main = db.prepare('SELECT * FROM cards ORDER BY updated_at DESC').all().map((r) => ({ ...r, __store: 'main' }))
  const quarantined = db.prepare('SELECT * FROM quarantine ORDER BY updated_at DESC').all().map((r) => ({ ...r, __store: 'quarantine' }))
  return [...main, ...quarantined].map((row) => {
    const { text } = rowToMarkdown(row)
    return { path: row.path, title: row.title, kind: row.kind, status: row.status, store: row.__store, text }
  })
}

// 图谱缓存：一次生成约 300ms（301 卡），重复请求（多客户端/切页重开）直接命中。
// 失效用「指纹」而不是 TTL 兜底：卡数 + 更新时间 + 状态直方图 + 审计日志/更新记录水位，
// 任何写卡、审核、删卡、追加更新都会改变指纹 → 不存在脏读。
const GRAPH_CACHE_MAX = 4
const GRAPH_CACHE_TTL_MS = 5 * 60 * 1000
const graphCache = new Map() // root -> { fp, value, at }

// ---- P0-1：建图结果落盘 ------------------------------------------------------
// 指纹一变就失效，命中直接读文件 —— 免掉整条建图管线（596 卡实测 ~600ms → ~25ms）。
// 文件放 vault 根目录、原子写（tmp + rename），写失败/超限都只是「下次重建」，不影响功能。
const GRAPH_CACHE_FILE = 'memory-eternal-graph-cache.json'
const GRAPH_CACHE_MAX_BYTES = 8 * 1024 * 1024
const graphCachePath = (root) => path.join(root, GRAPH_CACHE_FILE)

function readGraphCache(root, fp) {
  try {
    const data = JSON.parse(fs.readFileSync(graphCachePath(root), 'utf8'))
    if (!data || data.fp !== fp) return null
    const v = data.value
    if (!v || !Array.isArray(v.nodes) || !Array.isArray(v.edges)) return null
    return v
  } catch { return null }
}

function writeGraphCache(root, fp, value) {
  try {
    const payload = JSON.stringify({ fp, at: Date.now(), value })
    if (payload.length > GRAPH_CACHE_MAX_BYTES) return
    const file = graphCachePath(root)
    const tmp = file + '.' + process.pid + '.tmp'
    fs.writeFileSync(tmp, payload)
    fs.renameSync(tmp, file)
  } catch { /* 缓存写失败不影响功能 */ }
}

function graphFingerprint(db) {
  const c = db.prepare('SELECT COUNT(*) n, MAX(updated_at) m, SUM(id) s FROM cards').get()
  const st = db.prepare('SELECT status, COUNT(*) n FROM cards GROUP BY status').all()
  const log = db.prepare('SELECT MAX(id) id FROM audit_log').get()
  let upd = 0
  try { upd = db.prepare('SELECT MAX(id) id FROM card_updates').get().id || 0 } catch { /* 老库无此表 */ }
  return [c.n, c.m || '', c.s || 0, st.map((r) => `${r.status}:${r.n}`).join(','), log.id || 0, upd].join('|')
}

/** 图谱：节点 = 卡片；边 = [[wikilink]] 或共享标签。 */
export async function graph(root) {
  const db = getDb(root)
  const fp = graphFingerprint(db)
  const hit = graphCache.get(root)
  if (hit && hit.fp === fp && Date.now() - hit.at < GRAPH_CACHE_TTL_MS) return hit.value
  // P0-1：内存未命中就查磁盘缓存（指纹一致即视为有效）
  const onDisk = readGraphCache(root, fp)
  if (onDisk) {
    graphCache.set(root, { fp, value: onDisk, at: Date.now() })
    if (process.env.MEMORY_GRAPH_PROFILE === '1') console.error('[memory-eternal] graph: 命中磁盘缓存')
    return onDisk
  }
  // 只选图谱需要的列，不读 body（大幅减少内存和传输量）。主库即 approved，无需状态条件。
  const rows = db.prepare('SELECT id, path, kind, title, tags, summary, status, updated_at FROM cards ORDER BY updated_at DESC').all()
  // body 单独按需读取（只在需要 wikilink 匹配时）
  const bodyRows = db.prepare('SELECT path, body FROM cards').all()
  const bodyMap = new Map(bodyRows.map((r) => [r.path, r.body]))
  const cards = rows.map((r) => ({
    path: r.path, kind: r.kind, title: r.title, tags: normalizeTags(r.tags),
    summary: r.summary || '', updated: r.updated_at, mtime: new Date(r.updated_at).getTime(), status: r.status,
  }))

  const byPath = new Map(cards.map((c) => [c.path, c]))

  const nodes = cards.map((c) => ({
    id: c.path,
    title: c.title,
    kind: c.kind,
    tags: c.tags,
    summary: c.summary.slice(0, 80),
    updated: c.updated,
    mtime: c.mtime,
    linkCount: 0,
  }))
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const addDegree = (p) => { const n = nodeById.get(p); if (n) n.linkCount++ }
  const edges = []
  const seen = new Set()
  const addEdge = (a, b, type) => {
    const key = [a, b].sort().join('|') + '|' + type
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ source: a, target: b, type })
  }

  for (const card of cards) {
    const text = bodyMap.get(card.path) || ''
    for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      const raw = m[1].trim().replace(/\.md$/, '')
      const candidates = [
        `${card.kind === 'knowledge' ? KIND_ROOTS.knowledge : KIND_ROOTS[card.kind]}/${raw}.md`,
        `${KIND_ROOTS.knowledge}/${raw}.md`,
        `${raw}.md`,
      ]
      for (const cand of candidates) {
        if (cand !== card.path && byPath.has(cand)) {
          addEdge(card.path, cand, 'link'); addDegree(card.path); addDegree(cand)
          break
        }
      }
      for (const other of cards) {
        if (other.path !== card.path && (other.title === raw || other.path.endsWith(`/${raw}.md`))) {
          addEdge(card.path, other.path, 'link'); addDegree(card.path); addDegree(other.path)
          break
        }
      }
    }
  }
  // 标签倒排（tag → paths，按 cards 顺序）：原先每个标签都要全表扫一遍，是 O(卡数²)
  const tagIndex = new Map()
  for (const c of cards) for (const t of c.tags) {
    const arr = tagIndex.get(t)
    if (arr) arr.push(c.path)
    else tagIndex.set(t, [c.path])
  }
  // 标签边：同标签「全连接」会爆炸 —— 593 卡时 2.4 万条边，占总 payload 的 99%，前端每帧都要遍历。
  // 改为「按共享标签数取 Top-K」：语义仍是「靠共享标签相邻」，但边数降一个数量级。
  // 对每张卡用标签倒排收集候选与其共享标签数，只保留权重最高的 K 个（双向去重后约 n*K/2 条）。
  const TAG_TOPK = 6
  const pairWeight = new Map() // `a\u0000b`（排序后）-> 已加边的共享标签数
  for (const card of cards) {
    const weights = new Map()
    for (const tag of card.tags) {
      for (const other of tagIndex.get(tag) || []) {
        if (other === card.path) continue
        weights.set(other, (weights.get(other) || 0) + 1)
      }
    }
    // 候选不超过 K 时全连（小库/小标签簇），超过才截断 Top-K
    const ranked = [...weights.entries()].sort((x, y) => y[1] - x[1])
    const top = weights.size <= TAG_TOPK ? ranked : ranked.slice(0, TAG_TOPK)
    for (const [other, w] of top) {
      const [x, y] = [card.path, other].sort()
      const key = `${x}\u0000${y}`
      if ((pairWeight.get(key) || 0) >= w) continue // 已按更高权重加过这条边
      pairWeight.set(key, w)
      const xc = byPath.get(x)
      const yc = byPath.get(y)
      const shared = xc && yc ? xc.tags.find((t) => yc.tags.includes(t)) : ''
      addEdge(x, y, shared ? `tag:${shared}` : 'tag')
    }
  }

  // 相似度关联（P0-3 + P1-1）：
  //   · bigram 一律用 32 位哈希入集合（构建与求交都比字符串快数倍，碰撞率可忽略）；
  //   · 候选来自两个互补来源：① 稀有 gram 倒排（按 df 计数排序，免每卡 sort 比较器）
  //     ② MinHash + LSH 分桶（补足「共享 gram 都很常见」的近重复对）；
  //   · 只对候选做**精确** Jaccard —— 判定语义与旧实现一致，只是不再全量配对。
  const SIM_THRESHOLD = 0.42
  const DF_CAP = 24
  const RARE_CAP = 120
  const CAND_CAP = 40
  const MH_K = 48
  const MH_BANDS = 24
  const MH_ROWS = 2
  const prof = process.env.MEMORY_GRAPH_PROFILE === '1'
  let tStage = Date.now()
  const hashesByPath = new Map()
  const gramDf = new Map()
  for (const c of cards) {
    const s = bigramHashSet(bodyMap.get(c.path) || '')
    hashesByPath.set(c.path, s)
    for (const g of s) gramDf.set(g, (gramDf.get(g) || 0) + 1)
  }
  const tHash = Date.now() - tStage
  // ① 稀有 gram 倒排：df ∈ [1, DF_CAP] 直接进桶（计数排序），再按桶取最稀的 RARE_CAP 个
  tStage = Date.now()
  const rareByPath = new Map()
  for (const c of cards) {
    const buckets = []
    for (let df = 0; df <= DF_CAP; df++) buckets.push(null)
    for (const g of hashesByPath.get(c.path)) {
      const df = gramDf.get(g) || 0
      if (df > DF_CAP) continue
      if (!buckets[df]) buckets[df] = []
      buckets[df].push(g)
    }
    const rare = []
    for (let df = 1; df <= DF_CAP && rare.length < RARE_CAP; df++) {
      const b = buckets[df]
      if (!b) continue
      for (const g of b) { rare.push(g); if (rare.length >= RARE_CAP) break }
    }
    rareByPath.set(c.path, rare)
  }
  const rareIndex = new Map()
  for (const c of cards) {
    for (const g of rareByPath.get(c.path)) {
      const arr = rareIndex.get(g)
      if (arr) arr.push(c.path)
      else rareIndex.set(g, [c.path])
    }
  }
  const tRare = Date.now() - tStage
  // ② MinHash + LSH：签名只跑「稀有 gram」（≤120/卡），成本可控且正好覆盖近重复场景
  tStage = Date.now()
  const signatures = new Map()
  for (const c of cards) signatures.set(c.path, minhashSignature(rareByPath.get(c.path), MH_K))
  const lshCands = lshCandidates(signatures, { bands: MH_BANDS, rows: MH_ROWS, maxPerCard: CAND_CAP })
  const tSig = Date.now() - tStage
  tStage = Date.now()
  const similarCount = {}
  const tagSetByPath = new Map(cards.map((c) => [c.path, new Set(c.tags)]))
  const merged = new Map()
  let jaccardCalls = 0
  for (const card of cards) {
    merged.clear()
    for (const gram of rareByPath.get(card.path)) {
      for (const other of rareIndex.get(gram) || []) {
        if (other !== card.path) merged.set(other, (merged.get(other) || 0) + 1)
      }
    }
    for (const other of lshCands.get(card.path) || []) {
      if (other !== card.path) merged.set(other, (merged.get(other) || 0) + 2)
    }
    if (!merged.size) continue
    const ranked = [...merged.entries()].sort((x, y) => y[1] - x[1])
    const cands = ranked.length <= CAND_CAP ? ranked : ranked.slice(0, CAND_CAP)
    const A = hashesByPath.get(card.path)
    for (const [other] of cands) {
      if ((similarCount[card.path] || 0) >= 1) break
      if ((similarCount[other] || 0) >= 1) continue
      const b = byPath.get(other)
      if (!b) continue
      if (b.kind !== card.kind && !card.tags.some((t) => tagSetByPath.get(other).has(t))) continue
      const B = hashesByPath.get(other)
      const lo = Math.min(A.size, B.size)
      const hi = Math.max(A.size, B.size)
      if (!hi || lo / hi < SIM_THRESHOLD) continue // 无损上界：J ≤ min/max
      jaccardCalls++
      const sim = jaccardSets(A, B, SIM_THRESHOLD)
      if (sim >= SIM_THRESHOLD) { addEdge(card.path, other, 'similar'); addDegree(card.path); addDegree(other); similarCount[card.path] = 1; similarCount[other] = 1; break }
    }
  }
  const tCand = Date.now() - tStage
  if (prof) console.error('[memory-eternal] graph profile: hash=' + tHash + 'ms rare=' + tRare + 'ms sig=' + tSig + 'ms cand=' + tCand + 'ms jaccardCalls=' + jaccardCalls)
  const value = { nodes, edges }
  graphCache.set(root, { fp, value, at: Date.now() })
  writeGraphCache(root, fp, value)
  if (graphCache.size > GRAPH_CACHE_MAX) graphCache.delete(graphCache.keys().next().value)
  return value
}

/** 统计（主库用量 + 隔离区计数，供侧栏徽标用）。 */
export async function stats(root) {
  const db = getDb(root)
  const totalRow = db.prepare('SELECT COUNT(*) as cnt FROM cards').get()
  const byKindRows = db.prepare('SELECT kind, COUNT(*) as cnt FROM cards GROUP BY kind').all()
  const byKind = Object.fromEntries(byKindRows.map((r) => [r.kind, r.cnt]))

  const now = new Date()
  const dayAgo = new Date(now.getTime() - 86400000).toISOString()
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString()
  const todayRow = db.prepare('SELECT COUNT(*) as cnt FROM cards WHERE updated_at >= ?').get(dayAgo)
  const weekRow = db.prepare('SELECT COUNT(*) as cnt FROM cards WHERE updated_at >= ?').get(weekAgo)
  const tagRows = db.prepare('SELECT tags FROM cards').all()
  const tagSet = new Set()
  for (const r of tagRows) { for (const t of normalizeTags(r.tags)) tagSet.add(t) }

  const todayCardsRows = db.prepare('SELECT * FROM cards WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT 30').all(dayAgo)
  const todayCards = todayCardsRows.map((row) => ({ path: row.path, title: row.title, kind: row.kind, updated: row.updated_at, summary: (row.summary || '').slice(0, 80) }))

  // 隔离区：审核排队情况（侧栏「审核中心」徽标直接读这里）
  const quarantineRows = db.prepare('SELECT status, COUNT(*) n FROM quarantine GROUP BY status').all()
  const quarantine = { pending: 0, rejected: 0, deleted: 0 }
  for (const r of quarantineRows) if (r.status in quarantine) quarantine[r.status] = r.n

  return {
    total: totalRow.cnt,
    today: todayRow.cnt,
    week: weekRow.cnt,
    tags: tagSet.size,
    byKind,
    todayCards,
    quarantine,
  }
}

/** 跨库聚合图谱。 */
export async function graphAll(roots) {
  const nodes = []; const edges = []; const idSet = new Set()
  for (const r of roots) {
    let g
    try { g = await graph(r.root) } catch { continue }
    const pref = r.name ? `${r.name}::` : ''
    const map = new Map()
    for (const n of g.nodes) { const id = pref + n.id; if (!idSet.has(id)) { idSet.add(id); map.set(n.id, id); nodes.push({ ...n, id }) } else map.set(n.id, id) }
    for (const e of g.edges) { const s = map.get(e.source) || (pref + e.source), t = map.get(e.target) || (pref + e.target); if (s && t) edges.push({ source: s, target: t, type: e.type }) }
  }
  return { nodes, edges }
}

// ---- 星球分层视图：按层请求的规划（纯函数，可单测）--------------------------------
//
// 为什么需要：2049 张卡一次性返回 nodes+edges（实测 2049 节点 / 10106 条边），
// 前端也一次性渲染全部节点 —— 首屏是一团墨点，既看不清也点不准，10k 时更不可能。
// 现在改成「一层一层看」：
//   · 根层按 kind 折叠：某类 >200 张 → 一颗带环大星球；≤200 张 → 逐颗小星球；
//     根层图元 >500 时把「最小的 kind」依次并进「其他」桶（每并一个类，图元数减少 size-1）；
//   · 进入某类 / 某个语义簇后：集合 ≤1000 张直接铺卡片；>1000 张按语义簇（标签优先）
//     拆成 ≤20 颗大星球，逐级下钻（每个大星球仍 >1000 时继续按同样规则拆）；
//   · 语义聚类没有有效信号（标签太散/没有标签）时回退：按权重（更新时间）等分 ≤20 块。
//
// 「这一层显示什么」全部是 planGraphLevel 这组纯函数算出来的：路由层只负责读库 + 缓存，
// 于是 10k 规模的分层规则能在单测里穷举，不必真的点进浏览器。
export const LEVEL_MAX_ITEMS = 1000 // 单层图元上限（再多就分簇）
export const ROOT_BIG_KIND_MIN = 200 // 某类 >200 张 → 一颗大星球（严格大于）
export const ROOT_MAX_ITEMS = 500 // 根层图元上限（超出 → 最小 kind 合并「其他」）
export const MAX_CLUSTERS = 20 // 一层最多几颗语义簇大星球
export const CLUSTER_TARGET_SIZE = 250 // 语义簇目标体量（决定分几簇）
export const LEVEL_EDGE_LIMIT = 2400 // 单层边上限（与 payload 红线一起兜住传输量）
export const PLANET_EDGE_LIMIT = 1200 // 星球层聚合边上限（共享标签关系网，卡片折叠后仍保留「连线」视觉）
export const LEVEL_PAYLOAD_LIMIT = 1024 * 1024 // 单次层响应 payload 上限：1MB

const LEVEL_KIND_LABELS = {
  core: '核心记忆', skill: '技能', project: '项目', knowledge: '知识', content: '内容',
  prompt: '提示词', business: '业务', tool: '工具', mistake: '教训', other: '其他',
}
const LEVEL_KIND_KEYS = {
  core: 'kindCore', skill: 'kindSkill', project: 'kindProject', knowledge: 'kindKnowledge',
  content: 'kindContent', prompt: 'kindPrompt', business: 'kindBusiness', tool: 'kindTool',
  mistake: 'kindMistake', other: 'graphOther',
}

/**
 * 分层请求的错误分类：调用方（lib/api.js）按 code 决定 HTTP 状态。
 *   LEVEL_PATH  —— 路径写错（客户端可纠正）→ 400 + 原文案
 *   LEVEL_STALE —— 语义簇已变化（卡片增删导致）→ 400 + 提示返回上一层
 * 其余异常一律视为「未知内部错误」→ 500 + 通用文案（细节只进日志）。
 */
export const LEVEL_ERR_PATH = 'LEVEL_PATH'
export const LEVEL_ERR_STALE = 'LEVEL_STALE'

function levelPathError(message) {
  const err = new Error(message)
  err.code = LEVEL_ERR_PATH
  return err
}

function levelStaleError(message) {
  const err = new Error(message)
  err.code = LEVEL_ERR_STALE
  return err
}

/**
 * 解析层级路径字符串（客户端 → 宿主的唯一寻址方式）。段之间用 `/` 分隔：
 *   k:<kind>            某一类（如 k:project）
 *   k:<kind1>,<kind2>   合并桶（如 k:content,mistake,skill → 「其他」）
 *   t:<tag>[#n]         按标签聚出来的语义簇（n = 大标签拆片序号）
 *   g:<n>               按权重等分出来的兜底块
 * 非法段直接抛错（调用方转成 400 + 明确文案），不做「猜一个」的兜底。
 */
export function parseLevelPath(pathStr) {
  const raw = String(pathStr == null ? '' : pathStr).trim()
  if (!raw) return []
  return raw.split('/').filter(Boolean).map((seg) => {
    if (seg.startsWith('k:')) {
      const kinds = seg.slice(2).split(',').map((s) => s.trim()).filter(Boolean)
      if (!kinds.length) throw levelPathError('层级路径缺少 kind：' + seg)
      return { type: 'kind', id: seg, kinds }
    }
    if (seg.startsWith('t:') || seg.startsWith('g:')) return { type: 'cluster', id: seg }
    throw levelPathError('无法识别的层级路径段：' + seg)
  })
}

/** 把段数组拼回路径字符串（客户端面包屑用它返回上层）。 */
export function encodeLevelPath(segments) {
  return (Array.isArray(segments) ? segments : []).map((s) => (typeof s === 'string' ? s : s && s.id)).filter(Boolean).join('/')
}

function levelCardItem(card) {
  return {
    type: 'card',
    id: String(card.id || card.path || ''),
    label: String(card.title || card.id || ''),
    kind: card.kind || 'other',
    updated: card.updated || '',
    tags: Array.isArray(card.tags) ? card.tags.slice(0, 8) : [],
  }
}

function levelPlanetItem({ id, kind, kinds, label, labelKey, count, by }) {
  return {
    type: 'planet',
    id,
    kind: kind || 'other',
    kinds: Array.isArray(kinds) && kinds.length > 1 ? kinds.slice() : null,
    label: label || '',
    labelKey: labelKey || '',
    count: Math.max(0, Math.floor(Number(count) || 0)),
    by: by || 'kind',
  }
}

/** 根层：按 kind 折叠 + 超限合并「其他」。纯函数，返回这一层的图元。 */
export function planRootLevel(cards, opts = {}) {
  const bigMin = opts.bigKindMin === undefined ? ROOT_BIG_KIND_MIN : opts.bigKindMin
  const rootMax = opts.rootMaxItems === undefined ? ROOT_MAX_ITEMS : opts.rootMaxItems
  const groups = new Map()
  for (const c of Array.isArray(cards) ? cards : []) {
    const kind = c.kind || 'other'
    const g = groups.get(kind)
    if (g) g.cards.push(c)
    else groups.set(kind, { kind, cards: [c] })
  }
  const bigGroups = []
  const smallGroups = []
  for (const g of groups.values()) (g.cards.length > bigMin ? bigGroups : smallGroups).push(g)
  // 先算账（不在数组里反复删除）：大类占 1 个图元，小类逐颗展开占 size 个
  let total = bigGroups.length
  for (const g of smallGroups) total += g.cards.length
  const merged = []
  const mergedSet = new Set()
  let mergedCount = 0
  const queue = smallGroups
    .map((g) => ({ kind: g.kind, size: g.cards.length }))
    .sort((a, b) => a.size - b.size || String(a.kind).localeCompare(String(b.kind)))
  while (total > rootMax && queue.length) {
    const g = queue.shift()
    merged.push(g.kind)
    mergedSet.add(g.kind)
    mergedCount += g.size
    // 这一类原来占 size 个图元（逐颗小星球）；并进「其他」后：
    //   少掉 size 个，同时「其他」桶自己第一次出现时占 1 个 —— 所以净减少 size，首次再 +1
    total -= g.size
    if (merged.length === 1) total += 1
  }
  // 保险（>500 个「大 kind」，实盘不会出现）：除最大的一类外全部并成一颗
  if (total > rootMax) {
    const bigLeft = bigGroups.filter((g) => !mergedSet.has(g.kind))
    if (bigLeft.length > 1) {
      const sorted = bigLeft.slice().sort((a, b) => a.cards.length - b.cards.length || String(a.kind).localeCompare(String(b.kind)))
      const keep = sorted[sorted.length - 1]
      for (const g of sorted) {
        if (g === keep) continue
        merged.push(g.kind)
        mergedSet.add(g.kind)
        mergedCount += g.cards.length
      }
      total = 1 + (mergedCount ? 1 : 0)
    }
  }
  const items = []
  for (const g of bigGroups) {
    if (mergedSet.has(g.kind)) continue
    items.push(levelPlanetItem({
      id: 'k:' + g.kind, kind: g.kind, label: LEVEL_KIND_LABELS[g.kind] || g.kind,
      labelKey: LEVEL_KIND_KEYS[g.kind] || 'kindKnowledge', count: g.cards.length, by: 'kind',
    }))
  }
  for (const g of smallGroups) {
    if (mergedSet.has(g.kind)) continue
    for (const c of g.cards) items.push(levelCardItem(c))
  }
  if (merged.length) {
    items.push(levelPlanetItem({
      id: 'k:' + merged.slice().sort().join(','), kinds: merged.slice().sort(), kind: 'other',
      label: '其他', labelKey: 'graphOther', count: mergedCount, by: 'merged',
    }))
  }
  return {
    mode: 'root',
    total: Array.isArray(cards) ? cards.length : 0,
    items,
    unit: 'root',
    bigKinds: bigGroups.filter((g) => !mergedSet.has(g.kind)).map((g) => g.kind),
    mergedKinds: merged.slice(),
    rootLimit: rootMax,
    bigKindMin: bigMin,
  }
}

function cardWeight(card) {
  const t = Number(card && (card.mtime || Date.parse(card.updated || '') || 0))
  return Number.isFinite(t) ? t : 0
}

function pickClusterKind(cards) {
  const counts = new Map()
  for (const c of cards) counts.set(c.kind || 'other', (counts.get(c.kind || 'other') || 0) + 1)
  let best = 'other'
  let n = -1
  for (const [k, v] of counts) if (v > n || (v === n && String(k) < String(best))) { best = k; n = v }
  return best
}

/**
 * 语义簇：标签优先，标签没有有效信号时按权重（更新时间）等分。
 * 返回的簇 id 是**确定性**的（同一份卡片集合必定得到同样的 id），所以下钻时能原样复算。
 * @param {Array<object>} cards
 * @param {{maxClusters?:number, targetSize?:number}} opts
 * @returns {Array<{id:string,label:string,kind:string,count:number,cards:Array<object>,by:string}>}
 */
export function planClusters(cards, opts = {}) {
  const list = Array.isArray(cards) ? cards : []
  const n = list.length
  if (!n) return []
  const maxClusters = Math.max(2, Math.floor(opts.maxClusters || MAX_CLUSTERS))
  const target = Math.max(1, Math.floor(opts.targetSize || CLUSTER_TARGET_SIZE))
  const wanted = Math.min(maxClusters, Math.max(2, Math.ceil(n / target)))
  const cap = Math.max(1, Math.ceil(n / wanted))
  const ordered = list.slice().sort((a, b) => cardWeight(b) - cardWeight(a) || String(a.id || '').localeCompare(String(b.id || '')))
  const tagCount = new Map()
  for (const c of ordered) for (const t of Array.isArray(c.tags) ? c.tags : []) tagCount.set(t, (tagCount.get(t) || 0) + 1)
  const tags = [...tagCount.entries()]
    .filter(([, cnt]) => cnt >= 2)
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
  // 语义信号门槛：最强的标签至少覆盖 2%（且 ≥3 张），否则「按标签分簇」只是把噪声切成小块
  const signal = tags.length > 0 && tags[0][1] >= Math.max(3, Math.ceil(n * 0.02))
  const clusters = []
  const assigned = new Set()
  if (signal) {
    // 给「没标签的卡」预留至少 1 个名额，否则它们会被标签簇挤掉
    const untagged = ordered.filter((c) => !(Array.isArray(c.tags) && c.tags.length)).length
    const tagBudget = Math.max(1, wanted - (untagged > 0 ? 1 : 0))
    for (const [tag] of tags) {
      if (clusters.length >= tagBudget) break
      const members = ordered.filter((c) => !assigned.has(c.id) && Array.isArray(c.tags) && c.tags.includes(tag))
      if (members.length < 2) continue
      for (let i = 0; i < members.length && clusters.length < tagBudget; i += cap) {
        const part = members.slice(i, i + cap)
        // 名额守恒：拿这一簇之后，剩下的卡还必须有地方放（每块 ≤ cap）。
        // 少了这一步，「最热的几个标签」会把 20 个名额吃光，剩下的卡最后挤成一颗巨球。
        const restAfter = n - assigned.size - part.length
        const slotsNeededAfter = Math.ceil(restAfter / cap)
        if (clusters.length + 1 + slotsNeededAfter > wanted) break
        for (const c of part) assigned.add(c.id)
        const partNo = i / cap + 1
        clusters.push({
          id: partNo === 1 ? 't:' + tag : 't:' + tag + '#' + partNo,
          label: partNo === 1 ? '#' + tag : '#' + tag + ' · ' + partNo,
          kind: pickClusterKind(part),
          count: part.length,
          cards: part,
          by: 'tag',
        })
      }
    }
  }
  // 剩下没被标签覆盖的卡：按权重等分成 ≤ 剩余名额 的若干块
  const rest = ordered.filter((c) => !assigned.has(c.id))
  if (rest.length) {
    const slots = Math.max(1, Math.min(maxClusters - clusters.length, Math.ceil(rest.length / cap)))
    const chunk = Math.ceil(rest.length / slots)
    for (let i = 0; i < rest.length; i += chunk) {
      const part = rest.slice(i, i + chunk)
      clusters.push({
        id: 'g:' + (clusters.length + 1),
        label: signal ? '其他卡片' : '第 ' + (clusters.length + 1) + ' 组',
        kind: pickClusterKind(part),
        count: part.length,
        cards: part,
        by: 'weight',
      })
    }
  }
  // 保险（标签拆片把名额用超时）：合并「最小的两颗」，不把某一颗喂成吞掉全库的巨兽
  while (clusters.length > maxClusters) {
    let i1 = 0
    for (let i = 1; i < clusters.length; i++) if (clusters[i].count < clusters[i1].count) i1 = i
    let i2 = i1 === 0 ? 1 : 0
    for (let i = 0; i < clusters.length; i++) if (i !== i1 && clusters[i].count < clusters[i2].count) i2 = i
    const a = Math.min(i1, i2)
    const b = Math.max(i1, i2)
    clusters[b].cards = clusters[b].cards.concat(clusters[a].cards)
    clusters[b].count += clusters[a].count
    clusters.splice(a, 1)
  }
  return clusters
}

/**
 * 星球层（根层 / 语义簇层）的聚合连线：按「共享标签」给可见图元连边。
 * 大星球用它成员卡片的标签并集参与，所以即使卡片被折叠，关系网也不会消失 ——
 * 这是旧版图谱最核心的视觉，星球层不能没有。纯函数，便于单测。
 * @param {Array<object>} items 本层图元（planet/card）
 * @param {{tagSets?:Map<string,Set<string>>, excludes?:Map<string,string>, limit?:number, maxPerNode?:number}} opts
 */
export function planetLevelEdges(items, opts = {}) {
  const limit = Math.max(0, Math.floor(opts.limit === undefined ? PLANET_EDGE_LIMIT : opts.limit))
  const maxPerNode = Math.max(1, Math.floor(opts.maxPerNode || 8))
  const tagSets = opts.tagSets || new Map()
  const excludes = opts.excludes || new Map()
  const list = (Array.isArray(items) ? items : []).filter((it) => it && it.id)
  const scored = []
  for (let i = 0; i < list.length; i++) {
    const a = list[i]
    const sa = tagSets.get(a.id)
    if (!sa || !sa.size) continue
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j]
      const sb = tagSets.get(b.id)
      if (!sb || !sb.size) continue
      const exA = excludes.get(a.id)
      const exB = excludes.get(b.id)
      let score = 0
      let shared = ''
      for (const t of sa) {
        if (t === exA || t === exB) continue
        if (sb.has(t)) { score += 1; if (!shared) shared = t }
      }
      if (score > 0) scored.push({ a: a.id, b: b.id, score, tag: shared })
    }
  }
  // 分数高的先连；每个图元最多 maxPerNode 条，避免少数热标签把整层连成毛线球
  scored.sort((x, y) => y.score - x.score || String(x.a).localeCompare(String(y.a)) || String(x.b).localeCompare(String(y.b)))
  const deg = new Map()
  const seen = new Set()
  const edges = []
  for (const s of scored) {
    const da = deg.get(s.a) || 0
    const db = deg.get(s.b) || 0
    if (da >= maxPerNode || db >= maxPerNode) continue
    const key = s.a < s.b ? s.a + '\u0000' + s.b : s.b + '\u0000' + s.a
    if (seen.has(key)) continue
    seen.add(key)
    deg.set(s.a, da + 1)
    deg.set(s.b, db + 1)
    edges.push({ source: s.a, target: s.b, type: 'tag', tag: s.tag, weight: s.score })
    if (edges.length >= limit) break
  }
  return edges
}

/** 层内边：共享标签 TopK 连边（与全量图谱同一语义，只是限流到 LEVEL_EDGE_LIMIT 条）。 */
export function levelEdges(items, opts = {}) {
  const limit = Math.max(0, Math.floor(opts.limit === undefined ? LEVEL_EDGE_LIMIT : opts.limit))
  const perTag = Math.max(2, Math.floor(opts.perTag || 6))
  const byTag = new Map()
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.type !== 'card') continue
    for (const t of Array.isArray(it.tags) ? it.tags : []) {
      const arr = byTag.get(t)
      if (arr) arr.push(it.id)
      else byTag.set(t, [it.id])
    }
  }
  const seen = new Set()
  const edges = []
  for (const [tag, ids] of byTag) {
    if (ids.length < 2) continue
    const k = Math.min(perTag, ids.length)
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const a = String(ids[i])
        const b = String(ids[j])
        const key = a < b ? a + '\u0000' + b : b + '\u0000' + a
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ source: ids[i], target: ids[j], type: 'tag', tag })
        if (edges.length >= limit) return edges
      }
    }
  }
  return edges
}

/**
 * 算出「这一层该显示什么」。纯函数：传入全部卡片 + 路径段，返回图元、面包屑、统计。
 * @param {Array<{id:string,title:string,kind:string,tags:string[],updated:string,mtime?:number}>} cards
 * @param {Array<string|{type:string,id:string,kinds?:string[]}>} segments
 * @param {{maxItems?:number,rootMaxItems?:number,bigKindMin?:number,maxClusters?:number,targetSize?:number,edgeLimit?:number}} opts
 */
export function planGraphLevel(cards, segments = [], opts = {}) {
  const all = Array.isArray(cards) ? cards : []
  const maxItems = Math.max(1, Math.floor(opts.maxItems || LEVEL_MAX_ITEMS))
  const parsed = (Array.isArray(segments) ? segments : []).map((s) => (typeof s === 'string' ? parseLevelPath(s)[0] : s)).filter(Boolean)
  let scope = all
  const crumbs = [{ id: '', label: '全部', labelKey: 'graphAllCrumb', path: '', kinds: null, count: all.length }]
  for (const seg of parsed) {
    const prev = crumbs[crumbs.length - 1]
    const nextPath = prev.path ? prev.path + '/' + seg.id : seg.id
    if (seg.type === 'kind') {
      scope = scope.filter((c) => seg.kinds.includes(c.kind || 'other'))
      const single = seg.kinds.length === 1
      crumbs.push({
        id: seg.id,
        label: single ? (LEVEL_KIND_LABELS[seg.kinds[0]] || seg.kinds[0]) : '其他',
        labelKey: single ? (LEVEL_KIND_KEYS[seg.kinds[0]] || 'kindKnowledge') : 'graphOther',
        path: nextPath,
        kinds: seg.kinds,
        count: scope.length,
      })
    } else {
      const clusters = planClusters(scope, { maxClusters: opts.maxClusters, targetSize: opts.targetSize })
      const hit = clusters.find((cl) => cl.id === seg.id)
      // 卡片集合变了（新增/删除）→ 旧簇 id 失效：明确报错，让客户端回到上一层重取，而不是显示空层
      if (!hit) throw levelStaleError('语义簇已变化，请返回上一层重试：' + seg.id)
      scope = hit.cards
      crumbs.push({ id: seg.id, label: hit.label, labelKey: '', path: nextPath, kinds: null, count: scope.length })
    }
  }
  const levelId = parsed.map((s) => s.id).join('/')
  let level
  let clusterList = null
  if (!parsed.length) {
    const root = planRootLevel(all, opts)
    level = { id: '', ...root }
  } else if (scope.length <= maxItems) {
    level = {
      id: levelId,
      mode: 'cards',
      total: scope.length,
      unit: 'card',
      items: scope.map((c) => levelCardItem(c)),
    }
  } else {
    clusterList = planClusters(scope, { maxClusters: opts.maxClusters, targetSize: opts.targetSize })
    level = {
      id: levelId,
      mode: 'clusters',
      total: scope.length,
      unit: 'cluster',
      items: clusterList.map((cl) => levelPlanetItem({
        // 图元 id 就是路径段（t:tag / g:1）：下钻时原样拼进 path，宿主按同一份集合复算即可
        id: cl.id, kind: cl.kind, label: cl.label, labelKey: '', count: cl.count, by: cl.by,
      })),
      clusterIds: clusterList.map((cl) => cl.id),
    }
  }
  // 连线是旧版图谱的核心视觉，星球层也不能省：用「共享标签」把可见图元连起来。
  // 大星球的标签取它成员卡片的并集；语义簇层排除「簇名本身的标签」，否则同源簇会全部两两相连。
  let edges
  if (level.mode === 'cards') {
    edges = levelEdges(level.items, { limit: opts.edgeLimit })
  } else {
    const tagSets = new Map()
    const excludes = new Map()
    if (level.mode === 'root') {
      const byKind = new Map()
      for (const c of all) {
        const k = c.kind || 'other'
        const arr = byKind.get(k)
        if (arr) arr.push(c)
        else byKind.set(k, [c])
      }
      for (const it of level.items) {
        if (it.type === 'card') {
          tagSets.set(it.id, new Set(Array.isArray(it.tags) ? it.tags : []))
        } else {
          const kinds = Array.isArray(it.kinds) && it.kinds.length ? it.kinds : [String(it.id).slice(2)]
          const set = new Set()
          for (const k of kinds) for (const c of byKind.get(k) || []) for (const t of c.tags || []) set.add(t)
          tagSets.set(it.id, set)
        }
      }
    } else {
      for (const it of level.items) {
        const cl = clusterList && clusterList.find((x) => x.id === it.id)
        const set = new Set()
        for (const c of (cl ? cl.cards : [])) for (const t of c.tags || []) set.add(t)
        tagSets.set(it.id, set)
        const m = String(it.id).match(/^t:([^#]+)/)
        if (m) excludes.set(it.id, m[1])
      }
    }
    edges = planetLevelEdges(level.items, { tagSets, excludes, limit: opts.planetEdgeLimit })
  }
  return {
    path: levelId,
    crumbs,
    level: { ...level, edges },
    stats: {
      items: level.items.length,
      edges: edges.length,
      total: all.length,
      scope: scope.length,
      maxItems,
      rootLimit: opts.rootMaxItems === undefined ? ROOT_MAX_ITEMS : opts.rootMaxItems,
      maxClusters: opts.maxClusters === undefined ? MAX_CLUSTERS : opts.maxClusters,
    },
  }
}

// 分层接口的缓存：按（库 + 指纹 + 路径）失效，不是 TTL —— 任何写卡都会改变指纹。
// 上界是双重的（条数 + 字节）：单层响应最大 1MB，只按条数限（48 条）最坏也要 ~48MB，
// 热缓存不该这么吃内存。超预算时从最久未用的那条开始淘汰。
export const LEVEL_CACHE_MAX = 48
export const LEVEL_CACHE_MAX_BYTES = 16 * 1024 * 1024
export const LEVEL_CARDS_CACHE_MAX_ROOTS = 8
const levelCache = new Map() // cacheKey -> { payload, bytes }
const levelCardsCache = new Map() // root -> { fp, cards }
let levelCacheBytes = 0
// 生效中的上界：生产恒为上面的常量；单测用 setLevelCacheLimits() 临时收紧来验证淘汰逻辑。
let levelLimitEntries = LEVEL_CACHE_MAX
let levelLimitBytes = LEVEL_CACHE_MAX_BYTES

/** 测试/诊断用：清空分层缓存（不影响图谱主缓存，也不动上界）。 */
export function resetLevelCache() {
  levelCache.clear()
  levelCardsCache.clear()
  levelCacheBytes = 0
}

/**
 * 只读缓存账本：条数与字节数都必须有界（回归测试直接断言它）。
 * @returns {{levelEntries:number, levelBytes:number, levelMaxEntries:number, levelMaxBytes:number, cardsRoots:number, cardsMaxRoots:number}}
 */
export function levelCacheStats() {
  return {
    levelEntries: levelCache.size,
    levelBytes: levelCacheBytes,
    levelMaxEntries: levelLimitEntries,
    levelMaxBytes: levelLimitBytes,
    cardsRoots: levelCardsCache.size,
    cardsMaxRoots: LEVEL_CARDS_CACHE_MAX_ROOTS,
  }
}

/**
 * 测试/诊断用：临时调整缓存上界（生产默认 48 条 / 16MB；传 0/缺省表示恢复默认）。
 * 用来在单测里用很小的预算验证「字节上限会触发淘汰」，不必真的灌满 16MB。
 * @returns 生效后的上界
 */
export function setLevelCacheLimits(opts = {}) {
  const max = Math.floor(Number(opts.maxEntries))
  const maxBytes = Math.floor(Number(opts.maxBytes))
  levelLimitEntries = Number.isFinite(max) && max > 0 ? max : LEVEL_CACHE_MAX
  levelLimitBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : LEVEL_CACHE_MAX_BYTES
  while (levelCache.size > levelLimitEntries) evictOldestLevelCache()
  while (levelCacheBytes > levelLimitBytes && levelCache.size > 0) evictOldestLevelCache()
  return { maxEntries: levelLimitEntries, maxBytes: levelLimitBytes }
}

function evictOldestLevelCache() {
  const oldest = levelCache.keys().next().value
  if (oldest === undefined) return
  const rec = levelCache.get(oldest)
  levelCache.delete(oldest)
  if (rec) levelCacheBytes -= rec.bytes
}

function levelCacheGet(key) {
  const hit = levelCache.get(key)
  if (!hit) return null
  // LRU：Map 的插入序就是淘汰序，命中即刷新热度
  levelCache.delete(key)
  levelCache.set(key, hit)
  return hit
}

function levelCacheSet(key, payload, bytes) {
  const prev = levelCache.get(key)
  if (prev) {
    levelCacheBytes -= prev.bytes
    levelCache.delete(key)
  }
  levelCache.set(key, { payload, bytes })
  levelCacheBytes += bytes
  // 条数上限 / 字节上限：从最久未用的那条开始淘汰
  while (levelCacheBytes > levelLimitBytes && levelCache.size > 1) evictOldestLevelCache()
  while (levelCache.size > levelLimitEntries) evictOldestLevelCache()
  // 单条本身就超预算：连它也不留（本次响应照常返回）—— 保证字节账永远有界
  if (levelCacheBytes > levelLimitBytes) {
    const rec = levelCache.get(key)
    if (rec) {
      levelCache.delete(key)
      levelCacheBytes -= rec.bytes
    }
  }
}

function readLevelCards(db) {
  // 只取分层需要的列（不读 body）：10k 卡时整表扫描仍是个位数毫秒
  const rows = db.prepare('SELECT path, kind, title, tags, updated_at FROM cards').all()
  return rows.map((r) => ({
    id: r.path,
    path: r.path,
    title: r.title || '',
    kind: r.kind || 'other',
    tags: normalizeTags(r.tags),
    updated: r.updated_at || '',
    mtime: new Date(r.updated_at || 0).getTime() || 0,
  }))
}

function levelCardsFor(roots) {
  const entries = []
  for (const r of roots) {
    const db = getDb(r.root)
    const fp = graphFingerprint(db)
    // 与 graphCache 同款：键是**库根**，命中后再比对指纹。
    // 旧实现把指纹拼进 key —— 每写一张卡指纹就变，于是每次写卡都白留一整份全库卡片
    // （10k 卡时是几 MB/次），长期运行等于慢性泄漏。
    let entry = levelCardsCache.get(r.root)
    if (!entry || entry.fp !== fp) {
      entry = { fp, cards: readLevelCards(db) }
      levelCardsCache.delete(r.root)
      levelCardsCache.set(r.root, entry)
      while (levelCardsCache.size > LEVEL_CARDS_CACHE_MAX_ROOTS) {
        const oldest = levelCardsCache.keys().next().value
        levelCardsCache.delete(oldest)
      }
    } else {
      // LRU：同一个库刚用过，挪到队尾
      levelCardsCache.delete(r.root)
      levelCardsCache.set(r.root, entry)
    }
    entries.push({ name: r.name || '', fp, cards: entry.cards })
  }
  const fingerprint = entries.map((e) => (e.name || '') + ':' + e.fp).join('|')
  const cards = []
  const seen = new Set()
  for (const e of entries) {
    const pref = e.name ? e.name + '::' : ''
    for (const c of e.cards) {
      const id = pref + c.id
      if (seen.has(id)) continue
      seen.add(id)
      cards.push(pref ? { ...c, id, path: id } : c)
    }
  }
  return { fingerprint, cards }
}

/**
 * 分层图谱：一次只返回「一层」的图元（≤1000）与层内边，客户端按层请求。
 * 与 graph() 的关系：graph() 仍是全量图（导出/诊断/兼容旧客户端），分层视图只走这里。
 * @param {string} root 当前库根
 * @param {{path?:string, roots?:Array<{name:string,root:string}>, plan?:object}} opts
 * @returns {Promise<{ok:true, path:string, crumbs:Array, level:object, stats:object}>}
 */
export async function graphLevel(root, opts = {}) {
  const started = Date.now()
  const pathStr = String(opts.path == null ? '' : opts.path).trim()
  const roots = Array.isArray(opts.roots) && opts.roots.length ? opts.roots : [{ name: '', root }]
  const segments = parseLevelPath(pathStr) // 非法路径直接抛（调用方转 400）
  const { fingerprint, cards } = levelCardsFor(roots)
  const cacheKey = fingerprint + '\u0000' + pathStr
  const hit = levelCacheGet(cacheKey)
  if (hit) return { ...hit.payload, stats: { ...hit.payload.stats, cached: true, ms: Date.now() - started } }
  const plan = planGraphLevel(cards, segments, opts.plan || {})
  // payload 守卫：先砍边；极端情况下（图元本身过大）如实标记 truncated，绝不静默假装没事
  let bytes = Buffer.byteLength(JSON.stringify({ ok: true, ...plan }))
  let edgesTrimmed = false
  while (bytes > LEVEL_PAYLOAD_LIMIT && plan.level.edges.length > 0) {
    plan.level.edges.length = Math.floor(plan.level.edges.length / 2)
    edgesTrimmed = true
    bytes = Buffer.byteLength(JSON.stringify({ ok: true, ...plan }))
  }
  const payload = {
    ok: true,
    ...plan,
    stats: {
      ...plan.stats,
      edges: plan.level.edges.length,
      edgesTrimmed,
      bytes,
      ms: Date.now() - started,
      cached: false,
      payloadLimit: LEVEL_PAYLOAD_LIMIT,
    },
  }
  levelCacheSet(cacheKey, payload, bytes)
  return payload
}

/** 跨库聚合检索。 */
export async function searchAll(roots, query, opts = {}) {
  const out = []
  for (const r of roots) {
    let hits
    try { hits = await search(r.root, query, opts) } catch { continue }
    const pref = r.name ? `${r.name}::` : ''
    for (const h of hits) out.push({ ...h, path: pref + h.path, score: (h.score || 0) + (r.name ? 0 : 0), profile: r.name || '' })
  }
  out.sort((a, b) => b.score - a.score || b.mtime - a.mtime)
  return out.slice(0, opts.limit || 30)
}

/** 整理建议（非破坏性预览）。 */
export async function optimizeCandidates(root) {
  const db = getDb(root)
  const rows = db.prepare("SELECT * FROM cards WHERE status = 'approved' ORDER BY updated_at DESC").all()
  const cards = rows.map(rowToCard)
  const bodyMap = new Map(rows.map((r) => [r.path, (r.body || '').slice(0, 4000)]))

  const merge = []
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j]
    if (a.kind !== b.kind) continue
    const sim = textSimilarity(bodyMap.get(a.path) || '', bodyMap.get(b.path) || '')
    if (sim >= 0.55) merge.push({ a: { path: a.path, title: a.title }, b: { path: b.path, title: b.title }, sim: Math.round(sim * 100) / 100 })
  }
  merge.sort((x, y) => y.sim - x.sim)
  const old = Date.now() - 90 * 86400000
  const stale = cards.filter((c) => c.mtime < old).slice(0, 30).map((c) => ({ path: c.path, title: c.title, updated: c.updated }))
  return { merge: merge.slice(0, 40), stale }
}

/** 一键优化执行。 */
export async function optimizeApply(root, opts = {}) {
  const simThreshold = Number(opts.simThreshold ?? 0.55)
  const staleDays = Number(opts.staleDays ?? 90)
  const cleanupStale = Boolean(opts.cleanupStale)
  const dryRun = Boolean(opts.dryRun)
  const cands = await optimizeCandidates(root)
  // issue #36：**被判为矛盾的对绝不参与盲合并** —— 相似度高不等于可以合并，两张互斥的卡合并
  // 会把冲突悄悄"和解"掉（且 mergeCards 会永久删除源卡）。决策来自「矛盾扫描」的 refine-decisions.json。
  const { readDecisions } = await import('./refine.js')
  const decided = readDecisions(root)
  const merge = cands.merge.filter((p) => {
    const key = [String(p.a.path), String(p.b.path)].sort().join(' | ')
    const d = decided[key]
    return !(d && (d.relation === 'conflict' || d.action === 'keepBoth'))
  })
  const stale = cands.stale
  const merged = []
  const staleDeleted = []
  const staleSkipped = []
  const errors = []
  const used = new Set()
  for (const pair of merge) {
    if (used.has(pair.a.path) || used.has(pair.b.path)) continue
    if (pair.sim < simThreshold) continue
    if (!dryRun) {
      try {
        const r = await mergeCards(root, [pair.a.path, pair.b.path])
        if (r && r.ok) {
          merged.push({ from: [pair.a.path, pair.b.path], to: r.path, sim: pair.sim })
          used.add(pair.a.path); used.add(pair.b.path)
        } else { errors.push(`merge ${pair.a.path}+${pair.b.path}: ${r?.error || '失败'}`) }
      } catch (e) { errors.push(`merge ${pair.a.path}+${pair.b.path}: ${e?.message || e}`) }
    } else {
      merged.push({ from: [pair.a.path, pair.b.path], to: '(dry-run)', sim: pair.sim })
      used.add(pair.a.path); used.add(pair.b.path)
    }
  }
  if (cleanupStale) {
    for (const s of stale) {
      if (!dryRun) {
        try { await deleteCard(root, s.path); staleDeleted.push(s.path) } catch (e) { errors.push(`delete ${s.path}: ${e?.message || e}`); staleSkipped.push(s.path) }
      } else { staleDeleted.push(s.path) }
    }
  } else {
    for (const s of stale) staleSkipped.push(s.path)
  }
  return {
    ok: true,
    dryRun,
    plan: { merged: merged.length, staleDeleted: staleDeleted.length, staleSkipped: staleSkipped.length },
    merged,
    staleDeleted,
    staleSkipped,
    errors,
  }
}

/** 读取反馈记录。 */
export async function readFeedback(root) {
  const db = getDb(root)
  const rows = db.prepare('SELECT * FROM feedback ORDER BY created_at DESC').all()
  return rows.map((r) => ({ ts: new Date(r.created_at).getTime(), query: r.query, path: r.card_path, useful: r.useful }))
}

/** 添加反馈。 */
export async function addFeedback(root, rec) {
  const db = getDb(root)
  db.prepare('INSERT INTO feedback (query, card_path, useful) VALUES (?, ?, ?)').run(
    rec.query || '',
    rec.path || rec.card_path || '',
    rec.useful ? 1 : 0,
  )
  return { ok: true }
}

/**
 * 概览：主库（正常区）+ 隔离区（异常区）两份统计。
 *
 * `total` / `byKind` / `recent` / `tags` 描述**主库**（agent 能看到的那部分）；
 * `status` / `quarantine` 描述隔离区（审核中心与回收站）。
 */
export async function overview(root) {
  const db = getDb(root)
  const cards = await listCards(root, { status: [MAIN_STATUS] })
  const byKind = {}
  const statusCounts = {}
  for (const c of cards) { byKind[c.kind] = (byKind[c.kind] || 0) + 1; statusCounts[c.status] = (statusCounts[c.status] || 0) + 1 }
  const week = Date.now() - 7 * 86400000
  const recent = cards.filter((c) => c.mtime > week).length
  const tagSet = new Set()
  for (const c of cards) for (const t of c.tags) tagSet.add(t)

  // 隔离区统计：按状态 + 按 kind
  const quarantined = await listCards(root, { status: [...QUARANTINE_STATUSES] })
  const quarantine = { pending: 0, rejected: 0, deleted: 0, total: quarantined.length }
  const quarantineByKind = {}
  for (const c of quarantined) {
    if (c.status in quarantine) quarantine[c.status] += 1
    quarantineByKind[c.kind] = (quarantineByKind[c.kind] || 0) + 1
  }

  return {
    total: cards.length,
    byKind,
    recent,
    tags: tagSet.size,
    status: statusCounts,
    quarantine,
    quarantineByKind,
    roots: Object.fromEntries(Object.entries(KIND_ROOTS).map(([k, v]) => [k, `${v}/`])),
  }
}

// -- helpers ---------------------------------------------------------------

function resolveInside(root, rel) {
  const target = path.resolve(root, rel)
  const rootResolved = path.resolve(root)
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) return null
  return target
}

async function exists(p) {
  try {
    const { promises: fs } = await import('node:fs')
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function yamlString(value) {
  const s = String(value ?? '')
  return /[:#\[\]{}"',&*!|>%@`]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}
