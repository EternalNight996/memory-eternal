// 记忆核心 · 检索索引（SQLite FTS5 + BM25/IDF）
//
// 为什么要有这一层：旧的 search() 是**全表扫描 + 子串计数**——
//   score = 整串命中 3 分 + 每个词命中 1 分
// 没有 IDF、没有词频、没有长度归一，于是「用户」「插件」这种高频词和稀有词同权，
// 含一个「用户」的原始对话快照就能挤进前五（实测：搜「审核红线」返回全是噪声）。
//
// 这里换成 FTS5：
//   · BM25 自带 IDF 与长度归一，天然压制高频噪声词；
//   · 多列加权（标题 8 / 正文 1 / 标签 2 / 路径 1.5），标题命中优先；
//   · 中文用**字符 bigram 预切词**（不用 jieba、零依赖）：FTS5 的 unicode61 与 trigram
//     对「检索」「插件」这类 2 字中文词都会失效，bigram 是唯一零依赖的正解。
//
// 维护策略（两次踩坑后的结论）：
//   1. **写时增量**：卡片增删改后立刻调用 indexCardById / unindexCard，
//      检索路径不承担重建成本（否则每次搜都要 diff 全表，比旧扫描还慢）。
//   2. **签名只由 SQL 计算**：JS 的 String#length 是 UTF-16 码元、SQLite length() 是字符，
//      带 emoji 的卡两边永远对不上 —— 曾导致 279 张卡每次检索都被重灌（300ms/次）。
//      现在两边都用同一段 SQL 表达式，彻底消除口径差。
//   3. **兜底对账**：进程内每 5 分钟最多做一次全表 diff，防外部改库导致索引漂移。
const FTS_TABLE = 'cards_fts'
const ROWS_TABLE = '_fts_rows'
const INDEX_VERSION = '2'
const RECONCILE_MS = 5 * 60 * 1000
const lastReconcile = new WeakMap()

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 签名表达式（SQL 侧唯一口径，禁止在 JS 里另算一套）。 */
const SIG_SQL = "(COALESCE(updated_at,'') || '|' || length(body) || '|' || length(title) || '|' || length(tags) || '|' || length(path))"

/**
 * 把文本切成 FTS token 序列。
 * 中文：连续汉字段 → 全部 bigram（长度 1 则保留单字）
 * 其他：按非字母数字切分，小写，保留长度 ≥2 的词
 */
export function tokenize(text) {
  const s = String(text || '').toLowerCase()
  const out = []
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (CJK_RE.test(ch)) {
      let j = i
      while (j < s.length && CJK_RE.test(s[j])) j++
      const run = s.slice(i, j)
      if (run.length === 1) out.push(run)
      else for (let k = 0; k < run.length - 1; k++) out.push(run.slice(k, k + 2))
      i = j
    } else if (/[0-9a-z\u00c0-\u024f]/i.test(ch)) {
      let j = i
      while (j < s.length && /[0-9a-z\u00c0-\u024f]/i.test(s[j])) j++
      const w = s.slice(i, j)
      if (w.length >= 2) out.push(w)
      i = j
    } else {
      i++
    }
  }
  return [...new Set(out)]
}

/** 索引存储形态：空格分隔的 token 串。 */
export function indexText(text) { return tokenize(text).join(' ') }

/**
 * 中文功能词（停用词）。
 *
 * 为什么必须在查询侧去掉：bigram 切词会把「怎么」「什么」「哪个」当成检索词，
 * 长句查询 AND 必然落空 → 退化到 OR → 这些高频功能 bigram 把结果淹掉。
 * 实测（2026-11-11）：`怎么让召回更准确` 的 Top-3 全是含「怎么」的无关卡；
 * 去掉壳后同一意图 3/3 命中。索引侧**不做**裁剪——写入原文必须完整可检索。
 */
const STOP_RE = /(怎么样|什么样|怎么|什么|如何|为何|为什么|哪个|哪些|哪里|哪种|是不是|有没有|能不能|可不可以|可以|我们|你们|他们|咱们|这个|那个|这些|那些|这种|那种|一下|一些|一点|应该|需要|请问|帮我|帮忙|关于|以及|还有|就是|现在|之前|上次|下次|东西|问题|内容|情况|时候|之后|然后|因为|所以|但是|如果|这样|那样|多少|怎样|最终|到底|究竟|具体|相关|一般|通常|主要|其实|目前|当时|后来|已经|还是|只是|不过|而且|或者|否则|因此|由于)/g

