/**
 * 语料挖掘的关联词扩展（零依赖：只读本地 SQLite 的 term_assoc 表）。
 *
 * 用途：手写同义词典覆盖不了「卡死/超时」「乱飘/位置」这类领域说法；
 * 从 2943 张卡的标题/标签共现里挖关联词，查询时只追加高置信关联词（OR 兜底路径）。
 */
export function ensureAssocTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS term_assoc (
    term TEXT NOT NULL,
    assoc TEXT NOT NULL,
    score REAL NOT NULL,
    n INTEGER NOT NULL,
    PRIMARY KEY (term, assoc)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_term_assoc_term ON term_assoc(term, score DESC)')
}

/** 查询词的关联词；表不存在/没命中时返回 []。 */
export function assocTerms(db, tokens, { per = 1, max = 3 } = {}) {
  const out = []
  try {
    const stmt = db.prepare('SELECT assoc, score FROM term_assoc WHERE term = ? ORDER BY score DESC LIMIT ?')
    for (const t of tokens) {
      if (!t || out.length >= max) continue
      for (const r of stmt.all(t, per)) {
        if (r.assoc && r.assoc !== t && !out.includes(r.assoc)) out.push(r.assoc)
        if (out.length >= max) break
      }
    }
  } catch { /* 未建表按无关联词处理 */ }
  return out
}

export function assocStats(db) {
  try {
    const r = db.prepare('SELECT COUNT(*) AS terms, COUNT(DISTINCT term) AS vocab FROM term_assoc').get()
    return { terms: Number(r?.terms || 0), vocab: Number(r?.vocab || 0) }
  } catch { return { terms: 0, vocab: 0 } }
}
