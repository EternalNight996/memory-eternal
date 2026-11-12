/**
 * 可选「LLM 重排」：把 BM25+向量融合后的 Top-K 交给一个本地/在线 chat 模型重排。
 *
 * 为什么单独一层：融合分只能粗排，且向量会抢短噪声查询的排名（noisy Top1 85→60）；
 * 让模型看「查询 + 候选标题/摘要」直接给顺序，能同时救 Top1 与改写题。
 *
 * 设计约束：
 *   · 完全可选：未配置 rerankModel 时零开销、零网络，行为与之前一致；
 *   · 失败即降级：超时/解析失败/服务不可达 → 返回 null，调用方保留原排序；
 *   · 只重排 Top-K（默认 30），不改变候选集合，避免引入新噪声。
 */
import { readEmbeddingConfig } from './embedding-config.js'

const DEFAULTS = { topK: 30, timeoutMs: 20000 }

function parseOrder(text, n) {
  const raw = String(text || '')
  const m = raw.match(/\{[\s\S]*\}/) || raw.match(/\[[\s\S]*\]/)
  if (!m) return null
  let data
  try { data = JSON.parse(m[0]) } catch { return null }
  const arr = Array.isArray(data) ? data : (Array.isArray(data.order) ? data.order : null)
  if (!arr) return null
  const seen = new Set()
  const out = []
  for (const v of arr) {
    const i = Number(v)
    if (Number.isInteger(i) && i >= 1 && i <= n && !seen.has(i)) { seen.add(i); out.push(i) }
  }
  return out.length ? out : null
}

/**
 * @returns {Promise<Array|null>} 重排后的完整数组；未配置/失败返回 null。
 */
export async function rerankHits(root, query, hits, opts = {}) {
  const topK = Math.max(2, Math.min(50, Number(opts.topK) || DEFAULTS.topK))
  if (!Array.isArray(hits) || hits.length < 3) return null
  let cfg = {}
  try { cfg = readEmbeddingConfig(process.env) || {} } catch { cfg = {} }
  const base = String(process.env.MEMORY_RERANK_BASE_URL || cfg.baseUrl || '').replace(/\/+$/, '')
  const model = String(process.env.MEMORY_RERANK_MODEL || cfg.rerankModel || '').trim()
  if (!base || !model) return null
  const apiKey = process.env.MEMORY_RERANK_KEY || cfg.apiKey || ''

  const top = hits.slice(0, topK)
  const list = top.map((h, i) => {
    const snip = String(h.excerpt || h.summary || '').replace(/\s+/g, ' ').slice(0, 420)
    return `${i + 1}. [${String(h.title || '').slice(0, 60)}] ${snip}`
  }).join('\n')
  const body = {
    model,
    temperature: 0,
    max_tokens: 200,
    messages: [
      { role: 'system', content: '你是检索重排器。只输出 JSON：{"order":[最相关候选序号,...]}，按相关性从高到低，最多 10 个，不要解释。' },
      { role: 'user', content: `查询：${query}\n候选：\n${list}` },
    ],
  }
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), Number(opts.timeoutMs) || DEFAULTS.timeoutMs)
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
      body: JSON.stringify(body),
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer))
    if (!res.ok) return null
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content
    const order = parseOrder(text, top.length)
    if (!order) return null
    const picked = order.map((i) => top[i - 1])
    const pickedSet = new Set(picked)
    const rest = top.filter((h) => !pickedSet.has(h))
    return [...picked, ...rest, ...hits.slice(topK)]
  } catch { return null }
}