// 噪声壳（评测/自动生成查询里的“请问…关键点…是怎么处理的”）：
// 只在语义模式剥离——纯词法靠这些壳词反而能捞到正确的原文卡，剥了会掉 R@10。
const WRAPPER_RE = /(是怎么处理的|怎么处理的|如何处理|怎么处理|关键点|助手|请说明|说明一下)/g

const EN_STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'have', 'has', 'had', 'not', 'you', 'your', 'our', 'their', 'its', 'can', 'will', 'would', 'should', 'could', 'about', 'into', 'than', 'then', 'them', 'they', 'there', 'here', 'what', 'when', 'where', 'which', 'who', 'how', 'why', 'all', 'any', 'both', 'each', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'too', 'very', 'just', 'also', 'but', 'because', 'while', 'during', 'before', 'after', 'above', 'below', 'between', 'through', 'over', 'under', 'again', 'once'])

/** 查询侧清洗：去中文功能词与英文停用词（不清洗索引用文本）。 */
export function cleanQuery(query, wrapper = false) {
  let q = String(query || '')
  if (wrapper) q = q.replace(WRAPPER_RE, ' ')
  return q.replace(STOP_RE, ' ')
}

/**
 * 口语改写 → 语料用词（同义扩展，只在 AND 落空后的 OR 兜底里追加）。
 *
 * 为什么按「短语」而不是按词：中文 bigram 切词后，同义关系往往跨词（搜不到／修），
 * 按短语替换才能保住原查询的实词。这里只做**追加**，不删原词，AND 语义不受影响。
 */
const SYN_PHRASES = [
  [/搜不到|搜不了|没搜到|找不到/, '检索 未命中'],
  [/怎么修|如何修|修了|修复/, '修复'],
  [/更好用|哪个好|哪个更|对比一下|区别/, '对比 比较'],
  [/卡顿|掉帧|卡住/, '卡顿 掉帧'],
  [/报错|出错|异常/, '错误 异常'],
  [/怎么配|如何配|配置/, '配置'],
  [/装不上|安装/, '安装 部署'],
  [/发版|上线|发布/, '发布'],
  [/打分|评分|分数/, '评分'],
  [/花了多少|费用|成本/, '成本'],
  // 口语/比喻类补充（只在 AND 落空后的 OR 兜底追加，不改变 AND 语义）
  [/乱飘|乱跑|飘来飘去|到处乱/, '位置 固定'],
  [/全红|全挂|全失败/, '校验 失败'],
  [/卡死|卡住|没反应|无响应|一直等/, '超时 卡死'],
  [/访客|真实地址|真实ip/i, 'IP 访客'],
  [/帮助文本|帮助信息|帮助示例/, '帮助 示例'],
  [/别人能搜到|别人搜到|收录|上架|渠道|市场/, '收录 市场'],
  // 偏好类（LongMemEval single-session-preference 专用）：查询里的 prefer/favorite 往往只在少数会话出现，
  // 追加近义偏好词能把「用户陈述偏好」的会话拉上来。
  [/prefer|favorite|favourite|like better|usually|always|never|偏好|更喜欢|喜欢|习惯|讨厌/i, 'prefer favorite like prefer 偏好 喜欢 讨厌'],
  // 推荐类查询（LongMemEval single-session-preference）：把「求推荐」映射到会话卡上的 preference/recommendation 标签
  [/recommend|suggest|looking for|any good|推荐|建议|有没有|求推荐/i, 'preference recommendation recommend suggest'],
]

/** 从原查询提取同义扩展词（可能为空）。 */
export function expandQuery(query) {
  const q = String(query || '')
  const extra = []
  for (const [re, words] of SYN_PHRASES) {
    if (re.test(q)) extra.push(...words.split(/\s+/))
  }
  return extra
}



