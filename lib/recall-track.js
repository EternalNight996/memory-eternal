// 召回计数：给「这张卡到底有没有被用过」留下证据。
//
// 为什么需要：判断垃圾时，时间（180 天没更新）只是弱信号 —— 一张 3 年前写的
// 架构决策卡可能每周被召回，而 3 天前生成的废话卡一次都没被用过。
// 真正的僵尸判据是 **recall_count == 0**。
//
// 为什么不在每次命中时直接 UPDATE：
//   · 一次搜索命中 10 条 = 10 次写库；高频检索会把这个成本放大到不可接受
//   · 召回是**读路径**，往里插写操作会让读变慢，得不偿失
//
// 所以：**内存累积 + 批量刷写**。
//   · bumpRecall() 只往内存 Map 里 +1（纳秒级）
//   · 攒够 FLUSH_THRESHOLD 条或过 FLUSH_INTERVAL_MS 才真正写库（单事务批量 UPDATE）
//   · 进程退出前 flush 一次（best-effort）
//
// 计数是**尽力而为**的：进程被杀最多丢掉最后几秒的计数。这个精度对"判别僵尸卡"
// 完全够用 —— 我们关心的是「0 次 vs 几十次」，不是精确到个位。

import { getDb } from './db.js'

/** 攒够多少条不同卡片就刷一次。 */
export const FLUSH_THRESHOLD = 200
/** 最长多久刷一次（毫秒）。 */
export const FLUSH_INTERVAL_MS = 15000

/** root → { pending: Map<path, delta>, timer, lastFlush } */
const state = new Map()

function bucketOf(root) {
  let s = state.get(root)
  if (!s) {
    s = { pending: new Map(), timer: null, lastFlush: Date.now() }
    state.set(root, s)
  }
  return s
}

/**
 * 把一次召回算进内存计数。
 * @param {string} root 库根
 * @param {string|string[]} paths 被召回的卡片 path（单个或数组）
 * @param {number} [delta] 一次召回算几次（默认 1）
 */
export function bumpRecall(root, paths, delta = 1) {
  const list = Array.isArray(paths) ? paths : [paths]
  if (!list.length) return
  const s = bucketOf(root)
  const inc = Number(delta) > 0 ? Number(delta) : 1
  for (const p of list) {
    const k = String(p || '').trim()
    if (!k) continue
    s.pending.set(k, (s.pending.get(k) || 0) + inc)
  }
  // 攒够了立刻刷
  if (s.pending.size >= FLUSH_THRESHOLD) {
    flushRecall(root)
    return
  }
  // 否则安排一次延迟刷（已有定时器就不重复排）
  if (!s.timer) {
    s.timer = setTimeout(() => { try { flushRecall(root) } catch { /* 忽略 */ } }, FLUSH_INTERVAL_MS)
    // 不要因为这个定时器把进程钉住（CLI 场景跑完就该退出）
    if (typeof s.timer.unref === 'function') s.timer.unref()
  }
}

/**
 * 立即把内存计数写进库（单事务批量 UPDATE）。
 * @returns {{flushed:number, error?:string}}
 */
export function flushRecall(root) {
  const s = state.get(root)
  if (!s) return { flushed: 0 }
  if (s.timer) { try { clearTimeout(s.timer) } catch { /* 忽略 */ } s.timer = null }
  const entries = [...s.pending.entries()]
  s.pending.clear()
  s.lastFlush = Date.now()
  if (!entries.length) return { flushed: 0 }

  let db
  try { db = getDb(root) } catch (e) { return { flushed: 0, error: String((e && e.message) || e) } }

  // 两张表都可能有这些 path（审核流转会搬表，id 不变但 path 也不变）
  const updCards = db.prepare("UPDATE cards SET recall_count = COALESCE(recall_count, 0) + ?, last_recalled_at = datetime('now') WHERE path = ?")
  const updQuar = db.prepare("UPDATE quarantine SET recall_count = COALESCE(recall_count, 0) + ?, last_recalled_at = datetime('now') WHERE path = ?")

  let flushed = 0
  let inTx = false
  try { db.exec('BEGIN'); inTx = true } catch { inTx = false }
  try {
    for (const [path, delta] of entries) {
      try {
        const a = updCards.run(delta, path)
        const b = updQuar.run(delta, path)
        if ((a && a.changes) || (b && b.changes)) flushed++
      } catch { /* 单条失败不影响其他 */ }
    }
    if (inTx) db.exec('COMMIT')
  } catch (e) {
    if (inTx) { try { db.exec('ROLLBACK') } catch { /* 忽略 */ } }
    // 失败就把计数还回内存，下次再试（不丢数据）
    for (const [path, delta] of entries) s.pending.set(path, (s.pending.get(path) || 0) + delta)
    return { flushed: 0, error: String((e && e.message) || e) }
  }
  return { flushed }
}

/** 清掉某库的待刷计数（测试用）。 */
export function resetRecallState(root) {
  const s = state.get(root)
  if (!s) return
  if (s.timer) { try { clearTimeout(s.timer) } catch { /* 忽略 */ } }
  state.delete(root)
}

/** 进程退出前刷掉所有库的待刷计数（best-effort，同步执行）。 */
export function flushAllRecall() {
  for (const root of [...state.keys()]) {
    try { flushRecall(root) } catch { /* 忽略 */ }
  }
}
