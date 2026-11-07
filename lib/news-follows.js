// 记忆核心 · 新闻「关注」（Follow）引擎
//
// 解决什么问题：原新闻模块是「编辑型推送」——固定 9 个源，搜索只在已拉到的 80 条缓存里做子串匹配。
// 于是「搜刘慈欣」= 0 条（不是搜不到，是根本没去搜），「帮我推 github 最新热门」更无处安放。
//
// 这里把「一次搜索」升级成「持久关注」：
//   一句话 → 解析成 { query, domains } → 按域去抓 → 缓存 → 并回主 feed。
//
// 三条边界（与原模块一致，不能破）：
//   1. **不做任意 URL 抓取器**：域只能来自 FOLLOW_DOMAINS 枚举，出站 URL 全部由常量拼装，
//      用户文本只会被 encodeURIComponent 进查询参数，绝不参与 host/path 选择。
//   2. 与知识卡、审核队列、星图完全隔离：只落 vault/news/follows.json。
//   3. 抓不到就如实报错（errors[]），不静默返回空 —— 「这个域没有」和「这个域没覆盖」是两回事。
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseFeedXml, classifyNews } from './news-feed.js'

const FOLLOWS_FILE = 'follows.json'
const CACHE_TTL_MS = 30 * 60 * 1000
const FETCH_TIMEOUT_MS = 12000
const MAX_ITEMS_PER_FOLLOW = 40
const MAX_FOLLOWS = 20
const UA = 'memory-eternal/news-follows (+https://github.com/EternalNight996/memory-eternal)'

/** 可关注的域。新增域必须同时在这里登记，并且出站 URL 必须是常量模板。 */
export const FOLLOW_DOMAINS = [
  { id: 'news', label: 'AI 资讯', hint: '现有 9 个白名单媒体（量子位 / 雷峰 / 钛媒体 / InfoQ / TC / Verge / MITTR / DeepMind / HN）' },
  { id: 'dsh', label: 'DSH 插件', hint: '官方插件清单（约 9 千个仓库，24 小时刷新；断网时回退本机快照）' },
  // 「热门库」= 新热（近 30 天创建、按 star）+ 老牌热门（近 14 天有推送、star>500）两路合并。
  // 原来只看「近 30 天创建」，于是 transformers / langchain 这类常青库永远进不来。
  { id: 'github', label: 'GitHub 热库', hint: '新热仓库 + 近两周活跃的高星仓库（按 star 排序）' },
  { id: 'skills', label: 'Agent 技能', hint: 'GitHub 上的 agent skills 仓库（topic:claude-skills / agent-skills，按 star）' },
  { id: 'plugins', label: 'Agent 插件', hint: 'Claude / MCP 生态插件仓库（topic:claude-plugins / mcp-server，按 star）' },
  { id: 'hn', label: 'Hacker News', hint: 'HN 全站全文检索' },
  { id: 'arxiv', label: 'arXiv', hint: '论文检索（无需 API Key）' },
]
const DOMAIN_IDS = new Set(FOLLOW_DOMAINS.map((d) => d.id))

/** 意图词：命中即认为用户想在那个域里看。只影响「选哪个域」，不影响 URL。 */
const DOMAIN_HINTS = [
  // 放在 github 之前：「dsh 插件」不该被 github 的「仓库」类词抢走
  // 注意：中文不能用 \b（JS 里 CJK 属 non-word，边界判断不可靠），直接匹配即可
  { id: 'dsh', re: /(dsh|deepseek\s*harness|插件市场)/i },
  // 技能/插件：用户说「agent 技能」「claude 插件」「mcp 服务」时，应该是生态域而不是 GitHub 泛搜
  { id: 'skills', re: /(技能|skills?|skill\.md|subagent(s)?)/i },
  { id: 'plugins', re: /(插件|plugins?|mcp\s*(server|服务)s?)/i },
  { id: 'github', re: /(github|仓库|开源项目|trending|热门项目|热库|repo(sitory)?)/i },
  { id: 'arxiv', re: /(arxiv|论文|paper|文献|预印本)/i },
  { id: 'hn', re: /(hacker\s*news|\bhn\b)/i },
]

