// 评测适配层：LongMemEval-S 风格的「多会话 → 记忆库」检索评测。
//
// 为什么单独一层：数据集格式（每道题一套 haystack 会话）与插件内部模型（卡片库）不同，
// 适配逻辑必须可单测、可复用，脚本只负责搬运参数与打印。
//
// 只做**检索**评测（R@5/R@10/MRR）。端到端 QA 需要固定 answer model + judge，
// 属于另一条流水线，避免把「检索好」误报成「答得好」。
import path from 'node:path'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { ensureVault, writeCard, search } from '../lib/vault.js'

/** 数据集归一化：兼容 LongMemEval 字段命名，容忍缺失可选字段。 */
export function normalizeQuestions(raw) {
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.questions) ? raw.questions : [])
  return list.map((q, i) => ({
    id: String(q.question_id ?? q.id ?? 'q' + i),
    question: String(q.question ?? q.query ?? '').trim(),
    sessions: Array.isArray(q.haystack_sessions) ? q.haystack_sessions : [],
    sessionIds: Array.isArray(q.haystack_session_ids)
      ? q.haystack_session_ids.map(String)
      : (Array.isArray(q.haystack_sessions) ? q.haystack_sessions.map((_, j) => 's' + j) : []),
    gold: new Set((Array.isArray(q.answer_session_ids) ? q.answer_session_ids : (Array.isArray(q.gold_session_ids) ? q.gold_session_ids : [])).map(String)),
    type: String(q.question_type || ''),
    answer: String(q.answer ?? ''),
    dates: Array.isArray(q.haystack_dates) ? q.haystack_dates.map(String) : [],
  })).filter((q) => q.question && q.sessions.length && q.gold.size)
}

/** 一次会话 → 一张卡（turns 拼正文，标题带上会话号/日期，便于命中后反查与时间检索）。 */
export function sessionToCard(session, sessionId, date) {
  const turns = Array.isArray(session) ? session : (Array.isArray(session?.turns) ? session.turns : [])
  const body = turns
    .map((t) => `${String(t?.role || 'x')}: ${String(t?.content ?? t ?? '')}`)
    .join('\n')
    .trim()
  const when = String(date || '').trim()
  // 偏好/推荐摘要：recommendation 类查询往往和会话字面不重合，抽出来做可检索的标签与摘要
  const PREF_RE = /\b(prefer|favorite|favourite|like|love|hate|rather|usually|always|never)\b/i
  const REC_RE = /\b(recommend|suggest|options|here are|you might|consider)\b/i
  const userPrefs = turns.filter((t) => String(t?.role) === 'user' && PREF_RE.test(String(t?.content ?? '')))
    .map((t) => String(t?.content ?? '').replace(/\s+/g, ' ').slice(0, 200))
  const asstRecs = turns.filter((t) => String(t?.role) === 'assistant' && REC_RE.test(String(t?.content ?? '')))
    .map((t) => String(t?.content ?? '').replace(/\s+/g, ' ').slice(0, 200))
  const extra = []
  if (userPrefs.length) extra.push('偏好摘要：' + userPrefs.slice(0, 3).join(' / '))
  if (asstRecs.length) extra.push('推荐摘要：' + asstRecs.slice(0, 2).join(' / '))
  const tags = ['longmemeval', sessionId, ...(when ? [when] : [])]
  if (userPrefs.length) tags.push('preference')
  if (asstRecs.length) tags.push('recommendation')
  return {
    title: '会话 ' + sessionId + (when ? ' · ' + when : '') + (userPrefs.length ? ' · 偏好' : ''),
    body: (when ? `时间：${when}\n` : '') + (body || '（空会话）') + (extra.length ? '\n\n' + extra.join('\n') : ''),
    tags,
  }
}

export async function makeScratchVault(prefix = 'mc-lme-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  await ensureVault(dir)
  return dir
}

/**
 * 摄入一道题的 haystack，返回 path → sessionId 映射。
 * 每道题独立库：LongMemEval 的 haystack 是「每题一套会话」，混库会串题。
 */
export async function ingestQuestion(root, q) {
  const map = new Map()
  for (let i = 0; i < q.sessions.length; i++) {
    const sid = q.sessionIds[i] ?? 's' + i
    const card = sessionToCard(q.sessions[i], sid, q.dates && q.dates[i])
    const r = await writeCard(root, {
      kind: 'knowledge',
      title: card.title,
      tags: card.tags,
      body: card.body,
      status: 'approved',
      source: 'bench-longmemeval',
    }, { dedup: false })
    if (r?.ok && r.path) map.set(r.path, String(sid))
  }
  return map
}

/** 跑一道题，返回命中排名（1 起；未命中为 0）。 */
export async function evalQuestion(root, q, { limit = 10, embed = false } = {}) {
  const pathToSession = await ingestQuestion(root, q)
  if (embed) {
    try {
      const { settingsFor, backfill } = await import('./embeddings.js')
      const cfg = settingsFor(root)
      if (cfg) await backfill(root, cfg, { limit: 2000, batch: 16 })
    } catch { /* 建向量失败按纯词法跑 */ }
  }
  const hits = await search(root, q.question, { limit })
  let rank = 0
  for (let i = 0; i < hits.length; i++) {
    const sid = pathToSession.get(hits[i].path)
    if (sid && q.gold.has(String(sid))) { rank = i + 1; break }
  }
  return { id: q.id, type: q.type, rank, hits: hits.length, sessions: q.sessions.length }
}

/** 汇总指标。 */
export function summarize(rows) {
  const n = rows.length || 1
  const r5 = rows.filter((r) => r.rank >= 1 && r.rank <= 5).length
  const r10 = rows.filter((r) => r.rank >= 1 && r.rank <= 10).length
  const mrr = rows.reduce((a, r) => a + (r.rank ? 1 / r.rank : 0), 0)
  return {
    questions: rows.length,
    R5: +(r5 / n).toFixed(4),
    R10: +(r10 / n).toFixed(4),
    MRR: +(mrr / n).toFixed(4),
    misses: rows.filter((r) => !r.rank).map((r) => r.id),
  }
}
