// 记忆精炼 · 「矛盾扫描」（issue #36）
//
// 现有 /optimize 只按**相似度**聚类（>=0.55）并合并 —— 它解决「冗余」，但对「矛盾」是**危险**的：
// 两张语义相近、结论互斥的卡（两种不能同时成立的配置、已被推翻的旧结论）相似度同样很高，
// 会被当成重复、甚至被 mergeCards 合并掉（而 mergeCards 会**永久删除**源卡）。所以这里补另一半：
//
//   宽召回候选对 → LLM 只判「重复 / 补充 / 矛盾 / 无关」 → **人拍板**
//
// 两条硬约束：
//   1. 扫描**绝不写库**（纯预览）；
//   2. apply 必须由调用方显式给 action，且**只做可恢复动作**（keepA/keepB 送回收站、keepBoth 不动数据）；
//      决策记进 vault 下的 refine-decisions.json，避免同一对反复骚扰人。
import fs from 'node:fs'
import path from 'node:path'
import { getDb } from './db.js'
import { deleteCard, mergeCards, textSimilarity } from './vault.js'
import { callLlmJson, routeCandidates, stripRuntimeNoise, looksTruncated } from './capture.js'

const DECISIONS_FILE = 'refine-decisions.json'
const RELATIONS = new Set(['duplicate', 'complement', 'conflict', 'unrelated'])
const pairKey = (a, b) => [String(a), String(b)].sort().join(' | ')

/** 读取历史决策（不存在则空表）。 */
export function readDecisions(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, DECISIONS_FILE), 'utf8')) || {} } catch { return {} }
}

function writeDecisions(root, data) {
  const file = path.join(root, DECISIONS_FILE)
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

function rowsOf(root) {
  const db = getDb(root)
  return db.prepare("SELECT path, title, kind, body, updated_at FROM cards WHERE status = 'approved' ORDER BY updated_at DESC").all()
}

/**
 * 宽召回：相似度 >= minSim 的卡片对（默认 0.30，含**近重复**那一段 —— 恰恰因为一键优化会按相似度
 * 盲合并，语义相近但结论互斥的对（最危险的那种）必须也送进判别）。已决策过的对会被跳过。
 * 用正文前缀算相似度（全量 O(n²) 太贵），并跳过已做过决策的对。
 */
export async function refineCandidates(root, { minSim = 0.30, maxSim = 1.0, limit = 40, maxCards = 300 } = {}) {
  const rows = rowsOf(root).slice(0, Math.max(2, Number(maxCards) || 300))
  const decided = readDecisions(root)
  const lite = rows.map((r) => ({ path: r.path, title: r.title, kind: r.kind, body: String(r.body || ''), head: String(r.body || '').slice(0, 600) }))
  const out = []
  for (let i = 0; i < lite.length; i++) {
    for (let j = i + 1; j < lite.length; j++) {
      const a = lite[i], b = lite[j]
      if (decided[pairKey(a.path, b.path)]) continue
      const sim = textSimilarity(a.head, b.head)
      if (sim < minSim || sim > maxSim) continue
      out.push({
        a: { path: a.path, title: a.title, kind: a.kind, body: a.body.slice(0, 2000) },
        b: { path: b.path, title: b.title, kind: b.kind, body: b.body.slice(0, 2000) },
        sim: Math.round(sim * 1000) / 1000,
      })
    }
  }
  out.sort((x, y) => y.sim - x.sim)
  return out.slice(0, Math.max(1, Number(limit) || 40))
}

/** 容错解析判别输出（模型偶尔裹代码块或有前后话）。 */
export function parseJudge(text) {
  let s = String(text || '').trim()
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start >= 0 && end > start) s = s.slice(start, end + 1)
  let obj = null
  try { obj = JSON.parse(s) } catch { return null }
  if (!obj || typeof obj !== 'object') return null
  const relation = RELATIONS.has(String(obj.relation)) ? String(obj.relation) : 'unrelated'
  const keep = ['A', 'B', 'both'].includes(String(obj.keep)) ? String(obj.keep) : 'both'
  return {
    relation,
    keep,
    conflict: String(obj.conflict || '').slice(0, 300),
    reason: String(obj.reason || '').slice(0, 300),
  }
}

