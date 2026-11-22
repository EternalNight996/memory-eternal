// 垃圾记忆扫描与批量处置。
//
// 背景：几万条卡里大部分是"当时有用、现在没用"的沉淀。手工一条条点审核/删除不现实，
// 需要先**自动分类**（给出可解释的理由），再**批量处置**（且默认 dryRun，先看后果）。
//
// 分类只依赖库里已有的字段，不引入新表：
//   · duplicate      内容完全相同（content_hash 相同）→ 保留最早一张
//   · sameSource     同一张技能卡多份（source 相同、hash 不同）→ 保留正式位置那张
//   · nearDuplicate  同标题 + 正文高度相似（自动沉淀重复写入，时间戳不同导致 hash 不同）
//   · tooShort       正文过短（默认 < 20 字）→ 大概率是碎片/噪音
//   · blankTitle     标题为空或占位（"导入记忆"/"无标题"）→ 不利于召回
//   · stale          很久没更新（默认 180 天）→ 归档候选，**不建议直接删**
//   · quarantineStale pending 超过 N 天没审 → 要么批要么丢
//
// 处置动作分三档（对应"删/藏/留"）：
//   delete  → 进回收站（可恢复）
//   archive → status 改成 archived，不进主库检索但数据在（需要 db 支持）
//   reject  → 进隔离区 rejected（审核语义上更准确）

import { getDb } from './db.js'
import { minhashSignature, jaccardEstimate, mix32 } from './minhash.js'

/** 正文多短算"过短"。可被调用方覆盖。 */
export const SHORT_BODY_CHARS = 20
/** 多久没更新算"陈旧"（天）。 */
export const STALE_DAYS = 180
/** 创建多少天后仍然 0 次召回，才算「从未被召回的僵尸卡」（天）。 */
export const NEVER_RECALLED_DAYS = 90
/** pending 超过多少天算"积压"（天）。 */
export const STALE_PENDING_DAYS = 30

const PLACEHOLDER_TITLES = new Set(['', '导入记忆', '无标题', 'untitled', 'imported'])

/** 把 SQLite 的 datetime 字符串安全解析成毫秒（失败返回 0）。 */
function ts(v) {
  if (!v) return 0
  const t = Date.parse(String(v).includes('T') ? v : String(v).replace(' ', 'T') + 'Z')
  return Number.isFinite(t) ? t : 0
}

/**
 * 扫描垃圾候选。
 *
 * **主库与隔离区都扫**（这点很关键）：`enforceAudit` 会把新写入的卡强制成 pending，
 * 所以"导入几万条"之后真正堆在那里的是**隔离区的 pending**，而不是主库。
 * 只扫 approved 会得到「一切正常」的假象。
 *
 * @param {string} root 库根
 * @param {{shortBodyChars?:number, staleDays?:number, stalePendingDays?:number, limit?:number, includeQuarantine?:boolean}} [opts]
 */
