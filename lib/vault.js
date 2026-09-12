// 记忆核心 · SQLite Vault 存储层
//
// 纯工具函数保持不变；IO 函数全部改用 SQL。
// 底层依赖 lib/db.js 的 getDb(root) → DatabaseSync 实例。

import path from 'node:path'
import { getDb, enforceAudit } from './db.js'

/** 主题目录根。 */
export const KIND_ROOTS = {
  project: '02-Projects',
  knowledge: '03-Knowledge',
  content: '04-Content',
  prompt: '05-Prompts',
  business: '06-Business',
  tool: '07-Tools',
  mistake: '08-Mistakes',
}

export const CAPTURE_KINDS = ['project', 'knowledge', 'content', 'prompt', 'business', 'tool', 'mistake']

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

/** 在目标目录中找与候选文本最相似的现有卡（去重守卫）。比较正文。 */
export async function dedupCheck(root, text, threshold = 0.62) {
  const db = getDb(root)
  const rows = db.prepare('SELECT path, body FROM cards WHERE deleted_at IS NULL').all()
  let best = null
  for (const row of rows) {
    const score = textSimilarity(text, row.body || '')
    if (score >= threshold && (!best || score > best.score)) best = { path: row.path, score }
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
    tags: JSON.parse(row.tags || '[]'),
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
  const tags = JSON.parse(row.tags || '[]')
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

/** WHERE 组装：状态白名单 + 可选 kind / agent。 */
function cardsWhere({ want, kind, agent }) {
  const args = [...want]
  let where = `status IN (${want.map(() => '?').join(',')})`
  if (kind) { where += ' AND kind = ?'; args.push(kind) }
  if (agent) where += ' AND ' + agentWhere(agent, args)
  return { where, args }
}

/** 标题排序用的中文排序器（拼音 + 数字感知）；固定 zh-Hans-CN，避免随进程 locale 漂移。 */
export const TITLE_COLLATOR = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/**
 * 列出卡片（从 SQL）。
 * @param opts.status  状态白名单（默认 approved）
 * @param opts.kind    类型过滤（SQL）
 * @param opts.agent   署名过滤（服务端归一，如 deepseek-harness / claude）
 * @param opts.limit   返回条数上限（缺省=全部，供内部调用保持原语义）
 * @param opts.offset  偏移（配合 limit 做真分页）
 * @param opts.sort    'recent'（updated_at DESC，默认）| 'title'（拼音升序，跨页全局有序）
 */
export async function listCards(root, { status, kind, agent, limit, offset = 0, sort = 'recent' } = {}) {
  const want = status ?? ['approved']
  const db = getDb(root)
  const { where, args } = cardsWhere({ want, kind, agent })
  if (sort === 'title') {
    // SQLite 的 ORDER BY 是 UTF-8 字节序，中文标题看着就是乱的 → 只取 path/title 用拼音排好，
    // 再回表取这一页的正文（避免为了排序把所有正文读进内存）。
    const light = db.prepare(`SELECT path, title FROM cards WHERE ${where}`).all(...args)
    light.sort((a, b) => TITLE_COLLATOR.compare(a.title || '', b.title || ''))
    const start = Math.max(0, offset | 0)
    const page = Number.isInteger(limit) && limit > 0 ? light.slice(start, start + limit) : light.slice(start)
    if (page.length === 0) return []
    const ph = page.map(() => '?').join(',')
    const rows = db.prepare(`SELECT * FROM cards WHERE path IN (${ph})`).all(...page.map((r) => r.path))
    const byPath = new Map(rows.map((r) => [r.path, rowToCard(r)]))
    return page.map((r) => byPath.get(r.path)).filter(Boolean)
  }
  if (Number.isInteger(limit) && limit > 0) {
    const rows = db.prepare(`SELECT * FROM cards WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...args, limit, Math.max(0, offset | 0))
    return rows.map(rowToCard)
  }
  const rows = db.prepare(`SELECT * FROM cards WHERE ${where} ORDER BY updated_at DESC`).all(...args)
  return rows.map(rowToCard)
}

/** 计数（分页接口要用 total 判断还有没有下一页）。 */
export async function countCards(root, { status, kind, agent } = {}) {
  const db = getDb(root)
  const { where, args } = cardsWhere({ want: status ?? ['approved'], kind, agent })
  return db.prepare(`SELECT COUNT(*) n FROM cards WHERE ${where}`).get(...args).n
}

/** 审核队列：status=pending 或 rejected。 */
export async function auditQueue(root) {
  const cards = await listCards(root, { status: ['pending', 'rejected'] })
  return { pending: cards.filter((c) => c.status === 'pending'), rejected: cards.filter((c) => c.status === 'rejected') }
}

/** 回收站：status=deleted，按 deleted_at 倒序。 */
export async function recycleList(root) {
  const db = getDb(root)
  const rows = db.prepare('SELECT * FROM cards WHERE status = ? ORDER BY deleted_at DESC').all('deleted')
  return rows.map(rowToCard)
}

/** 清理超过 retentionDays 天的回收卡（永久删除）。 */
export async function purgeExpired(root, retentionDays = 30) {
  const db = getDb(root)
  const cut = new Date(Date.now() - retentionDays * 86400000).toISOString()
  const rows = db.prepare('SELECT path FROM cards WHERE status = ? AND deleted_at IS NOT NULL AND deleted_at < ?').all('deleted', cut)
  let purged = 0
  for (const row of rows) {
    try { await deleteCard(root, row.path, { permanent: true }); purged++ } catch {}
  }
  return { ok: true, purged }
}

/** 读取一张卡（返回 Markdown 文本，兼容旧调用方）。 */
export async function readCard(root, rel) {
  const db = getDb(root)
  const row = db.prepare('SELECT * FROM cards WHERE path = ?').get(rel)
  if (!row) throw new Error('卡片不存在: ' + rel)
  const { text } = rowToMarkdown(row)
  // 附加更新记录
  const updates = db.prepare('SELECT content, created_at FROM card_updates WHERE card_id = ? ORDER BY created_at ASC').all(row.id)
  if (updates.length > 0) {
    const updateLines = updates.map((u) => `- ${u.created_at.slice(0, 10)}：${u.content}`)
    return text + '\n## 更新记录\n\n' + updateLines.join('\n') + '\n'
  }
  return text
}

/** 软删卡片：status=deleted + deleted_at。 */
export async function deleteCard(root, rel, { permanent = false } = {}) {
  const db = getDb(root)
  if (permanent) {
    db.prepare('DELETE FROM cards WHERE path = ?').run(rel)
    return { ok: true, permanent: true }
  }
  const now = new Date().toISOString()
  const info = db.prepare('UPDATE cards SET status = ?, deleted_at = ?, updated_at = ? WHERE path = ?').run('deleted', now, now, rel)
  if (info.changes === 0) throw new Error('卡片不存在: ' + rel)
  return { ok: true, soft: true }
}

/** 恢复软删卡：status=approved，清除 deleted_at。写审计日志。 */
export async function restoreCard(root, rel) {
  const db = getDb(root)
  const now = new Date().toISOString()
  const existing = db.prepare('SELECT status FROM cards WHERE path = ?').get(rel)
  if (!existing) throw new Error('卡片不存在: ' + rel)
  const info = db.prepare('UPDATE cards SET status = ?, deleted_at = NULL, updated_at = ? WHERE path = ?').run('approved', now, rel)
  if (info.changes === 0) throw new Error('卡片不存在: ' + rel)
  db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)').run(rel, existing.status, 'approved', 'restore', '回收站恢复')
  return { ok: true, restored: true }
}

/** 更新卡状态（审核操作）。写审计日志，确保可追溯。 */
export async function setCardStatus(root, rel, status, { changedBy = 'system', reason = '' } = {}) {
  const db = getDb(root)
  const now = new Date().toISOString()
  const existing = db.prepare('SELECT status FROM cards WHERE path = ?').get(rel)
  if (!existing) throw new Error('卡片不存在: ' + rel)
  const info = db.prepare('UPDATE cards SET status = ?, updated_at = ? WHERE path = ?').run(status, now, rel)
  if (info.changes === 0) throw new Error('卡片不存在: ' + rel)
  // 审计日志：记录每次 status 变更
  db.prepare('INSERT INTO audit_log (card_path, old_status, new_status, changed_by, reason) VALUES (?, ?, ?, ?, ?)').run(rel, existing.status, status, changedBy, reason)
  return { ok: true, status }
}

/** 原子写卡；先去重，命中返回 {duplicate}。审核守卫在数据库层强制。 */
export async function writeCard(root, { kind, title, tags = [], body, source = '', status = 'pending', submittedBy = '', severity = 'info', reason = '', deletedAt = '' }, { threshold = 0.62, dedup = true } = {}) {
  const db = getDb(root)
  const kindRoot = KIND_ROOTS[kind] || KIND_ROOTS.knowledge

  // 审核守卫：数据库层强制，调用方传的 status 仅作 fallback
  const enforcedStatus = enforceAudit(root, kind, submittedBy, status)

  if (dedup) {
    const hit = await dedupCheck(root, body, threshold)
    if (hit) return { ok: false, duplicate: { ...hit, path: hit.path } }
  }

  const slug = safeSlug(title)
  let rel = `${kindRoot}/${slug}.md`
  let index = 2
  while (db.prepare('SELECT 1 FROM cards WHERE path = ?').get(rel)) {
    rel = `${kindRoot}/${slug}-${index}.md`
    index++
  }

  const now = new Date().toISOString()
  const summary = body.trim().slice(0, 200)
  db.prepare(`
    INSERT INTO cards (path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rel,
    kind,
    title,
    JSON.stringify(tags),
    body.trim(),
    summary,
    enforcedStatus,
    source,
    submittedBy,
    severity,
    reason,
    now,
    now,
    deletedAt || null,
  )
  return { ok: true, path: rel, kind }
}

/** 向已存在的卡追加更新记录。 */
export async function appendUpdate(root, rel, updateText) {
  const db = getDb(root)
  const row = db.prepare('SELECT id FROM cards WHERE path = ?').get(rel)
  if (!row) throw new Error('卡片不存在: ' + rel)
  const now = new Date().toISOString()
  db.prepare('INSERT INTO card_updates (card_id, content, created_at) VALUES (?, ?, ?)').run(row.id, updateText.trim(), now)
  db.prepare('UPDATE cards SET updated_at = ? WHERE id = ?').run(now, row.id)
  return { ok: true, path: rel, updated: now }
}

/** 合并多张卡为一张。 */
export async function mergeCards(root, paths) {
  const list = (Array.isArray(paths) ? paths : []).map((p) => String(p || '').trim()).filter(Boolean)
  if (list.length < 2) return { ok: false, error: '至少选 2 张卡' }
  const db = getDb(root)

  const rows = []
  for (const p of list) {
    const row = db.prepare('SELECT * FROM cards WHERE path = ?').get(p)
    if (row) rows.push(row)
  }
  if (rows.length < 2) return { ok: false, error: '读取失败' }

  const first = rows[0]
  const tags = new Set(JSON.parse(first.tags || '[]'))
  let combined = ''
  rows.forEach((row, i) => {
    const rowTags = JSON.parse(row.tags || '[]')
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
  const rows = db.prepare("SELECT * FROM cards WHERE status = 'approved' ORDER BY updated_at DESC").all()
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

/** 导出全部卡片原始 Markdown。 */
export async function exportCards(root) {
  const db = getDb(root)
  const rows = db.prepare('SELECT * FROM cards ORDER BY updated_at DESC').all()
  return rows.map((row) => {
    const { text } = rowToMarkdown(row)
    return { path: row.path, title: row.title, kind: row.kind, text }
  })
}

// 图谱缓存：一次生成约 300ms（301 卡），重复请求（多客户端/切页重开）直接命中。
// 失效用「指纹」而不是 TTL 兜底：卡数 + 更新时间 + 状态直方图 + 审计日志/更新记录水位，
// 任何写卡、审核、删卡、追加更新都会改变指纹 → 不存在脏读。
const GRAPH_CACHE_MAX = 4
const GRAPH_CACHE_TTL_MS = 5 * 60 * 1000
const graphCache = new Map() // root -> { fp, value, at }

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
  // 只选图谱需要的列，不读 body（大幅减少内存和传输量）
  const rows = db.prepare("SELECT id, path, kind, title, tags, summary, status, updated_at FROM cards WHERE status = 'approved' ORDER BY updated_at DESC").all()
  // body 单独按需读取（只在需要 wikilink 匹配时）
  const bodyRows = db.prepare("SELECT path, body FROM cards WHERE status = 'approved'").all()
  const bodyMap = new Map(bodyRows.map((r) => [r.path, r.body]))
  const cards = rows.map((r) => ({
    path: r.path, kind: r.kind, title: r.title, tags: JSON.parse(r.tags || '[]'),
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
  for (const card of cards) {
    for (const tag of card.tags) {
      for (const other of tagIndex.get(tag) || []) {
        if (other !== card.path) addEdge(card.path, other, `tag:${tag}`)
      }
    }
  }

  // 相似度关联：bigram 集合只算一次（原先每对都重新分词两段正文＝指数级白烧），
  // 再用数学上界剪枝（J ≤ min/max）跳过长度比过小的配对。
  const SIM_THRESHOLD = 0.42
  const bigramsByPath = new Map()
  for (const c of cards) bigramsByPath.set(c.path, bigramSet(bodyMap.get(c.path) || ''))
  const similarCount = {}
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) {
    const a = cards[i], b = cards[j]
    if (a.kind !== b.kind && !a.tags.some((t) => b.tags.includes(t))) continue
    if ((similarCount[a.path] || 0) >= 1 || (similarCount[b.path] || 0) >= 1) continue
    const sim = jaccardSets(bigramsByPath.get(a.path), bigramsByPath.get(b.path), SIM_THRESHOLD)
    if (sim >= SIM_THRESHOLD) { addEdge(a.path, b.path, 'similar'); addDegree(a.path); addDegree(b.path); similarCount[a.path] = (similarCount[a.path] || 0) + 1; similarCount[b.path] = (similarCount[b.path] || 0) + 1 }
  }
  const value = { nodes, edges }
  graphCache.set(root, { fp, value, at: Date.now() })
  if (graphCache.size > GRAPH_CACHE_MAX) graphCache.delete(graphCache.keys().next().value)
  return value
}

/** 统计。 */
export async function stats(root) {
  const db = getDb(root)
  const totalRow = db.prepare("SELECT COUNT(*) as cnt FROM cards WHERE status = 'approved'").get()
  const byKindRows = db.prepare("SELECT kind, COUNT(*) as cnt FROM cards WHERE status = 'approved' GROUP BY kind").all()
  const byKind = Object.fromEntries(byKindRows.map((r) => [r.kind, r.cnt]))

  const now = new Date()
  const dayAgo = new Date(now.getTime() - 86400000).toISOString()
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString()
  const todayRow = db.prepare("SELECT COUNT(*) as cnt FROM cards WHERE status = 'approved' AND updated_at >= ?").get(dayAgo)
  const weekRow = db.prepare("SELECT COUNT(*) as cnt FROM cards WHERE status = 'approved' AND updated_at >= ?").get(weekAgo)
  const tagRows = db.prepare("SELECT tags FROM cards WHERE status = 'approved'").all()
  const tagSet = new Set()
  for (const r of tagRows) { for (const t of JSON.parse(r.tags || '[]')) tagSet.add(t) }

  const todayCardsRows = db.prepare("SELECT * FROM cards WHERE status = 'approved' AND updated_at >= ? ORDER BY updated_at DESC LIMIT 30").all(dayAgo)
  const todayCards = todayCardsRows.map((row) => ({ path: row.path, title: row.title, kind: row.kind, updated: row.updated_at, summary: (row.summary || '').slice(0, 80) }))

  return {
    total: totalRow.cnt,
    today: todayRow.cnt,
    week: weekRow.cnt,
    tags: tagSet.size,
    byKind,
    todayCards,
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
  const merge = cands.merge
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

/** 统计：按 kind + status。 */
export async function overview(root) {
  const db = getDb(root)
  const cards = await listCards(root, { status: ['approved', 'pending', 'rejected'] })
  const byKind = {}
  const statusCounts = {}
  for (const c of cards) { byKind[c.kind] = (byKind[c.kind] || 0) + 1; statusCounts[c.status] = (statusCounts[c.status] || 0) + 1 }
  const week = Date.now() - 7 * 86400000
  const recent = cards.filter((c) => c.mtime > week).length
  const tagSet = new Set()
  for (const c of cards) for (const t of c.tags) tagSet.add(t)
  return {
    total: cards.length,
    byKind,
    recent,
    tags: tagSet.size,
    status: statusCounts,
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