/** 交给模型判别一对卡片的关系（只输出 JSON）。 */
export async function judgeRefinePair(llm, route, a, b) {
  const system = [
    '你是本地知识库的「关系判别器」。给你两张已审核的知识卡，你只做一件事：判断它们的关系。',
    '只输出严格 JSON（不要 markdown 代码块、不要多余文字）：',
    '{"relation":"duplicate|complement|conflict|unrelated","conflict":"若矛盾，一句话说明冲突点；否则空串","keep":"A|B|both","reason":"一句话理由"}',
    '判定口径：',
    '- duplicate：说的基本是同一件事，可以合并；',
    '- complement：不冲突，且各自有独立价值，应当都保留；',
    '- conflict：结论 / 参数 / 做法**互斥**（例如两种不能同时成立的配置、旧结论已被新结论推翻）—— 这类必须人判断，不要建议自动合并；',
    '- unrelated：只是字面有点像，实际无关。',
    'keep：若必须只留一张，留哪张（A 或 B）；无法取舍或应当都留 → both。',
  ].join('\n')
  const pack = (tag, x) => '### 卡 ' + tag + '：' + x.title + '\n（路径 ' + x.path + '）\n' + String(x.body || '').slice(0, 1800)
  const user = [pack('A', a), pack('B', b), '请输出 JSON。'].join('\n\n')
  const res = await callLlmJson(llm, route, { system, user, maxTokens: 800, purpose: 'memory-refine-judge' })
  if (res.failure) return { failure: res.failure }
  const judge = parseJudge(res.text)
  if (!judge) return { failure: { code: 'UNPARSEABLE_OUTPUT', message: '判别输出不是合法 JSON：' + String(res.text || '').slice(0, 120) } }
  return { judge }
}

/**
 * 扫描：宽召回 → 逐对判别。**只读**，返回发现（不动任何卡片）。
 * @param {{llm:any, limit?:number, provider?:string, model?:string, minSim?:number, maxSim?:number}} opts
 */
export async function refineScan(root, { llm, limit = 12, provider, model, minSim, maxSim } = {}) {
  if (!llm) return { ok: false, error: '当前进程拿不到 llm 服务（请在 DSH 面板里跑，或由宿主触发）' }
  const cands = await refineCandidates(root, { minSim, maxSim })
  if (!cands.length) return { ok: true, findings: [], skipped: [], candidates: 0 }
  let routes = []
  try { routes = await routeCandidates(llm, { provider, model }) } catch { routes = [] }
  if (!routes.length) return { ok: false, error: '取不到模型路由（llm.listProviders 为空）' }
  const route = routes[0]
  const findings = []
  const skipped = []
  for (const c of cands.slice(0, Math.max(1, Number(limit) || 12))) {
    let r
    try { r = await judgeRefinePair(llm, route, c.a, c.b) } catch (e) { r = { failure: { code: 'EXCEPTION', message: String((e && e.message) || e) } } }
    if (r.failure) { skipped.push({ a: c.a.path, b: c.b.path, sim: c.sim, error: r.failure.code + ': ' + r.failure.message }); continue }
    if (r.judge.relation === 'unrelated') { skipped.push({ a: c.a.path, b: c.b.path, sim: c.sim, error: 'unrelated' }); continue }
    findings.push({ ...c, ...r.judge })
  }
  return { ok: true, candidates: cands.length, useModel: route.provider + '/' + route.model, findings, skipped }
}

/** 技能目录条目行的形态（与 capture.js 的噪声闸门同一口径）。 */
const CATALOG_LINE_RE = /^\s*[-*]\s*\x60[a-z0-9][a-z0-9-]{2,40}\x60:\s/

/**
 * 找出「注入垃圾卡」：正文其实是被注入的运行时文本（技能目录、system-reminder、环境快照…），
 * 剥掉噪声后几乎不剩人话。
 *
 * 为什么需要（实测）：库里已经有一批「- \`code-review\`: Review the changes…」这种**和对话毫无关系**的卡
 * —— DSH 的 available-skills 目录被当 user 消息注入，旧噪声闸门没挡住，于是被当成知识沉淀下来。
 * 新版本已不再生成，但**存量还在**。这里只做**提议**（返回清单，不动数据），由人决定回收。
 */