/** 清洗用的 /g 正则（注意：带 g 的 lastIndex 会游走，只能用于 replace，不能拿来做域判断）。 */
const CLEAN_DOMAIN_RES = [
  /(dsh|deepseek\s*harness|插件市场)/gi,
  /(技能|skills?|skill\.md|subagent(s)?)/gi,
  /(插件|plugins?|mcp\s*(server|服务)s?)/gi,
  /(github|仓库|开源项目|trending|热门项目|热库|repositor(y|ies)|repo)/gi,
  /(arxiv|论文|paper|文献|预印本)/gi,
  /(hacker\s*news|\bhn\b)/gi,
]

/** 指令性噪音词：从主题里剥掉，剩下的才是真正要搜的东西。 */
const NOISE_RE = /(帮我|请|麻烦|推送|订阅|关注|跟踪|最新|热门|热库|最热|每天|每日|定时|一下|一些|几个|有什么|有啥|给我|看看|多显示|显示|最近|库|关于|相关|新闻|消息|资讯|动态|更新|上的|里的|方面|讨论)/g
// 只剥句尾虚词/单字（「新」只在结尾时剥：新能源这类词不会被误伤）
const STOP_TAIL_RE = /[的了呢吧吗新]$/g

/**
 * 已知媒体名 → sourceId。「量子位」「雷峰网」这类词不是主题词，
 * 而是**来源限定**：留在 query 里会变成"标题必须含量子位"的荒谬检索。
 */
const SOURCE_HINTS = [
  { re: /(量子位|qbitai)/i, id: 'qbitai' },
  { re: /(雷峰网|雷峰|leiphone)/i, id: 'leiphone' },
  { re: /(钛媒体|tmtpost)/i, id: 'tmtpost' },
  { re: /(infoq)/i, id: 'infoq' },
  { re: /(techcrunch)/i, id: 'techcrunch' },
  { re: /(the\s*verge|verge)/i, id: 'verge' },
  { re: /(mit\s*technology\s*review|mittr)/i, id: 'mittr' },
  { re: /(deepmind)/i, id: 'deepmind' },
]

const SOURCE_IDS = new Set(SOURCE_HINTS.map((h) => h.id))

function nowMs() { return Date.now() }

function followsPath(root) { return path.join(String(root || ''), 'news', FOLLOWS_FILE) }

async function readFileJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return fallback }
}

async function writeFileJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

