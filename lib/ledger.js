// 记忆账本：记录「记忆本身的开销」——召回注入了多少字符、蒸馏调了多少次 LLM。
//
// 为什么要有它：README 一直说「省 token」，但省不省取决于「被避免的上下文开销」是否大于
// 「注入 + 蒸馏调用」的成本。没有账本，所有调参都是猜；有账本后至少能回答「我们花了多少」，
// 再结合召回有用率（feedback 表）判断净收益方向。
//
// 只记账，不参与主流程：任何异常都吞掉，绝不能让统计把沉淀/召回弄失败。

import { getDb } from './db.js'

const DAY_MS = 86400000

/** 记一条流水。失败静默返回 false。 */
export function recordLedger(root, entry = {}) {
  try {
    const db = getDb(root)
    db.prepare(`
      INSERT INTO ledger (ts, kind, session, results, chars, chars_in, llm_calls, provider, model, ms, ok, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(entry.ts) || Date.now(),
      String(entry.kind || 'other').slice(0, 20),
      String(entry.session || '').slice(0, 80),
      Math.max(0, Number(entry.results) || 0),
      Math.max(0, Number(entry.chars) || 0),
      Math.max(0, Number(entry.charsIn) || 0),
      Math.max(0, Number(entry.llmCalls) || 0),
      String(entry.provider || '').slice(0, 60),
      String(entry.model || '').slice(0, 80),
      Math.max(0, Number(entry.ms) || 0),
      entry.ok === false ? 0 : 1,
      String(entry.note || '').slice(0, 200),
    )
    return true
  } catch { return false }
}

const localDay = (ts) => {
  const d = new Date(Number(ts) || 0)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 近 N 天汇总（默认 7 天，最多 90 天）。
 * - totals：召回次数/注入字符、沉淀次数/LLM 调用/输入输出字符、粗估 token
 * - byDay：逐日明细（used by 面板画趋势）
 * - feedback：召回有用率（feedback 表，只有 agent 显式标记才有数据）
 */
export function ledgerSummary(root, { days = 7, now = Date.now() } = {}) {
  const db = getDb(root)
  const n = Math.min(Math.max(Math.floor(Number(days) || 7), 1), 90)
  const cutoff = Number(now) - n * DAY_MS
  const rows = db.prepare('SELECT * FROM ledger WHERE ts >= ? ORDER BY ts').all(cutoff)
  const recalls = rows.filter((r) => r.kind === 'recall')
  const captures = rows.filter((r) => r.kind === 'capture')
  const sum = (arr, k) => arr.reduce((s, r) => s + (Number(r[k]) || 0), 0)

  const byDay = []
  const index = new Map()
  for (let i = n - 1; i >= 0; i--) {
    const key = localDay(Number(now) - i * DAY_MS)
    const row = { date: key, recalls: 0, injectedChars: 0, captures: 0, llmCalls: 0, captureInChars: 0, captureOutChars: 0 }
    index.set(key, row)
    byDay.push(row)
  }
  for (const r of rows) {
    const row = index.get(localDay(r.ts))
    if (!row) continue
    if (r.kind === 'recall') { row.recalls += 1; row.injectedChars += Number(r.chars) || 0 }
    if (r.kind === 'capture') { row.captures += 1; row.llmCalls += Number(r.llm_calls) || 0; row.captureInChars += Number(r.chars_in) || 0; row.captureOutChars += Number(r.chars) || 0 }
  }

  // 召回有用率：只有调用方显式回传 useful 时才有数据；没有数据时 rate = null（不要假装 0%）
  let useful = 0
  let useless = 0
  try {
    const fb = db.prepare("SELECT useful, COUNT(*) AS n FROM feedback WHERE created_at >= datetime('now', ?) GROUP BY useful").all(`-${n} days`)
    for (const r of fb) { if (Number(r.useful) === 1) useful = Number(r.n) || 0; else useless = Number(r.n) || 0 }
  } catch { /* feedback 表缺失也不影响账本 */ }

  const injectedChars = sum(recalls, 'chars')
  const captureInChars = sum(captures, 'chars_in')
  const captureOutChars = sum(captures, 'chars')
  // 粗估 token：中英混排约 2 字符 ≈ 1 token（保守口径，只用于看量级，不做计费）
  const estTokens = Math.round((injectedChars + captureInChars + captureOutChars) / 2)

  return {
    ok: true,
    days: n,
    since: cutoff,
    totals: {
      recalls: recalls.length,
      recallResults: sum(recalls, 'results'),
      injectedChars,
      captures: captures.length,
      captureOk: captures.filter((r) => Number(r.ok) === 1).length,
      captureFail: captures.filter((r) => Number(r.ok) !== 1).length,
      llmCalls: sum(captures, 'llm_calls'),
      captureInChars,
      captureOutChars,
      estTokens,
    },
    byDay,
    feedback: { useful, useless, total: useful + useless, rate: useful + useless ? useful / (useful + useless) : null },
  }
}