export async function findInjectedCards(root, { limit = 500 } = {}) {
  const rows = rowsOf(root).slice(0, Math.max(1, Number(limit) || 500))
  const out = []
  for (const r of rows) {
    const body = String(r.body || '')
    if (!body.trim()) continue
    const cleaned = stripRuntimeNoise(body)
    const ratio = body.length ? cleaned.length / body.length : 0
    const allLines = body.split('\n').filter((l) => l.trim())
    const catalogLines = allLines.filter((l) => CATALOG_LINE_RE.test(l)).length
    const reasons = []
    if (/<available_skills>|<system-reminder>/i.test(body)) reasons.push('含运行时注入标签')
    if (catalogLines >= 3 && catalogLines / Math.max(1, allLines.length) >= 0.3) reasons.push('技能目录条目 ' + catalogLines + ' 行')
    if (ratio < 0.35 && cleaned.length < 200) reasons.push('剥离注入后只剩 ' + cleaned.length + ' 字')
    if (looksTruncated(String(r.title || ''))) reasons.push('标题是碎片')
    if (reasons.length) out.push({ path: r.path, title: r.title, kind: r.kind, reasons, ratio: Math.round(ratio * 100) / 100, cleanedLen: cleaned.length })
  }
  return out
}

/**
 * 回收这些卡 —— **走回收站（可还原）**，不是永久删除；逐个报告失败项。
 * @param {{paths?:string[]}} opts
 */
export async function purgeInjected(root, { paths = [] } = {}) {
  const list = (Array.isArray(paths) ? paths : []).map((x) => String(x || '').trim()).filter(Boolean)
  if (!list.length) return { ok: false, error: '没有给出要回收的 path' }
  const removed = []
  const failed = []
  for (const p of list) {
    try {
      const r = await deleteCard(root, p)     // 默认非永久 → 进回收站
      if (r && r.ok === false) failed.push({ path: p, error: r.error || '删除失败' })
      else removed.push(p)
    } catch (e) { failed.push({ path: p, error: String((e && e.message) || e) }) }
  }
  return { ok: failed.length === 0, removed, failed, recoverable: true }
}

/**
 * 执行人的决定。**只做可恢复动作**：
 *   keepA / keepB → 另一张进**回收站**（deleteCard 默认非永久，可从回收中心还原）
 *   merge         → 走现有 mergeCards（新卡 pending 进审核队列）
 *   keepBoth      → 不动数据（常用于"前提不同、都留"）
 * 任何 action 都会把这一对记进 refine-decisions.json，避免下次扫描重复打扰。
 */
export async function refineApply(root, { a, b, action, note = '', relation = '' } = {}) {
  const pa = String(a || '').trim()
  const pb = String(b || '').trim()
  if (!pa || !pb) return { ok: false, error: '缺少 a / b' }
  const act = String(action || '').trim()
  if (!['keepA', 'keepB', 'merge', 'keepBoth'].includes(act)) return { ok: false, error: '未知动作：' + act + '（可选 keepA / keepB / merge / keepBoth）' }
  let result = { ok: true, action: act }
  if (act === 'keepA' || act === 'keepB') {
    const drop = act === 'keepA' ? pb : pa
    try {
      const r = await deleteCard(root, drop)                      // 默认进回收站，可还原
      result.removed = drop
      result.recoverable = true
      if (r && r.ok === false) { result.ok = false; result.error = r.error || '删除失败' }
    } catch (e) { result.ok = false; result.error = String((e && e.message) || e) }
  } else if (act === 'merge') {
    try {
      const r = await mergeCards(root, [pa, pb])
      result.merged = r
      if (!r || r.ok === false) { result.ok = false; result.error = (r && r.error) || '合并失败' }
    } catch (e) { result.ok = false; result.error = String((e && e.message) || e) }
  }
  if (result.ok) {
    const data = readDecisions(root)
    data[pairKey(pa, pb)] = { action: act, relation: String(relation || ''), note: String(note || '').slice(0, 500), at: Date.now() }
    try { writeDecisions(root, data) } catch (e) { result.recordError = String((e && e.message) || e) }
  }
  return result
}
