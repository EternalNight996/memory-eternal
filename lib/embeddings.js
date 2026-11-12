// 记忆核心 · 可选语义召回（OpenAI 兼容 /embeddings）
//
// 定位：**可选后端**。不配置时整条链路不启动，检索行为与纯 FTS5 完全一致；
// 配置后由用户自行承担「把卡片文本发给 embedding 服务」的隐私与费用。
//
// 配置优先级：界面保存（enabled=true）> 环境变量（MEMORY_EMBED_*，回退 LLM/OPENAI）。
//
// 设计取舍：
//   · 向量缓存进 SQLite 的 card_vec 表，按 model 区分；换模型自动重算。
//   · 搜索只用**已缓存**向量；没缓存先跑 scripts/embed-backfill.mjs，
//     绝不在召回路径里同步全量建索引（否则一次搜索可能挂几十秒）。
//   · 任何网络/解析错误都降级为「无向量」，并静默 60 秒，避免反复打挂服务。
import { getDb } from './db.js'
import { readEmbeddingConfig } from './embedding-config.js'

const FAIL_COOLDOWN_MS = 60 * 1000
let failUntil = 0

export function embeddingSettings(env = process.env) {
  const baseUrl = env.MEMORY_EMBED_BASE_URL || env.MEMORY_LLM_BASE_URL || env.OPENAI_BASE_URL || ''
  const apiKey = env.MEMORY_EMBED_KEY || env.MEMORY_LLM_KEY || env.OPENAI_API_KEY || ''
  const model = env.MEMORY_EMBED_MODEL || ''
  if (!baseUrl || !model) return null
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model }
}

/**
 * 生效配置：界面保存的（enabled=true）优先，其次环境变量。
 * 这样「默认不装、不配置」的情况下整条链路完全不启动。
 */
export function settingsFor(root, env = process.env) {
  const saved = readEmbeddingConfig(env)
  if (saved.enabled && saved.mode !== 'builtin' && saved.baseUrl && saved.model) {
    return { baseUrl: saved.baseUrl.replace(/\/+$/, ''), apiKey: saved.apiKey || '', model: saved.model, source: 'config' }
  }
  const envCfg = embeddingSettings(env)
  return envCfg ? { ...envCfg, source: 'env' } : null
}

/** 探测端点：先按 OpenAI 兼容 /models，失败再按 Ollama /api/tags。 */
export async function probeService(cfg, { timeoutMs = 4000 } = {}) {
  const out = { reachable: false, kind: '', models: [], error: '' }
  if (!cfg?.baseUrl) return { ...out, error: '未配置地址' }
  const headers = cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}
  try {
    const r = await fetch(cfg.baseUrl + '/models', { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (r.ok) {
      const d = await r.json().catch(() => ({}))
      out.reachable = true
      out.kind = 'openai'
      out.models = (Array.isArray(d?.data) ? d.data : []).map((x) => String(x?.id || '')).filter(Boolean)
      return out
    }
  } catch { /* 继续试 Ollama */ }
  try {
    const origin = cfg.baseUrl.replace(/\/v1\/?$/i, '')
    const r = await fetch(origin + '/api/tags', { signal: AbortSignal.timeout(timeoutMs) })
    if (r.ok) {
      const d = await r.json().catch(() => ({}))
      out.reachable = true
      out.kind = 'ollama'
      out.models = (Array.isArray(d?.models) ? d.models : []).map((x) => String(x?.name || '')).filter(Boolean)
      return out
    }
  } catch (e) {
    out.error = String((e && e.message) || e)
  }
  return out
}

/** 用 Ollama 的 /api/pull 拉模型（流式进度）。非 Ollama 端点会抛错。 */
export async function pullModel(cfg, model, { onProgress = null, timeoutMs = 30 * 60 * 1000 } = {}) {
  const origin = cfg.baseUrl.replace(/\/v1\/?$/i, '')
  const res = await fetch(origin + '/api/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok || !res.body) throw new Error('pull 失败：HTTP ' + res.status)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      if (onProgress) onProgress(j)
      if (j?.status === 'success') return true
      if (j?.error) throw new Error(String(j.error))
    }
  }
  return true
}