export function scanJunk(root, opts = {}) {
  const db = getDb(root)
  const shortChars = Number(opts.shortBodyChars) > 0 ? Number(opts.shortBodyChars) : SHORT_BODY_CHARS
  const staleDays = Number(opts.staleDays) > 0 ? Number(opts.staleDays) : STALE_DAYS
  const neverRecalledDays = Number(opts.neverRecalledDays) > 0 ? Number(opts.neverRecalledDays) : NEVER_RECALLED_DAYS
  const stalePendingDays = Number(opts.stalePendingDays) > 0 ? Number(opts.stalePendingDays) : STALE_PENDING_DAYS
  // 上限 20000：pickByFilter 要能一次取全某类候选（本地实测近重复就有 9k+，
  // 旧的 5000 上限会把这类候选截掉一半，批量处置就只清一半）。
  const limit = Math.min(Number(opts.limit) > 0 ? Number(opts.limit) : 500, 20000)
  const includeQuarantine = opts.includeQuarantine !== false
  const now = Date.now()

  const out = {
    ok: true,
    thresholds: { shortBodyChars: shortChars, staleDays, neverRecalledDays, stalePendingDays },
    summary: {
      total: 0, main: 0, quarantine: 0,
      duplicate: 0, sameSource: 0, nearDuplicate: 0, tooShort: 0, blankTitle: 0, stale: 0, neverRecalled: 0, quarantineStale: 0, reclaimable: 0,
      quarantinePending: 0,
    },
    candidates: [],
    byReason: {},
  }

  /** 两张表统一成同一形状，后面按 status 分流规则。 */
  const SEL = 'id, path, kind, title, body, status, source, created_at, updated_at, content_hash, recall_count, last_recalled_at'
  let rows = []
  try {
    rows = db.prepare(`SELECT ${SEL} FROM cards`).all().map((r) => ({ ...r, tbl: 'cards' }))
  } catch { return out }
  if (includeQuarantine) {
    try {
      rows = rows.concat(db.prepare(`SELECT ${SEL} FROM quarantine`).all().map((r) => ({ ...r, tbl: 'quarantine' })))
    } catch { /* 老库没有隔离区 */ }
  }
  out.summary.total = rows.length
  out.summary.main = rows.filter((r) => r.tbl === 'cards').length
  out.summary.quarantine = rows.filter((r) => r.tbl === 'quarantine').length
  out.summary.quarantinePending = rows.filter((r) => r.tbl === 'quarantine' && r.status === 'pending').length

  // ① 重复组：同 hash 多张 → 保留 created_at 最早（并列时 id 最小）
  const byHash = new Map()
  for (const r of rows) {
    const h = r.content_hash || ''
    if (!h) continue
    // 已删除的不参与"保留"（免得拿一张无主卡当正本）
    if (r.status === 'deleted') continue
    if (!byHash.has(h)) byHash.set(h, [])
    byHash.get(h).push(r)
  }
  /** 重复组里被保留的「正本」：不参与后续的僵尸/陈旧判定 —— 留着让人工决定去留，
   *  否则「归档正本 + 清理重复品」会让整组一起消失，用户很难理解发生了什么。 */
  const keepers = new Set()
  // 99-Import 是导入落地的副本目录：同内容时永远让位给正式位置
  // （否则「最早 created_at」会让导入副本当正本，反而把策展过的 02-Projects 卡删掉）。
  const importPenalty = (p) => (String(p || '').startsWith('99-Import/') ? 1 : 0)
  for (const [, group] of byHash) {
    if (group.length < 2) continue
    // 优先保留主库里的那张（approved 才是"正本"）
    group.sort((a, b) => {
      const ai = importPenalty(a.path)
      const bi = importPenalty(b.path)
      if (ai !== bi) return ai - bi
      const am = a.tbl === 'cards' ? 1 : 0
      const bm = b.tbl === 'cards' ? 1 : 0
      if (am !== bm) return bm - am
      return (ts(a.created_at) - ts(b.created_at)) || (a.id - b.id)
    })
    const keeper = group[0]
    keepers.add(keeper.path)
    for (let i = 1; i < group.length; i++) {
      const r = group[i]
      out.candidates.push({
        path: r.path, title: r.title, reason: 'duplicate', keep: keeper.path,
        store: r.tbl, status: r.status,
        suggestion: 'delete', detail: `与「${keeper.path}」内容完全相同`,
      })
      out.summary.duplicate++
      out.byReason.duplicate = (out.byReason.duplicate || 0) + 1
    }
  }

  // ② 逐条判其他规则（已在重复组里的不重复计入）
  // ①-b 同一技能多份（source 相同，但正文因版本号/来源路径不同而 hash 不同）
  const bySource = new Map()
  for (const r of rows) {
    if (r.status === 'deleted') continue
    if (r.kind !== 'skill') continue
    const src = String(r.source || '').trim()
    if (!src) continue
    if (!bySource.has(src)) bySource.set(src, [])
    bySource.get(src).push(r)
  }
  for (const [src, group] of bySource) {
    if (group.length < 2) continue
    group.sort((a2, b2) => {
      const ap = String(a2.path).startsWith('10-Skills/') ? 1 : 0
      const bp = String(b2.path).startsWith('10-Skills/') ? 1 : 0
      if (ap !== bp) return bp - ap
      const am = a2.tbl === 'cards' ? 1 : 0
      const bm = b2.tbl === 'cards' ? 1 : 0
      if (am !== bm) return bm - am
      return (ts(a2.created_at) - ts(b2.created_at)) || (a2.id - b2.id)
    })
    const keeper = group[0]
    keepers.add(keeper.path)
    for (let i2 = 1; i2 < group.length; i2++) {
      const r = group[i2]
      if (out.candidates.some((c) => c.path === r.path)) continue
      out.candidates.push({
        path: r.path, title: r.title, reason: 'sameSource', keep: keeper.path,
        store: r.tbl, status: r.status, suggestion: 'delete',
        detail: '与「' + keeper.path + '」是同一张技能卡（source=' + src + '）',
      })
      out.summary.sameSource++
      out.byReason.sameSource = (out.byReason.sameSource || 0) + 1
    }
  }

  // ①-c 近似重复（同标题 + 正文高度相似）
  //   content_hash 查不出：自动沉淀每次都把时间戳写进正文，同一段对话沉淀两次 hash 不同。
  //   只对 title 相同的组做两两比对（全局 LSH 在几万张上代价太高）。
  const NEAR_DUP_JACCARD = Number(opts.nearDupThreshold) > 0 ? Number(opts.nearDupThreshold) : 0.9
  const byTitle = new Map()
  for (const r of rows) {
    if (r.status === 'deleted') continue
    const t2 = String(r.title || '').trim()
    if (!t2) continue
    if (!byTitle.has(t2)) byTitle.set(t2, [])
    byTitle.get(t2).push(r)
  }
  const gramsOf = (body) => {
    const s = String(body || '').replace(/\s+/g, '')
    const set = new Set()
    for (let i2 = 0; i2 + 1 < s.length; i2++) set.add(mix32(s.charCodeAt(i2) * 31 + s.charCodeAt(i2 + 1)))
    return set
  }
  for (const [, group] of byTitle) {
    if (group.length < 2) continue
    const sigs = group.map((r) => minhashSignature(gramsOf(r.body), 64))
    const keepIdx = new Set()
    for (let i2 = 0; i2 < group.length; i2++) {
      if (keepIdx.has(i2)) continue
      const similar = []
      for (let j2 = i2 + 1; j2 < group.length; j2++) {
        if (keepIdx.has(j2)) continue
        const la = String(group[i2].body || '').length
        const lb = String(group[j2].body || '').length
        if (la && lb && Math.abs(la - lb) / Math.max(la, lb) > 0.4) continue
        if (jaccardEstimate(sigs[i2], sigs[j2]) >= NEAR_DUP_JACCARD) similar.push(j2)
      }
      if (!similar.length) continue
      const members = [i2, ...similar]
      members.sort((a2, b2) => {
        const ap = String(group[a2].path).startsWith('10-') ? 1 : 0
        const bp = String(group[b2].path).startsWith('10-') ? 1 : 0
        if (ap !== bp) return bp - ap
        // 99-Import 副本让位给正式位置（同 duplicate 组：别让导入副本当正本）
        const ai = importPenalty(group[a2].path)
        const bi = importPenalty(group[b2].path)
        if (ai !== bi) return ai - bi
        const am = group[a2].tbl === 'cards' ? 1 : 0
        const bm = group[b2].tbl === 'cards' ? 1 : 0
        if (am !== bm) return bm - am
        return (ts(group[a2].created_at) - ts(group[b2].created_at)) || (group[a2].id - group[b2].id)
      })
      const keeper2 = group[members[0]]
      keepers.add(keeper2.path)
      for (let k2 = 1; k2 < members.length; k2++) {
        const r = group[members[k2]]
        keepIdx.add(members[k2])
        if (out.candidates.some((c) => c.path === r.path)) continue
        out.candidates.push({
          path: r.path, title: r.title, reason: 'nearDuplicate', keep: keeper2.path,
          store: r.tbl, status: r.status, suggestion: 'delete',
          detail: '与「' + keeper2.path + '」正文高度相似（同标题，Jaccard >= ' + NEAR_DUP_JACCARD + '）',
        })
        out.summary.nearDuplicate++
        out.byReason.nearDuplicate = (out.byReason.nearDuplicate || 0) + 1
      }
    }
  }
  const seenDup = new Set(out.candidates.map((c) => c.path))
  for (const r of rows) {
    if (seenDup.has(r.path)) continue
    if (keepers.has(r.path)) continue // 重复组正本：交给人工决定，不自动判僵尸
    if (r.status === 'deleted') continue // 已在回收站，不必再建议删
    const bodyLen = String(r.body || '').replace(/\s+/g, '').length

    // 隔离区里的 pending 只看"积压"和"过短"，不判空标题/陈旧（它还没进主库）
    const isQuarantine = r.tbl === 'quarantine'

    if (bodyLen < shortChars) {
      out.candidates.push({
        path: r.path, title: r.title, reason: 'tooShort', store: r.tbl, status: r.status,
        suggestion: 'reject', detail: `正文仅 ${bodyLen} 字（阈值 ${shortChars}）`,
      })
      out.summary.tooShort++
      out.byReason.tooShort = (out.byReason.tooShort || 0) + 1
      continue
    }

    if (isQuarantine) {
      const created = ts(r.created_at)
      if (r.status === 'pending' && created && now - created > stalePendingDays * 86400000) {
        const days = Math.floor((now - created) / 86400000)
        out.candidates.push({
          path: r.path, title: r.title, reason: 'quarantineStale', store: r.tbl, status: r.status,
          suggestion: 'reject', detail: `待审 ${days} 天（阈值 ${stalePendingDays}）`,
        })
        out.summary.quarantineStale++
        out.byReason.quarantineStale = (out.byReason.quarantineStale || 0) + 1
      }
      continue // 隔离区不判空标题/陈旧
    }

    const title = String(r.title || '').trim()
    if (PLACEHOLDER_TITLES.has(title.toLowerCase()) || title === '导入记忆') {
      out.candidates.push({
        path: r.path, title: r.title, reason: 'blankTitle', store: r.tbl, status: r.status,
        suggestion: 'fix-title', detail: '标题为空或占位，影响召回可读性',
      })
      out.summary.blankTitle++
      out.byReason.blankTitle = (out.byReason.blankTitle || 0) + 1
      continue
    }

    const updated = ts(r.updated_at)
    if (updated && now - updated > staleDays * 86400000) {
      // 陈旧 ≠ 垃圾：只建议归档，不建议删除
      const days = Math.floor((now - updated) / 86400000)
      out.candidates.push({
        path: r.path, title: r.title, reason: 'stale', store: r.tbl, status: r.status,
        suggestion: 'archive', detail: `${days} 天未更新（阈值 ${staleDays}）`,
      })
      out.summary.stale++
      out.byReason.stale = (out.byReason.stale || 0) + 1
      continue
    }

    // ④ 真正的僵尸判据：**从来没被召回过的老卡**。
    // 时间只是弱信号（三年前的架构卡可能每周被召回）；recall_count == 0 才是硬证据。
    // 但要排除"新卡还没机会被召回"的情况 —— 所以要求创建超过 neverRecalledDays 天。
    const created = ts(r.created_at)
    const recalls = Number(r.recall_count) || 0
    if (recalls === 0 && created && now - created > neverRecalledDays * 86400000) {
      const days = Math.floor((now - created) / 86400000)
      out.candidates.push({
        path: r.path, title: r.title, reason: 'neverRecalled', store: r.tbl, status: r.status,
        suggestion: 'archive', detail: `创建 ${days} 天，从未被召回`,
      })
      out.summary.neverRecalled++
      out.byReason.neverRecalled = (out.byReason.neverRecalled || 0) + 1
    }
  }

  // 可回收数：只有"删了不心疼"的那几类（stale / neverRecalled 是归档候选，不算回收）
  // sameSource / nearDuplicate 都指向 suggestion=delete，必须计入 —— 否则界面会出现
  // 「可回收 17」但同一屏列着 9567 条近重复的自相矛盾数字。
  out.summary.reclaimable = out.summary.duplicate + out.summary.sameSource + out.summary.nearDuplicate
    + out.summary.tooShort + out.summary.quarantineStale
  out.candidates = out.candidates.slice(0, limit)
  out.truncated = (out.summary.reclaimable + out.summary.stale + out.summary.neverRecalled + out.summary.blankTitle) > out.candidates.length
  return out
}

