// 记忆核心 · 真实 AI 资讯聚合（RSS / Atom + Hacker News）
//
// 边界：
// - 只存标题、摘要、来源、链接、时间、热度；不转载全文，阅读原文跳外链。
// - 固定白名单源，不接受用户 URL，避免把插件变成任意 URL 抓取器。
// - 缓存到 <vault>/news/.feed-cache.json；页面打开/手动刷新时按 TTL 拉取。
// - 与知识卡、审核队列、知识星图完全隔离。
import fs from 'node:fs/promises'
import path from 'node:path'

const CACHE_TTL_MS = 20 * 60 * 1000
const FETCH_TIMEOUT_MS = 12000
const DAY = 86400000

/** 资讯类型（前端按这些 id 做筛选）。 */
export const NEWS_TYPES = [
  { id: 'model', label: '模型' },
  { id: 'product', label: '产品' },
  { id: 'research', label: '研究' },
  { id: 'opensource', label: '开源' },
  { id: 'industry', label: '行业' },
  { id: 'policy', label: '政策' },
  { id: 'other', label: '其他' },
]
const TYPE_IDS = new Set(NEWS_TYPES.map((x) => x.id))

/** 固定资讯源白名单。 */
export const NEWS_SOURCES = [
  { id: 'qbitai', name: '量子位', url: 'https://www.qbitai.com/feed', home: 'https://www.qbitai.com/', weight: 5, kind: 'rss' },
  { id: 'techcrunch', name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', home: 'https://techcrunch.com/', weight: 4, kind: 'rss' },
  { id: 'verge', name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', home: 'https://www.theverge.com/', weight: 4, kind: 'rss' },
  { id: 'mittr', name: 'MIT Technology Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', home: 'https://www.technologyreview.com/', weight: 4, kind: 'rss' },
  { id: 'deepmind', name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', home: 'https://deepmind.google/', weight: 5, kind: 'rss' },
  { id: 'hn', name: 'Hacker News', home: 'https://news.ycombinator.com/', weight: 3, kind: 'hn' },
]

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
}

function stripHtml(s) {
  return decodeEntities(String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function unwrapCdata(s) {
  const t = String(s || '').trim()
  const m = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(t)
  return m ? m[1] : t
}

function tagText(xml, name) {
  const re = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + name + '>', 'i')
  const m = re.exec(xml)
  return m ? unwrapCdata(m[1]).trim() : ''
}

function atomLink(xml) {
  const links = [...xml.matchAll(/<link\b([^>]*)\/?>(?:<\/link>)?/gi)].map((m) => m[1])
  for (const attrs of links) {
    const rel = (/rel=["']([^"']+)["']/i.exec(attrs) || [])[1] || 'alternate'
    const href = (/href=["']([^"']+)["']/i.exec(attrs) || [])[1]
    if (href && (rel === 'alternate' || rel === 'self')) return href
  }
  return ''
}

function parseDate(s) {
  const t = String(s || '').trim()
  if (!t) return 0
  const n = Date.parse(t)
  return Number.isFinite(n) ? n : 0
}

/** 极简 RSS / Atom 解析（只取列表需要的字段）。 */
export function parseFeedXml(xml, source = {}) {
  const text = String(xml || '')
  const chunks = [...text.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0])
  const atoms = [...text.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0])
  const blocks = chunks.length ? chunks : atoms
  const atom = !chunks.length && atoms.length > 0
  const items = []
  for (const block of blocks) {
    const title = stripHtml(tagText(block, 'title'))
    let link = ''
    if (atom) link = atomLink(block) || tagText(block, 'id')
    else link = tagText(block, 'link') || tagText(block, 'guid')
    if (!title || !link) continue
    const rawSummary = tagText(block, 'description') || tagText(block, 'summary') || tagText(block, 'content:encoded') || tagText(block, 'content')
    const summary = stripHtml(rawSummary).slice(0, 420)
    const published = parseDate(tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated') || tagText(block, 'dc:date'))
    const categories = [...block.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/gi)].map((m) => stripHtml(m[1])).filter(Boolean)
    items.push({
      title,
      url: link,
      summary,
      sourceId: source.id || '',
      source: source.name || '',
      sourceWeight: Number(source.weight) || 1,
      publishedAt: published || Date.now(),
      points: 0,
      comments: 0,
      type: classifyNews(title, summary + ' ' + categories.join(' ')),
    })
  }
  return items
}

/** 关键词分类；无法判断时归 other。 */
export function classifyNews(title, text = '') {
  const s = String(title || '') + '\n' + String(text || '')
  const rules = {
    model: /(大模型|模型|LLM|GPT|Claude|Gemini|Llama|Qwen|DeepSeek|Mistral|Grok|o1|o3|多模态|MoE|推理模型|参数|权重|fine-?tune|微调)/gi,
    product: /(产品|发布|上线|功能|应用|工具|平台|API|Agent|助手|插件|SDK|Copilot|浏览器|手机|硬件)/gi,
    research: /(论文|研究|实验|基准|benchmark|SOTA|成果|科学家|Nature|Science|arXiv|数据集|评测)/gi,
    opensource: /(开源|open[ -]?source|GitHub|仓库|权重开放|Apache|MIT 许可|Hugging Face)/gi,
    industry: /(融资|收购|合作|投资|营收|市场|公司|裁员|IPO|估值|芯片|算力|数据中心|英伟达|NVIDIA)/gi,
    policy: /(监管|法案|政策|合规|安全|治理|版权|诉讼|禁令|隐私|欧盟|白宫|政府)/gi,
  }
  let best = 'other'
  let bestScore = 0
  for (const [id, re] of Object.entries(rules)) {
    if (!TYPE_IDS.has(id)) continue
    const score = (s.match(re) || []).length
    if (score > bestScore) { best = id; bestScore = score }
  }
  return best
}

function canonicalUrl(raw) {
  try {
    const u = new URL(String(raw || ''))
    u.hash = ''
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'source']) u.searchParams.delete(k)
    return u.href.replace(/\/$/, '')
  } catch { return String(raw || '') }
}