/** 批量取向量。失败抛错（由上层决定降级）。 */
export async function embedTexts(cfg, texts, { timeoutMs = 15000 } = {}) {
  const input = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? ''))
  if (!input.length) return []
  const res = await fetch(cfg.baseUrl + '/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: 'Bearer ' + cfg.apiKey } : {}),
    },
    body: JSON.stringify({ model: cfg.model, input }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`embeddings ${res.status}: ${detail.slice(0, 200)}`)
  }
  const data = await res.json()
  const rows = Array.isArray(data?.data) ? data.data : []
  if (rows.length !== input.length) throw new Error('embeddings: 返回条数与请求不一致')
  const out = []
  for (const r of rows) {
    const v = r?.embedding
    if (!Array.isArray(v) || !v.length) throw new Error('embeddings: 缺失向量')
    out.push(normalize(new Float32Array(v)))
  }
  return out
}

function normalize(v) {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

export function ensureVecTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS card_vec (
    id INTEGER PRIMARY KEY,
    path TEXT,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  )`)
  // 老库迁移：补 path 列（按 path 清理/更新向量要用）
  try {
    const cols = db.prepare('PRAGMA table_info(card_vec)').all().map((c) => c.name)
    if (!cols.includes('path')) db.exec('ALTER TABLE card_vec ADD COLUMN path TEXT')
  } catch { /* 只读库等场景忽略 */ }
}

const toBuffer = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
const toFloat = (blob) => {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  const ab = new ArrayBuffer(buf.length)
  new Uint8Array(ab).set(buf)
  return new Float32Array(ab)
}

/** 卡片被索引的文本（标题权重靠前，正文截断，避免一次发一整张长卡）。 */
export function cardText(row, { maxBody = 1800 } = {}) {
  return String(row.title || '') + '\n' + String(row.body || '').slice(0, maxBody)
}

/**
 * 补齐向量缓存。
 * @returns {{embedded:number, remaining:number, model:string}}
 */
export async function backfill(root, cfg, { limit = 500, batch = 16, onProgress = null } = {}) {
  const db = getDb(root)
  ensureVecTable(db)
  // 清孤儿向量（删卡/旧版本无 path 列遗留）— 主库物理上只含 approved
  try { db.prepare('DELETE FROM card_vec WHERE id NOT IN (SELECT id FROM cards)').run() } catch { /* ignore */ }
  const rows = db.prepare(`
    SELECT c.id, c.path, c.title, c.body FROM cards c
    LEFT JOIN card_vec v ON v.id = c.id AND v.model = ?
    WHERE c.deleted_at IS NULL AND v.id IS NULL
    LIMIT ?
  `).all(cfg.model, Math.max(1, limit))
  let done = 0
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch)
    // 首轮可能触发模型加载（1.2GB 进显存），15s 默认超时不够；建缓存单独给宽限
    const vecs = await embedTexts(cfg, chunk.map((r) => cardText(r)), { timeoutMs: 180000 })
    const ins = db.prepare("INSERT OR REPLACE INTO card_vec(id, path, model, dim, vec, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
    db.exec('BEGIN')
    try {
      for (let j = 0; j < chunk.length; j++) ins.run(chunk[j].id, chunk[j].path || null, cfg.model, vecs[j].length, toBuffer(vecs[j]))
      db.exec('COMMIT')
    } catch (e) { try { db.exec('ROLLBACK') } catch { /* ignore */ } throw e }
    done += chunk.length
    if (onProgress) onProgress(done, rows.length)
  }
  return { embedded: done, remaining: Math.max(0, rows.length - done), model: cfg.model }
}

export function vectorStats(root, model) {
  try {
    const db = getDb(root)
    ensureVecTable(db)
    const row = db.prepare('SELECT COUNT(*) AS n FROM card_vec WHERE model = ?').get(model)
    const cards = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE deleted_at IS NULL').get()
    return { vectors: Number(row?.n || 0), cards: Number(cards?.n || 0), model }
  } catch { return { vectors: 0, cards: 0, model } }
}

/**
 * 向量召回（只读缓存）。未配置、缓存为空、或最近失败过 → 返回 null（调用方走纯词法）。
 * @returns {Promise<Array<{id:number, score:number, rank:number}>|null>}
 */
export async function denseSearch(root, query, { limit = 50, minCoverage = 0.3, extraQueries = [] } = {}) {
  const cfg = settingsFor(root)
  if (!cfg) return null
  if (Date.now() < failUntil) return null
  try {
    const db = getDb(root)
    ensureVecTable(db)
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM cards WHERE deleted_at IS NULL').get()?.n || 0)
    if (!total) return null
    const rows = db.prepare('SELECT id, dim, vec FROM card_vec WHERE model = ?').all(cfg.model)
    if (!rows.length || rows.length / total < minCoverage) return null
    // 多查询向量：原查询 + 同义扩展查询（平均后归一化）——弱查询靠扩展词拉近语义
    const inputs = [query, ...(Array.isArray(extraQueries) ? extraQueries : [])].map((s) => String(s || '').trim()).filter(Boolean)
    const vecs = await embedTexts(cfg, inputs.length ? inputs : [query])
    let qv = vecs[0]
    if (vecs.length > 1) {
      const sum = new Float32Array(qv.length)
      for (const v of vecs) for (let i = 0; i < v.length; i++) sum[i] += v[i]
      qv = normalize(sum)
    }
    const scored = []
    for (const r of rows) {
      const v = toFloat(r.vec)
      scored.push({ id: r.id, score: cosine(qv, v) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((s, i) => ({ ...s, rank: i + 1 }))
  } catch {
    failUntil = Date.now() + FAIL_COOLDOWN_MS
    return null
  }
}

/** 排名奖励：第 1 名给满额，线性衰减到 0。默认 1 分（2 分会在弱向量时打乱排序，已实测）。 */
export function denseBonus(rank, { topN = 50, max = 1 } = {}) {
  if (!rank || rank < 1 || rank > topN) return 0
  return max * (1 - (rank - 1) / topN)
}

/**
 * 增量同步：写卡/改卡/删卡后按 path 补或删向量（写路径异步调用，失败静默）。
 * - 卡片还在主库 → 重新嵌入并覆盖；
 * - 卡片已不在主库（删除/进隔离区）→ 按 path 清掉向量；
 * - 未启用语义召回 → 直接返回，零网络。
 */
export async function syncCardVectors(root, paths = []) {
  const list = (Array.isArray(paths) ? paths : [paths]).map((p) => String(p || '')).filter(Boolean)
  if (!list.length) return { synced: 0, removed: 0 }
  const cfg = settingsFor(root)
  if (!cfg) return { synced: 0, removed: 0 }
  const db = getDb(root)
  ensureVecTable(db)
  let synced = 0
  let removed = 0
  for (const p of list) {
    const row = db.prepare('SELECT id, path, title, body FROM cards WHERE path = ? AND deleted_at IS NULL').get(p)
    if (!row) {
      try { removed += db.prepare('DELETE FROM card_vec WHERE path = ?').run(p).changes || 0 } catch { /* ignore */ }
      continue
    }
    try {
      const [v] = await embedTexts(cfg, [cardText(row)], { timeoutMs: 60000 })
      db.prepare("INSERT OR REPLACE INTO card_vec(id, path, model, dim, vec, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
        .run(row.id, p, cfg.model, v.length, toBuffer(v))
      synced++
    } catch { /* 单卡失败静默：下次全量 backfill 会补 */ }
  }
  return { synced, removed }
}