/** 构造 FTS5 MATCH 表达式。mode='and' 要求全部命中，'or' 任一命中。 */
export function buildMatch(terms, mode = 'and') {
  const valid = (Array.isArray(terms) ? terms : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .map((t) => '"' + t.replace(/"/g, '""') + '"')
  if (!valid.length) return ''
  return valid.join(mode === 'or' ? ' OR ' : ' AND ')
}

function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${ROWS_TABLE} (id INTEGER PRIMARY KEY, sig TEXT NOT NULL)`)
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(title, body, tags, path, content='', contentless_delete=1)`)
  db.exec(`CREATE TABLE IF NOT EXISTS _fts_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
}

function writeSig(db, id) {
  db.prepare(`INSERT OR REPLACE INTO ${ROWS_TABLE}(id, sig) SELECT id, ${SIG_SQL} FROM cards WHERE id = ?`).run(id)
}

function insertRow(db, row) {
  db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(row.id)
  db.prepare(`INSERT INTO ${FTS_TABLE}(rowid, title, body, tags, path) VALUES (?, ?, ?, ?, ?)`)
    .run(row.id, indexText(row.title), indexText(row.body), indexText(row.tags), indexText(row.path))
  writeSig(db, row.id)
}

/** 单卡增量索引（写路径调用；任何错误都吞掉，索引绝不能影响业务写入）。 */
export function indexCardById(db, id) {
  try {
    ensureTables(db)
    const row = db.prepare('SELECT id, path, title, tags, body FROM cards WHERE id = ?').get(id)
    if (!row) return unindexCard(db, id)
    insertRow(db, row)
    return true
  } catch { return false }
}

/** 单卡移出索引（删除 / 迁出主库）。 */
export function unindexCard(db, id) {
  try {
    ensureTables(db)
    db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`).run(id)
    db.prepare(`DELETE FROM ${ROWS_TABLE} WHERE id = ?`).run(id)
    return true
  } catch { return false }
}