function fingerprint(item) {
  return canonicalUrl(item.url) || (String(item.title || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 160))
}

function sourceFor(id) { return NEWS_SOURCES.find((s) => s.id === id) || null }

async function fetchText(url, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'memory-eternal/news-feed (+https://github.com/EternalNight996/memory-eternal)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.5' },
    })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await r.text()
  } finally { clearTimeout(timer) }
}

/** 抓取 Hacker News（日榜 + 月榜共用一次拉取）。 */
async function fetchHackerNews(sinceMs) {
  const since = Math.floor(sinceMs / 1000)
  const url = 'https://hn.algolia.com/api/v1/search?tags=story&query=AI&numericFilters=created_at_i>' + since + '&hitsPerPage=80'
  const data = JSON.parse(await fetchText(url))
  const hits = Array.isArray(data.hits) ? data.hits : []
  return hits.map((h) => {
    const title = String(h.title || h.story_title || '').trim()
    const target = String(h.url || h.story_url || '').trim() || ('https://news.ycombinator.com/item?id=' + h.objectID)
    if (!title) return null
    return {
      id: 'hn-' + h.objectID,
      title,
      url: target,
      // HN 的 story_text 常包含 HTML / 链接；只保留纯文本摘要，避免把 URL 当正文。
      summary: stripHtml(h.story_text || '').slice(0, 420),
      sourceId: 'hn',
      source: 'Hacker News',
      sourceWeight: 3,
      publishedAt: parseDate(h.created_at) || (Number(h.created_at_i) * 1000) || Date.now(),
      points: Number(h.points) || 0,
      comments: Number(h.num_comments) || 0,
      type: classifyNews(title, h.story_text || ''),
      hnId: String(h.objectID || ''),
    }
  }).filter(Boolean)
}

async function readCache(root) {
  try {
    const raw = await fs.readFile(path.join(root, 'news', '.feed-cache.json'), 'utf8')
    const data = JSON.parse(raw)
    return data && Array.isArray(data.items) ? data : null
  } catch { return null }
}