/**
 * 按筛选条件挑出要处置的 path（供 /cards/bulk 的 filter 形式使用）。
 * @param {string} root
 * @param {{reason?:string, reasons?:string[], olderThanDays?:number, shorterThan?:number, limit?:number}} filter
 * @returns {string[]}
 */
export function pickByFilter(root, filter = {}) {
  // 注意 limit 是**扫描后截断**：按类别取全量时默认给到上限，
  // 否则 9k 条近重复只返回 5k，批量处置会静默漏掉一半。
  const scan = scanJunk(root, {
    limit: Math.min(Number(filter.limit) > 0 ? Number(filter.limit) : 20000, 20000),
  })
  const reasons = Array.isArray(filter.reasons)
    ? filter.reasons.map(String).filter(Boolean)
    : (filter.reason ? [String(filter.reason)] : [])
  let list = scan.candidates
  if (reasons.length) {
    const want = new Set(reasons)
    list = list.filter((c) => want.has(c.reason))
  }
  if (Number(filter.olderThanDays) > 0) {
    const cutoff = Date.now() - Number(filter.olderThanDays) * 86400000
    const db = getDb(root)
    const kept = []
    for (const c of list) {
      try {
        const row = db.prepare('SELECT updated_at FROM cards WHERE path = ? UNION ALL SELECT updated_at FROM quarantine WHERE path = ?').get(c.path, c.path)
        if (row && ts(row.updated_at) && ts(row.updated_at) < cutoff) kept.push(c)
      } catch { /* 忽略 */ }
    }
    list = kept
  }
  return list.map((c) => c.path)
}