/** 归一化用户输入：剥离指令词，留下主题。 */
export function cleanFollowQuery(text) {
  let s = String(text || '').trim()
  if (!s) return ''
  for (const re of CLEAN_DOMAIN_RES) s = s.replace(re, ' ')
  for (const h of SOURCE_HINTS) s = s.replace(h.re, ' ')
  s = s.replace(NOISE_RE, ' ')
    .replace(/[，。!？,.!?、；;:：()（）「」【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 只剩虚词尾巴时清掉（「多模态的」→「多模态」）
  s = s.replace(STOP_TAIL_RE, '').trim()
  return s
}

/**
 * 把一句话解析成关注意向（纯函数，便于单测）。
 * 不做 LLM：规则可预测、零成本、失败也不会静默改域名。
 * @param {string} text
 * @returns {{ query: string, domains: string[], label: string, notes: string[] }}
 */
export function parseFollowIntent(text) {
  const raw = String(text || '').trim()
  const notes = []
  const domains = []
  for (const hint of DOMAIN_HINTS) if (hint.re.test(raw)) domains.push(hint.id)
  // 「dsh 插件」归 DSH，不再额外拉一遍 Agent 插件域（DSH 清单本身就是插件）；
  // 只有明确说到 claude / codex / agent / mcp / 技能时，才认为用户要的是更广的生态。
  if (domains.includes('dsh') && !/(claude|codex|agent|mcp|技能|skills?)/i.test(raw)) {
    const i = domains.indexOf('plugins')
    if (i >= 0) domains.splice(i, 1)
  }
  if (!domains.length) domains.push('news')
  const query = cleanFollowQuery(raw)
  if (!query && domains.length === 1 && domains[0] === 'news') {
    notes.push('没有从这句话里识别出主题词；AI 资讯域需要一个关键词（例如「具身智能」）。')
  }
  if (domains.includes('news')) {
    notes.push('「AI 资讯」只覆盖现有 9 个白名单媒体；人物类话题（如作家、演员）他们通常不报道。')
  }
  if (domains.includes('dsh')) {
    notes.push('「DSH 插件」每 24 小时拉一次官方清单；拉不到时回退本机快照，并会标注来源。')
  }
  const sourceIds = SOURCE_HINTS.filter((h) => h.re.test(raw)).map((h) => h.id)
  if (sourceIds.length && domains.includes('news')) {
    notes.push('已按来源限定：' + sourceIds.join(' / '))
  }
  const label = query
    || (domains.includes('dsh') ? 'DSH 最新插件'
      : domains.includes('github') ? 'GitHub 热门'
      : domains.includes('arxiv') ? 'arXiv 论文'
      : domains.includes('hn') ? 'HN 讨论' : '关注')
  return { query, domains: [...new Set(domains)], sourceIds: [...new Set(sourceIds)], label, notes }
}

function clampDomains(list) {
  const out = (Array.isArray(list) ? list : []).map(String).filter((d) => DOMAIN_IDS.has(d))
  return out.length ? [...new Set(out)] : ['news']
}

async function fetchText(url, accept = '') {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': UA, ...(accept ? { accept } : {}) } })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return await r.text()
  } finally { clearTimeout(timer) }
}

function shape(extra) {
  return {
    id: extra.id || '',
    title: String(extra.title || '').trim(),
    url: String(extra.url || '').trim(),
    summary: String(extra.summary || '').trim(),
    image: extra.image || '',
    source: extra.source || '',
    sourceId: extra.sourceId || '',
    sourceWeight: Number(extra.sourceWeight) || 1,
    publishedAt: Number(extra.publishedAt) || nowMs(),
    points: Number(extra.points) || 0,
    comments: Number(extra.comments) || 0,
    type: extra.type || 'other',
    lang: extra.lang || 'zh',
    followId: extra.followId || '',
    followLabel: extra.followLabel || '',
  }
}

// ── 域适配器 ─────────────────────────────────────────────────────────────
// 每个适配器的出站地址都是常量模板；用户输入只进 query 参数。

/** GitHub 仓库检索（常量模板；无 token 时每分钟 10 次，调用方必须容错）。 */
async function githubSearch(q, perPage = 20) {
  const url = 'https://api.github.com/search/repositories?sort=stars&order=desc&per_page=' + perPage +
    '&q=' + encodeURIComponent(q)
  const data = JSON.parse(await fetchText(url, 'application/vnd.github+json'))
  return Array.isArray(data.items) ? data.items : []
}

/**
 * GitHub Trending 页面（daily）：不消耗 API 配额，且比「按 star 排」更贴近「热门」。
 * 结果在进程内缓存 10 分钟，多个关注/多个域共用一次抓取。
 */
let trendingCache = { at: 0, items: [] }

export function parseTrending(html) {
  const out = []
  const chunks = String(html).split('<h2 class="h3 lh-condensed">').slice(1)
  for (const chunk of chunks) {
    const repo = /href="\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"/.exec(chunk)
    if (!repo) continue
    const desc = /<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(chunk)
    const lang = /itemprop="programmingLanguage">([^<]+)</.exec(chunk)
    const today = /([\d,]+)\s+stars today/.exec(chunk)
    out.push({
      repo: repo[1],
      url: 'https://github.com/' + repo[1],
      desc: desc ? desc[1].replace(/<[^>]+>/g, '').trim() : '',
      lang: lang ? lang[1].trim() : '',
      // 榜单页只给「今日新增 star」，没有总数 —— 就拿它当热度，比解析一个不存在的字段诚实
      today: today ? Number(today[1].replace(/,/g, '')) || 0 : 0,
    })
  }
  return out
}

async function trendingRepos() {
  if (nowMs() - trendingCache.at < 10 * 60 * 1000 && trendingCache.items.length) return trendingCache.items
  const html = await fetchText('https://github.com/trending?since=daily')
  const items = parseTrending(html)
  if (items.length) trendingCache = { at: nowMs(), items }
  return items
}

function dedupeRepos(list) {
  const seen = new Map()
  for (const repo of list) {
    if (!repo || !repo.id) continue
    if (!seen.has(repo.id)) seen.set(repo.id, repo)
  }
  return [...seen.values()]
}

function repoToItem(repo, follow) {
  const desc = String(repo.description || '')
  return shape({
    id: 'gh-' + repo.id,
    title: repo.full_name + (desc ? ' — ' + desc : ''),
    url: repo.html_url,
    summary: [desc, repo.language, (repo.topics || []).slice(0, 4).join(' / ')].filter(Boolean).join(' · '),
    source: 'GitHub',
    sourceId: 'github',
    sourceWeight: 4,
    publishedAt: Date.parse(repo.created_at) || nowMs(),
    points: Number(repo.stargazers_count) || 0,
    comments: Number(repo.forks_count) || 0,
    type: 'opensource',
    lang: /[\u4e00-\u9fff]/.test(desc) ? 'zh' : 'en',
    followId: follow.id,
    followLabel: follow.label,
  })
}

function trendingItem(t, follow) {
  return shape({
    id: 'gh-trend-' + t.repo,
    title: t.repo + (t.desc ? ' — ' + t.desc : ''),
    url: t.url,
    summary: [t.desc, t.lang, t.today ? '+' + t.today + ' stars today' : ''].filter(Boolean).join(' · '),
    source: 'GitHub Trending',
    sourceId: 'github',
    sourceWeight: 5,
    publishedAt: nowMs(),
    points: t.today,
    comments: t.today,
    type: 'opensource',
    lang: /[\u4e00-\u9fff]/.test(t.desc) ? 'zh' : 'en',
    followId: follow.id,
    followLabel: follow.label,
  })
}

function dedupeItems(items) {
  const seen = new Map()
  for (const it of items) {
    if (!it || !it.url) continue
    const prev = seen.get(it.url)
    if (!prev || (it.points || 0) > (prev.points || 0)) seen.set(it.url, it)
  }
  return [...seen.values()].sort((a, b) => (b.points || 0) - (a.points || 0))
}

/**
 * GitHub 热库 = Trending 榜单（真·今日热门）。
 * 有关键词时再补一次定向搜索；没有关键词就只吃榜单，避免浪费 API 配额。
 */
async function fetchGithub({ query, follow }) {
  const trend = await trendingRepos().catch(() => [])
  let items = trend.slice(0, 25).map((t) => trendingItem(t, follow))
  if (query) {
    const activeSince = new Date(nowMs() - 14 * 86400000).toISOString().slice(0, 10)
    const found = await githubSearch(`${query} in:name,description,readme pushed:>${activeSince}`, 20).catch(() => [])
    items = items.concat(found.map((r) => repoToItem(r, follow)))
  }
  return dedupeItems(items).slice(0, MAX_ITEMS_PER_FOLLOW)
}

/** Agent 技能：今日榜单里像 skill 的 + topic:claude-skills 的搜索结果（各按 star）。 */
async function fetchSkills({ query, follow }) {
  const trend = await trendingRepos().catch(() => [])
  const local = trend.filter((t) => /skill/i.test(t.repo + ' ' + t.desc)).map((t) => trendingItem(t, follow))
  const base = query ? `${query} in:name,description,readme ` : ''
  const found = await githubSearch(`${base}topic:claude-skills stars:>50`, 20).catch(() => [])
  // 只认「名字或描述里真的有 skill」的仓库：单看 topic 会被 SEO 蹭词的高星仓库带偏
  const search = found.filter((r) => /skill/i.test(String(r.name || '') + ' ' + String(r.description || '')))
  return dedupeItems([...local, ...search.map((r) => repoToItem(r, follow))]).slice(0, MAX_ITEMS_PER_FOLLOW)
}

/** Agent 插件：今日榜单里像插件/MCP 的 + topic:claude-plugins 的搜索结果。 */
async function fetchPlugins({ query, follow }) {
  const trend = await trendingRepos().catch(() => [])
  const local = trend.filter((t) => /plugin|mcp/i.test(t.repo + ' ' + t.desc)).map((t) => trendingItem(t, follow))
  const base = query ? `${query} in:name,description,readme ` : ''
  const found = await githubSearch(`${base}topic:claude-plugins stars:>20`, 20).catch(() => [])
  const search = found.filter((r) => /plugin|mcp/i.test(String(r.name || '') + ' ' + String(r.description || '')))
  return dedupeItems([...local, ...search.map((r) => repoToItem(r, follow))]).slice(0, MAX_ITEMS_PER_FOLLOW)
}

async function fetchHn({ query, follow }) {
  const since = Math.floor((nowMs() - 30 * 86400000) / 1000)
  const url = 'https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=' + MAX_ITEMS_PER_FOLLOW +
    '&numericFilters=created_at_i>' + since + (query ? '&query=' + encodeURIComponent(query) : '&query=AI')
  const data = JSON.parse(await fetchText(url))
  const hits = Array.isArray(data.hits) ? data.hits : []
  return hits.map((h) => {
    const title = String(h.title || h.story_title || '').trim()
    if (!title) return null
    return shape({
      id: 'hn-' + h.objectID,
      title,
      url: String(h.url || h.story_url || '').trim() || ('https://news.ycombinator.com/item?id=' + h.objectID),
      summary: String(h.story_text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300),
      source: 'Hacker News',
      sourceId: 'hn',
      sourceWeight: 3,
      publishedAt: (Number(h.created_at_i) * 1000) || Date.parse(h.created_at) || nowMs(),
      points: Number(h.points) || 0,
      comments: Number(h.num_comments) || 0,
      type: classifyNews(title, h.story_text || ''),
      lang: 'en',
      followId: follow.id,
      followLabel: follow.label,
    })
  }).filter(Boolean)
}

async function fetchArxiv({ query, follow }) {
  const q = query || 'large language model'
  const url = 'http://export.arxiv.org/api/query?start=0&max_results=' + MAX_ITEMS_PER_FOLLOW +
    '&sortBy=submittedDate&sortOrder=descending&search_query=all:' + encodeURIComponent('"' + q + '"')
  const xml = await fetchText(url)
  const parsed = parseFeedXml(xml, { id: 'arxiv', name: 'arXiv', lang: 'en', weight: 4 })
  return parsed.map((it) => shape({
    ...it,
    type: 'research',
    followId: follow.id,
    followLabel: follow.label,
  }))
}

/** 「AI 资讯」域：只过滤**已经抓下来的**白名单内容，不再额外发请求。 */
async function fetchNewsDomain({ query, follow, root }) {
  const sourceIds = Array.isArray(follow.sourceIds) ? follow.sourceIds : []
  if (!query && !sourceIds.length) return []
  const { getNewsFeed } = await import('./news-feed.js')
  const r = await getNewsFeed(root, { period: 'month', lang: 'all', q: query })
  let items = Array.isArray(r.items) ? r.items : []
  // 来源限定：用户说「量子位」时，意思是"只看量子位"，不是"标题里要有量子位三个字"。
  if (sourceIds.length) items = items.filter((it) => sourceIds.includes(it.sourceId))
  return items.slice(0, MAX_ITEMS_PER_FOLLOW).map((it) => shape({
    ...it,
    followId: follow.id,
    followLabel: follow.label,
  }))
}

/**
 * 从 DSH 市场清单里挑插件（纯函数，便于单测）。
 * 排序：仓库更新时间新 → star 多。与「最新插件」的直觉一致。
 */
export function pickDshPlugins(repos, { query = '', maxItems = MAX_ITEMS_PER_FOLLOW } = {}) {
  const q = String(query || '').trim().toLowerCase()
  const list = (Array.isArray(repos) ? repos : []).filter((r) => r && r.full_name)
  const matched = q
    ? list.filter((r) => (String(r.name || '') + ' ' + String(r.description || '') + ' ' + (Array.isArray(r.topics) ? r.topics.join(' ') : '')).toLowerCase().includes(q))
    : list
  // 明确标了 non-plugin 的排后面（仍保留：有些"非插件"其实是 bundle/工具）
  const weight = (r) => (r.installable === 'non-plugin' ? 0 : 1)
  return matched
    .slice()
    .sort((a, b) =>
      weight(b) - weight(a) ||
      (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0) ||
      (Number(b.stargazers_count) || 0) - (Number(a.stargazers_count) || 0))
    .slice(0, Math.max(1, Number(maxItems) || MAX_ITEMS_PER_FOLLOW))
}

// ── DSH 插件清单：线上源 + 24h 缓存 + 本机快照回退 ─────────────────────
// 线上源是 dshmarket 包 package.json 里写明的官方地址（不是猜的）：
//   https://awesome-dsh-plugin.com/plugins.json
// 结构与本机 list-cache/dsh.json 不同：线上是 { plugins: [...] }，字段见 normalizeDshRegistry。
// 出站地址是常量，用户输入只参与关键词过滤 —— 仍然满足"不做任意 URL 抓取器"。
const DSH_REGISTRY_URL = 'https://awesome-dsh-plugin.com/plugins.json'
const DSH_REGISTRY_TTL_MS = 24 * 60 * 60 * 1000
const DSH_REGISTRY_FILE = 'dsh-registry.json'

function registryPath(root) { return path.join(String(root || ''), 'news', DSH_REGISTRY_FILE) }

/** 线上清单 → 内部统一形状（纯函数，便于单测）。 */
export function normalizeDshRegistry(raw, { now = nowMs() } = {}) {
  const plugins = Array.isArray(raw && raw.plugins) ? raw.plugins : []
  const repos = plugins.map((p) => {
    const name = String((p && p.name) || '').trim()
    const owner = String((p && p.owner) || '').trim()
    const full = owner ? owner + '/' + name : name
    const descRaw = p && p.description
    const desc = descRaw && typeof descRaw === 'object' ? (descRaw.zh || descRaw.en || '') : String(descRaw || '')
    // added = 收录日期（YYYY-MM-DD），全量 9111 条都有；用它当"最新"的排序轴
    const added = String((p && p.added) || '').trim()
    const ts = Date.parse(added) || 0
    return {
      full_name: full,
      name,
      description: String(desc).replace(/\s+/g, ' ').trim().slice(0, 300),
      html_url: String((p && (p.url || p.page)) || ''),
      stargazers_count: Number(p && p.stars) || 0,
      updated_at: ts ? new Date(ts).toISOString() : '',
      added,
      version: String((p && p.version) || ''),
      category: String((p && p.category) || ''),
      installable: 'plugin',
      topics: [],
    }
  }).filter((r) => r.full_name && r.html_url)
  return {
    savedAt: new Date(now).toISOString(),
    sourceUpdated: String((raw && raw.updated) || ''),
    count: repos.length,
    repos,
  }
}

async function readRegistryCache(root) {
  try { return JSON.parse(await fs.readFile(registryPath(root), 'utf8')) } catch { return null }
}

async function writeRegistryCache(root, data) {
  const file = registryPath(root)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8')
  await fs.rename(tmp, file)
}

/** 刷新线上清单（24h TTL）。失败抛错，由 loadDshMarket 回退。 */
export async function refreshDshRegistry(root, { force = false, now = nowMs() } = {}) {
  const cached = await readRegistryCache(root)
  if (!force && cached && Array.isArray(cached.repos) && cached.repos.length
    && now - (Date.parse(cached.fetchedAt) || 0) < DSH_REGISTRY_TTL_MS) {
    return { ...cached, fromCache: true }
  }
  const raw = JSON.parse(await fetchText(DSH_REGISTRY_URL, 'application/json'))
  const data = normalizeDshRegistry(raw, { now })
  data.fetchedAt = new Date(now).toISOString()
  await writeRegistryCache(root, data)
  return { ...data, fromCache: false }
}

/** 读本机市场清单（进程内按 mtime 缓存，9MB 不能每次重解析）。 */
let dshMarketCache = null
async function loadLocalMarket(env = process.env) {
  const home = (env && env.DSH_HOME) || path.join(os.homedir(), '.dsh')
  const file = path.join(home, 'marketplace', 'list-cache', 'dsh.json')
  const st = await fs.stat(file)
  if (dshMarketCache && dshMarketCache.mtimeMs === st.mtimeMs) return dshMarketCache.data
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  const data = { savedAt: String(raw.saved_at || ''), repos: Array.isArray(raw.repos) ? raw.repos : [] }
  dshMarketCache = { mtimeMs: st.mtimeMs, data }
  return data
}

async function loadDshMarket(root, { force = false } = {}) {
  try {
    const reg = await refreshDshRegistry(root, { force })
    return { repos: reg.repos, savedAt: reg.savedAt, sourceUpdated: reg.sourceUpdated, origin: 'live' }
  } catch (e) {
    // 线上不可用（断网 / 代理证书 / 站点故障）→ 回退本机市场快照，并如实标注来源
    try {
      const local = await loadLocalMarket()
      return { ...local, origin: 'snapshot', error: String((e && e.message) || e) }
    } catch (e2) {
      return { repos: [], savedAt: '', sourceUpdated: '', origin: 'none', error: String((e && e.message) || e) }
    }
  }
}

async function fetchDsh({ query, follow, root }) {
  const market = await loadDshMarket(root)
  const picked = pickDshPlugins(market.repos, { query, maxItems: MAX_ITEMS_PER_FOLLOW })
  return picked.map((repo) => {
    const desc = String(repo.description || '').replace(/\s+/g, ' ').trim()
    const stars = Number(repo.stargazers_count) || 0
    const updated = Date.parse(repo.updated_at) || 0
    return shape({
      id: 'dsh-' + repo.full_name,
      title: (repo.pkg_name || repo.name) + (desc ? ' — ' + desc.slice(0, 120) : ''),
      url: repo.html_url,
      summary: [
        repo.category,
        repo.version ? 'v' + repo.version : '',
        stars ? '★' + stars : '',
        updated ? '发布于 ' + new Date(updated).toISOString().slice(0, 10) : '',
        market.origin === 'snapshot' ? '本机快照' : '',
      ].filter(Boolean).join(' · '),
      source: 'DSH 插件市场',
      sourceId: 'dsh',
      sourceWeight: 4,
      publishedAt: updated || nowMs(),
      points: stars,
      comments: 0,
      type: 'opensource',
      lang: /[\u4e00-\u9fff]/.test(desc) ? 'zh' : 'en',
      followId: follow.id,
      followLabel: follow.label,
    })
  })
}

const ADAPTERS = {
  github: fetchGithub,
  skills: fetchSkills,
  plugins: fetchPlugins,
  hn: fetchHn,
  arxiv: fetchArxiv,
  news: fetchNewsDomain,
  dsh: fetchDsh,
}

/**
 * 执行一次关注抓取：按域并发，逐域收集错误（不因一个域失败就整体失败）。
 */
export async function runFollow(root, follow, { force = false, now = nowMs() } = {}) {
  const cached = follow.cache && Array.isArray(follow.cache.items) ? follow.cache : null
  if (!force && cached && now - (Number(cached.fetchedAt) || 0) < CACHE_TTL_MS) {
    return { ...follow, cache: cached, fromCache: true }
  }
  const domains = clampDomains(follow.domains)
  const errors = []
  const items = []
  // 并发抓：域之间互相独立，串行会让「GitHub 慢」拖垮整个关注。
  const results = await Promise.all(domains.map(async (d) => {
    const fn = ADAPTERS[d]
    if (!fn) return { d, items: [], error: '未知域' }
    try { return { d, items: await fn({ query: follow.query, follow, root }) } }
    catch (e) { return { d, items: [], error: String((e && e.message) || e) } }
  }))
  for (const r of results) {
    if (r.error) errors.push({ domain: r.d, error: r.error })
    items.push(...r.items)
  }
  // 去重：同一 URL 只留热度更高的一条（GitHub/HN 可能撞同一话题）。
  const byUrl = new Map()
  for (const it of items) {
    if (!it.url) continue
    const prev = byUrl.get(it.url)
    if (!prev || (it.points || 0) > (prev.points || 0)) byUrl.set(it.url, it)
  }
  const merged = [...byUrl.values()].sort((a, b) => (b.points || 0) - (a.points || 0) || (b.publishedAt || 0) - (a.publishedAt || 0))
  const cache = { fetchedAt: now, items: merged, errors }
  return { ...follow, cache, fromCache: false }
}

function normalizeFollow(raw) {
  const query = String(raw && raw.query || '').trim().slice(0, 120)
  const domains = clampDomains(raw && raw.domains)
  const label = String(raw && raw.label || '').trim().slice(0, 40) || query || '关注'
  const sourceIds = Array.isArray(raw && raw.sourceIds)
    ? [...new Set(raw.sourceIds.map(String).filter((x) => SOURCE_IDS.has(x)))].slice(0, 4)
    : []
  return {
    id: String(raw && raw.id || '') || 'f' + Math.random().toString(36).slice(2, 10),
    query,
    domains,
    sourceIds,
    label,
    createdAt: Number(raw && raw.createdAt) || nowMs(),
    lastRunAt: Number(raw && raw.lastRunAt) || 0,
    cache: raw && raw.cache && typeof raw.cache === 'object' ? raw.cache : null,
  }
}

export async function listFollows(root) {
  const data = await readFileJson(followsPath(root), { version: 1, follows: [] })
  const follows = Array.isArray(data.follows) ? data.follows.map(normalizeFollow) : []
  return follows
}

export async function saveFollow(root, input) {
  const data = await readFileJson(followsPath(root), { version: 1, follows: [] })
  const follows = Array.isArray(data.follows) ? data.follows.map(normalizeFollow) : []
  if (follows.length >= MAX_FOLLOWS) throw new Error('关注数量已达上限（' + MAX_FOLLOWS + ' 个）')
  const f = normalizeFollow(input)
  // 同一个 query + 同一组域 = 重复关注，直接返回已有的，避免堆叠。
  const dup = follows.find((x) => x.query === f.query && x.domains.join(',') === f.domains.join(',') && (x.sourceIds || []).join(',') === f.sourceIds.join(','))
  if (dup) return { ok: true, follow: dup, duplicate: true, follows }
  follows.push(f)
  // 保留 defaultSeeded 等元数据：丢掉它会让「生态速览」被删掉后又重新播种
  await writeFileJson(followsPath(root), { ...data, version: 1, follows })
  return { ok: true, follow: f, duplicate: false, follows }
}

/**
 * 首次打开新闻页时自动建一个「生态速览」关注（GitHub 热库 + Agent 技能 + Agent 插件）。
 *
 * 为什么用 defaultSeeded 标记而不是「列表为空就建」：用户删掉它之后不该反复被塞回来。
 * 只在第一次真正初始化时建一次。
 */
export async function ensureDefaultFollow(root) {
  const data = await readFileJson(followsPath(root), { version: 1, follows: [] })
  const follows = Array.isArray(data.follows) ? data.follows.map(normalizeFollow) : []
  if (data.defaultSeeded) return follows
  if (follows.length) {
    await writeFileJson(followsPath(root), { ...data, follows, defaultSeeded: true })
    return follows
  }
  const seeded = normalizeFollow({ label: '生态速览', query: '', domains: ['github', 'skills', 'plugins'] })
  await writeFileJson(followsPath(root), { version: 1, follows: [seeded], defaultSeeded: true })
  return [seeded]
}

export async function removeFollow(root, id) {
  const data = await readFileJson(followsPath(root), { version: 1, follows: [] })
  const follows = Array.isArray(data.follows) ? data.follows.map(normalizeFollow) : []
  const next = follows.filter((f) => f.id !== id)
  await writeFileJson(followsPath(root), { ...data, version: 1, follows: next })
  return { ok: true, removed: follows.length - next.length, follows: next }
}

/**
 * 刷新所有关注（有 TTL 保护；force 时全量重抓）。
 * 返回最新的 follows 数组，供 /news/follows 直接回给前端。
 */
export async function refreshFollows(root, { force = false, now = nowMs() } = {}) {
  const follows = await listFollows(root)
  const next = []
  for (const f of follows) {
    const ran = await runFollow(root, f, { force, now })
    next.push({ ...ran, lastRunAt: ran.fromCache ? f.lastRunAt : now })
  }
  await writeFileJson(followsPath(root), { version: 1, follows: next })
  return next
}

/** 把各关注的最新结果并成一批条目（供 /news/feed 合并）。 */
export async function followItems(root, follows) {
  const all = []
  for (const f of follows) {
    const cache = f.cache
    if (!cache || !Array.isArray(cache.items)) continue
    all.push(...cache.items)
  }
  const seen = new Set()
  return all.filter((it) => {
    const key = it.url || it.id
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
