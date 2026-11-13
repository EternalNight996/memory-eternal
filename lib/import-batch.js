// 批量导入引擎：把「一条条写、每条都全量比对」换成「整片哈希判重 + 单事务批写」。
//
// 原实现的三个瓶颈（针对几万条）：
//   ① 20MB 请求体上限 —— 几万张卡直接超限，导入失败
//   ② 逐条 `writeCard` → 每条都 `mainStoreBodies()` 读**主库全部正文**做比对，
//      两万张卡就是两万次全表读 + 几十 MB 常驻
//   ③ 每条 insert 单独提交，几千次 fsync
//
// 这里的分片策略：
//   · 客户端按 CHUNK_SIZE 分多次请求（每片独立事务，失败可续传）
//   · 每片先把 hash 一次算完，再一条 `IN (...)` 查出哪些已存在（O(1) 判断）
//   · 片内用 Set 防同批自相残杀（同一份备份里本来就有重复时，保留第一份）
//   · 写库时跳过相似度比对（备份是真相源，近似判重会误丢数据）——只做精确 hash 去重

import { contentHash } from './card-hash.js'
import { writeCard, parseCard } from './vault.js'
import { getDb } from './db.js'

/** 每片默认条数。太小则请求多，太大则单次事务过长（WAL 下 2000 条约几十毫秒）。 */
export const CHUNK_SIZE = 1000

/** 单次请求体上限（分片后仍要防滥用；1 万条 × 1KB ≈ 10MB）。 */
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024

/** 从各种备份形状里取卡片数组。 */
export function extractCards(payload) {
  if (Array.isArray(payload)) return payload
  if (payload && Array.isArray(payload.cards)) return payload.cards
  return null
}

/**
 * 查一批 hash 里哪些已经在库里（主库 + 隔离区，**不带 status 过滤**：
 * 已存在就够判重，不必区分它在哪个区）。
 * @returns {Set<string>}
 */
function existingHashes(db, hashes) {
  const out = new Set()
  if (!hashes.length) return out
  const uniq = [...new Set(hashes.filter(Boolean))]
  // SQLite 的变量上限（默认 32766）内分批查
  const BATCH = 500
  for (let i = 0; i < uniq.length; i += BATCH) {
    const slice = uniq.slice(i, i + BATCH)
    const ph = slice.map(() => '?').join(',')
    try {
      for (const r of db.prepare(`SELECT content_hash h FROM cards WHERE content_hash IN (${ph})`).all(...slice)) out.add(r.h)
      for (const r of db.prepare(`SELECT content_hash h FROM quarantine WHERE content_hash IN (${ph})`).all(...slice)) out.add(r.h)
    } catch { /* 老库没这一列：退化为不判重，写入仍安全 */ }
  }
  return out
}

/**
 * 导入一片卡片。
 *
 * @param {string} root 库根目录
 * @param {object[]} cards 本片的卡片（原始备份条目）
 * @param {{chunkIndex?:number, totalChunks?:number, preexisting?:Set<string>}} [opts]
 * @returns {Promise<{imported:number, skipped:number, quarantined:number, duplicate:number, failed:object[], done:boolean}>}
 */
export async function importChunk(root, cards, opts = {}) {
  const list = Array.isArray(cards) ? cards : []
  const db = getDb(root)
  const result = { imported: 0, skipped: 0, quarantined: 0, duplicate: 0, failed: [], done: true }
  let bad = 0 // 空正文 / 写入失败 / 条目非法（duplicate 以外被跳过的）

  // ① 先解析出每条的最终 (kind, title, body, status, ...)，再统一算 hash
  const parsed = list.map((c, idx) => {
    if (!c || typeof c !== 'object') return { idx, bad: '条目不是对象' }
    const text = c.text || ''
    let kind = c.kind || 'knowledge'
    let title = c.title || '导入记忆'
    let tags = []
    let body = text
    let source = ''
    let status = c.status || 'approved'
    let deletedAt = c.deletedAt || null
    // 备份里的条目可能是「整卡 markdown」（带 frontmatter），需要拆出来；
    // 拆失败就按原文当正文，不丢数据。
    try {
      const p = parseCard(text)
      kind = (p.meta && p.meta.kind) || kind
      title = (p.meta && p.meta.title) || title
      tags = (p.meta && p.meta.tags) || tags
      body = p.body !== undefined ? p.body : body
      source = (p.meta && p.meta.source) || source
    } catch { /* 用的就是原文 */ }
    return { idx, kind, title, tags, body, source, status, deletedAt, raw: c }
  })

  // ② 一次查出已存在的 hash（含调用方给的 preexisting 快照）
  const hashes = parsed.map((p) => (p.bad ? '' : contentHash(p.title, p.body)))
  const seen = new Set(opts.preexisting ? [...opts.preexisting] : [])
  for (const h of existingHashes(db, hashes)) seen.add(h)

  // ③ 单事务批写
  let inTx = false
  try { db.exec('BEGIN'); inTx = true } catch { inTx = false }

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]
    if (p.bad) { bad++; result.failed.push({ index: p.idx, reason: p.bad }); continue }
    if (!String(p.body || '').trim()) {
      bad++
      result.failed.push({ index: p.idx, title: String(p.title).slice(0, 60), reason: '正文为空' })
      continue
    }
    const h = hashes[i]
    if (h && seen.has(h)) {
      // 重复：主库/隔离区已有，或本片前面刚写过。
      // `duplicate` 是 `skipped` 的一个子集（skipped = duplicate + 空正文 + 写入失败），
      // 这样前端既能显示"跳过 N 条"，也能单独说"其中 M 条是重复"。
      result.duplicate++
      continue
    }
    try {
      // dedupAgainst: [] → 跳过相似度比对（备份是真相源，只做精确去重）
      const r = await writeCard(root, {
        kind: p.kind, title: p.title, tags: p.tags, body: p.body,
        source: p.source, status: p.status, deletedAt: p.deletedAt,
      }, { dedupAgainst: [], dedup: false })
      if (r.ok) {
        result.imported++
        if (r.store === 'quarantine') result.quarantined++
        if (h) seen.add(h)
      } else {
        bad++
        result.failed.push({ index: p.idx, title: String(p.title).slice(0, 60), reason: r.duplicate ? '已存在（内容重复）' : (r.error || '写入失败') })
      }
    } catch (e) {
      bad++
      result.failed.push({ index: p.idx, title: String(p.title).slice(0, 60), reason: String((e && e.message) || e) })
    }
  }

  if (inTx) { try { db.exec('COMMIT') } catch { try { db.exec('ROLLBACK') } catch { /* 忽略 */ } } }
  // skipped 语义：= duplicate + bad（duplicate 是它的子集，前端可分开显示）
  result.skipped = result.duplicate + bad
  result.failed = result.failed.slice(0, 50)
  result.bad = bad
  return result
}

/** 导入前的 hash 基线快照（只在「一次性全量导入」时用；分片导入不需要）。 */
export function hashSnapshot(root) {
  const db = getDb(root)
  const out = new Set()
  try {
    for (const r of db.prepare("SELECT content_hash h FROM cards WHERE content_hash IS NOT NULL AND content_hash <> ''").all()) out.add(r.h)
    for (const r of db.prepare("SELECT content_hash h FROM quarantine WHERE content_hash IS NOT NULL AND content_hash <> ''").all()) out.add(r.h)
  } catch { /* 老库没有列 */ }
  return out
}