async function writeCache(root, data) {
  await fs.mkdir(path.join(root, 'news'), { recursive: true })
  await fs.writeFile(path.join(root, 'news', '.feed-cache.json'), JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/** 抓取全部来源，去重后返回。 */
export async function fetchNewsFeed({ now = Date.now() } = {}) {
  const errors = []
  const items = []
  const rss = NEWS_SOURCES.filter((s) => s.kind === 'rss')
  const results = await Promise.all(rss.map(async (source) => {
    try {
      const xml = await fetchText(source.url)
      return { source, items: parseFeedXml(xml, source) }
    } catch (e) {
      errors.push(source.name + '：' + String((e && e.message) || e))
      return { source, items: [] }
    }
  }))
  for (const r of results) items.push(...r.items)
  try {
    const hn = await fetchHackerNews(now - 30 * DAY)
    items.push(...hn)
  } catch (e) { errors.push('Hacker News：' + String((e && e.message) || e)) }

  const byKey = new Map()
  for (const item of items) {
    const key = fingerprint(item)
    if (!key) continue
    const prev = byKey.get(key)
    if (!prev) { byKey.set(key, item); continue }
    // 同一新闻多源命中：保留信息更全/热度更高的一条，并记录 alsoIn
    const better = (item.points || 0) > (prev.points || 0) || (item.summary || '').length > (prev.summary || '').length ? item : prev
    better.alsoIn = [...new Set([...(prev.alsoIn || []), ...(item.alsoIn || []), prev.source, item.source].filter((x) => x && x !== better.source))]
    byKey.set(key, better)
  }
  const merged = [...byKey.values()].sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
  return { items: merged.slice(0, 800), errors, fetchedAt: now }
}

let inflight = null
/** 读取缓存；过期则刷新。并发请求只发一次网络。 */
export async function refreshNewsFeed(root, { force = false, now = Date.now() } = {}) {
  const cache = await readCache(root)
  if (!force && cache && now - Number(cache.fetchedAt || 0) < CACHE_TTL_MS && cache.items.length) return cache
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const fresh = await fetchNewsFeed({ now })
      await writeCache(root, fresh)
      return fresh
    } catch (e) {
      if (cache) return { ...cache, stale: true, errors: [...(cache.errors || []), String((e && e.message) || e)] }
      throw e
    } finally { inflight = null }
  })()
  return inflight
}

/**
 * 查询资讯。
 * @param {object} opts
 * @param {'today'|'month'} [opts.period]
 * @param {string} [opts.type] 模型/产品/研究/开源/行业/政策/其他
 * @param {string} [opts.q]
 * @param {boolean} [opts.force] 强制刷新
 */
export async function getNewsFeed(root, { period = 'today', type = '', q = '', force = false, now = Date.now() } = {}) {
  const cache = await refreshNewsFeed(root, { force, now })
  const monthStart = now - 30 * DAY
  const dayStart = now - 2 * DAY
  let items = Array.isArray(cache.items) ? cache.items.slice() : []
  if (period === 'month') {
    items = items.filter((x) => (x.points || 0) > 0 && (x.publishedAt || 0) >= monthStart)
    items.sort((a, b) => (b.points || 0) - (a.points || 0) || (b.comments || 0) - (a.comments || 0))
  } else {
    items = items.filter((x) => (x.publishedAt || 0) >= dayStart)
    items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
  }
  if (type && TYPE_IDS.has(type)) items = items.filter((x) => x.type === type)
  if (q) {
    const terms = String(q).trim().toLowerCase().split(/\s+/).filter(Boolean)
    items = items.filter((x) => {
      const hay = [x.title, x.summary, x.source, x.type].join('\n').toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }
  if (period === 'month') {
    items = items.slice(0, 50).map((x, i) => ({ ...x, rank: i + 1, heat: (x.points || 0) + (x.comments || 0) * 2 }))
  } else {
    items = items.slice(0, 80)
  }
  const counts = {}
  for (const x of cache.items || []) if ((x.publishedAt || 0) >= (period === 'month' ? monthStart : dayStart)) counts[x.type] = (counts[x.type] || 0) + 1
  return {
    ok: true,
    period,
    items,
    types: NEWS_TYPES,
    counts,
    fetchedAt: Number(cache.fetchedAt) || 0,
    stale: !!cache.stale,
    errors: cache.errors || [],
    sources: NEWS_SOURCES.map((s) => ({ id: s.id, name: s.name, home: s.home })),
  }
}