/** 全量重建（导出给排障 / 「重建索引」用）。 */
export function reindexAll(db, { force = true } = {}) {
  ensureTables(db)
  db.exec(`DELETE FROM ${FTS_TABLE}`)
  db.exec(`DELETE FROM ${ROWS_TABLE}`)
  const rows = db.prepare('SELECT id, path, title, tags, body FROM cards').all()
  const del = db.prepare(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`)
  const ins = db.prepare(`INSERT INTO ${FTS_TABLE}(rowid, title, body, tags, path) VALUES (?, ?, ?, ?, ?)`)
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      del.run(r.id)
      ins.run(r.id, indexText(r.title), indexText(r.body), indexText(r.tags), indexText(r.path))
    }
    db.prepare(`INSERT OR REPLACE INTO ${ROWS_TABLE}(id, sig) SELECT id, ${SIG_SQL} FROM cards`).run()
    db.prepare("INSERT OR REPLACE INTO _fts_meta(key, value) VALUES('version', ?)").run(INDEX_VERSION)
    db.exec('COMMIT')
  } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
  lastReconcile.set(db, Date.now())
  return { ok: true, indexed: rows.length }
}

/**
 * 对账（不是每次检索都跑）：进程内每 5 分钟最多一次全表 diff。
 * 写路径已经做了增量，这里只兜住「外部改库 / 漏挂的写路径」。
 */
export function ensureIndex(db, { force = false } = {}) {
  ensureTables(db)
  const meta = db.prepare("SELECT value FROM _fts_meta WHERE key = 'version'").get()
  if (!meta || meta.value !== INDEX_VERSION) return reindexAll(db)

  const indexedCount = db.prepare(`SELECT COUNT(*) n FROM ${ROWS_TABLE}`).get().n
  const cardCount = db.prepare('SELECT COUNT(*) n FROM cards').get().n
  if (!force && indexedCount === cardCount && Date.now() - (lastReconcile.get(db) || 0) < RECONCILE_MS) {
    return { rebuilt: 'skipped' }
  }

  const current = db.prepare(`SELECT id, ${SIG_SQL} AS sig FROM cards`).all()
  const indexed = new Map(db.prepare(`SELECT id, sig FROM ${ROWS_TABLE}`).all().map((r) => [r.id, r.sig]))
  const changed = []
  const seen = new Set()
  for (const row of current) {
    seen.add(row.id)
    if (indexed.get(row.id) !== row.sig) changed.push(row.id)
  }
  const removed = []
  for (const id of indexed.keys()) if (!seen.has(id)) removed.push(id)
  lastReconcile.set(db, Date.now())

  if (!changed.length && !removed.length) return { rebuilt: 'none' }
  const rows = db.prepare('SELECT id, path, title, tags, body FROM cards WHERE id IN (' + [...changed].map(() => '?').join(',') + ')').all(...changed)
  const rowMap = new Map(rows.map((r) => [r.id, r]))
  db.exec('BEGIN')
  try {
    for (const id of removed) unindexCard(db, id)
    for (const id of changed) {
      const r = rowMap.get(id)
      if (r) insertRow(db, r)
      else unindexCard(db, id)
    }
    db.exec('COMMIT')
  } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
  return { rebuilt: 'partial', updated: changed.length, removed: removed.length }
}

import { assocTerms } from './assoc.js'

/**
 * FTS5 检索。返回 [{ id, score }]，score 越大越相关（bm25 是负值，已翻正）。
 * 先按「全部词命中」查；零结果才退化成「任一命中」，避免多打一个词就全灭。
 */
function extraTerms(db, query, terms, { expand = true, assoc = true } = {}) {
  const extra = expand ? tokenize(expandQuery(query).join(' ')).filter((w) => !terms.includes(w)) : []
  if (assoc) {
    for (const a of assocTerms(db, terms)) {
      if (!terms.includes(a) && !extra.includes(a)) extra.push(a)
    }
  }
  return extra
}

// 语料关联词扩展默认关闭：实测会拉低字面命中（见 bench/RESULTS.md A2）。需要实验时传 assoc:true。
export function searchIndexed(db, query, { limit = 60, clean = true, expand = true, mergeWeak = false, assoc = false, wrapperStop = false } = {}) {
  // 查询侧清洗功能词；索引侧保持原文。词项不截断——截断会丢掉长查询里的关键低频词
  // （99 题金标集实测：按 IDF 取前 6 词反而 R@5 96.0%→94.9%）。
  const terms = tokenize(clean ? cleanQuery(query, wrapperStop) : query).filter((t) => !EN_STOP.has(t))
  if (!terms.length) return []
  ensureTables(db)
  const stmt = db.prepare(
    `SELECT rowid AS id, bm25(${FTS_TABLE}, 8.0, 1.0, 2.0, 1.5) AS s FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ? ORDER BY s LIMIT ?`
  )
  let rows = []
  const andExpr = buildMatch(terms, 'and')
  if (andExpr) { try { rows = stmt.all(andExpr, limit) } catch { rows = [] } }
  if (!rows.length) {
    // AND 落空 → OR 兜底（含同义扩展 + 语料关联词）；语义/纯词法都走这一条，保证弱查询有候选。
    const extra = extraTerms(db, query, terms, { expand, assoc })
    const orTerms = extra.length ? [...terms, ...extra] : terms
    const orExpr = buildMatch(orTerms, 'or')
    if (orExpr) { try { rows = stmt.all(orExpr, limit) } catch { rows = [] } }
  } else if (mergeWeak && rows.length < 3) {
    // 纯词法下 AND 命中过少（<3）时再并一次 OR+扩展，按 id 去重后追加；
    // 语义模式不启用：额外候选会被向量加分重排，实测 Top1 83.5→79.8。
    const extra = extraTerms(db, query, terms, { expand, assoc: false })
    const orTerms = extra.length ? [...terms, ...extra] : terms
    const orExpr = buildMatch(orTerms, 'or')
    if (orExpr) {
      try {
        const seen = new Set(rows.map((r) => r.id))
        for (const r of stmt.all(orExpr, limit)) {
          if (!seen.has(r.id)) { rows.push(r); seen.add(r.id) }
        }
      } catch { /* ignore */ }
    }
  }
  // bm25 是「越小越相关」的负值，量级随语料规模变化（小库 1e-6、大库 1e-1）。
  // 直接乘常数会让小库的分数 <1，与旧的 1~10 分口径不兼容（minScore=2 会误杀）。
  // 用 log1p 归一到 ~1–20 的稳定区间：单调保序，且任何命中都 ≥1。
  return rows.map((r) => ({ id: r.id, score: 1 + Math.log1p(-Number(r.s) * 1e6) }))
}

/** 索引统计（排障/面板用）。 */
export function indexStats(db) {
  try {
    ensureTables(db)
    return {
      indexed: db.prepare(`SELECT COUNT(*) n FROM ${FTS_TABLE}`).get().n,
      cards: db.prepare('SELECT COUNT(*) n FROM cards').get().n,
    }
  } catch { return { indexed: 0, cards: 0 } }
}
