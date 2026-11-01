// 真实 AI 资讯聚合：解析、分类、缓存过滤、API 形状。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseFeedXml, classifyNews, getNewsFeed, sanitizeImageUrl, pickFeedImage } from '../lib/news-feed.js'
import { createApi, API_PREFIX } from '../lib/api.js'
import { closeAllDb } from '../lib/db.js'

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'me-feed-'))
const DAY = 86400000

function seedCache(root, items, fetchedAt = Date.now()) {
  fs.mkdirSync(path.join(root, 'news'), { recursive: true })
  fs.writeFileSync(path.join(root, 'news', '.feed-cache.json'), JSON.stringify({ fetchedAt, archiveFetchedAt: fetchedAt, items, errors: [] }), 'utf8')
}

test('RSS / Atom 解析：标题、链接、摘要、时间、分类', () => {
  const rss = '<rss><channel><item><title><![CDATA[OpenAI 发布新模型]]></title><link>https://example.com/a</link><description><![CDATA[<p>模型能力更新</p>]]></description><pubDate>Wed, 30 Oct 2026 10:00:00 GMT</pubDate><category>模型</category></item></channel></rss>'
  const items = parseFeedXml(rss, { id: 'x', name: 'Example', weight: 4 })
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'OpenAI 发布新模型')
  assert.equal(items[0].url, 'https://example.com/a')
  assert.equal(items[0].summary, '模型能力更新')
  assert.equal(items[0].source, 'Example')
  assert.equal(items[0].type, 'model')

  const escaped = '<rss><channel><item><title>InfoQ</title><link>https://example.com/c</link><description>&lt;div&gt;&lt;a href=&quot;https://x&quot;&gt;点击阅读原文&lt;/a&gt;&lt;/div&gt;</description></item></channel></rss>'
  const e = parseFeedXml(escaped, { id: 'z', name: 'InfoQ', weight: 3 })
  assert.equal(e[0].summary, '点击阅读原文')

  const atom = '<feed><entry><title>Research benchmark</title><link rel="alternate" href="https://example.com/b"/><summary>new benchmark</summary><updated>2026-10-30T10:00:00Z</updated></entry></feed>'
  const a = parseFeedXml(atom, { id: 'y', name: 'Atom', weight: 2 })
  assert.equal(a.length, 1)
  assert.equal(a[0].url, 'https://example.com/b')
  assert.equal(a[0].type, 'research')
})

test('缩略图：media:content / enclosure / 转义 HTML 首图，拒绝 svg/gif/超大 URL', () => {
  const xml = (inner) => '<rss><channel><item>' + inner + '</item></channel></rss>'
  const src = { id: 'x', name: 'Example', weight: 1 }

  assert.equal(
    parseFeedXml(xml('<title>图A</title><link>https://example.com/a</link><media:content url="https://cdn.example.com/a.jpg"/>'), src)[0].image,
    'https://cdn.example.com/a.jpg',
  )
  assert.equal(
    parseFeedXml(xml('<title>图B</title><link>https://example.com/b</link><enclosure url="https://cdn.example.com/b.png" type="image/png"/>'), src)[0].image,
    'https://cdn.example.com/b.png',
  )
  // description 里的 &lt;img …&gt; 是转义 HTML，必须先解码才能取到首图
  assert.equal(
    parseFeedXml(xml('<title>图C</title><link>https://example.com/c</link><description>&lt;p&gt;&lt;img src=&quot;https://cdn.example.com/c.webp&quot;/&gt; 正文&lt;/p&gt;</description>'), src)[0].image,
    'https://cdn.example.com/c.webp',
  )
  assert.equal(parseFeedXml(xml('<title>无图</title><link>https://example.com/d</link>'), src)[0].image, '')

  // svg / gif / 非 http(s) / 超长 URL 一律拒绝
  assert.equal(sanitizeImageUrl('https://cdn.example.com/logo.svg'), '')
  assert.equal(sanitizeImageUrl('https://cdn.example.com/a.gif'), '')
  assert.equal(sanitizeImageUrl('javascript:alert(1)'), '')
  assert.equal(sanitizeImageUrl('https://cdn.example.com/' + 'a'.repeat(950) + '.png'), '')
  // 坏图跳过，继续挑下一张能用的
  assert.equal(pickFeedImage('<media:content url="https://cdn.example.com/x.svg"/><media:content url="https://cdn.example.com/ok.jpg"/>', ''), 'https://cdn.example.com/ok.jpg')
})

test('分类：模型 / 产品 / 研究 / 开源 / 行业 / 政策', () => {
  assert.equal(classifyNews('OpenAI 发布 GPT-5 模型'), 'model')
  assert.equal(classifyNews('新版 AI 助手 App 上线'), 'product')
  assert.equal(classifyNews('论文提出新的 benchmark'), 'research')
  assert.equal(classifyNews('开源仓库在 GitHub 发布权重'), 'opensource')
  assert.equal(classifyNews('英伟达数据中心营收创新高'), 'industry')
  assert.equal(classifyNews('欧盟通过 AI 监管法案'), 'policy')
  assert.equal(classifyNews('今天天气不错'), 'other')
})

test('今日 / 本月热榜 / 类型 / 搜索过滤（使用缓存，不联网）', async () => {
  const root = makeRoot()
  const now = Date.now()
  seedCache(root, [
    { title: '新模型发布', url: 'https://x/1', summary: '模型更新', source: '量子位', type: 'model', lang: 'zh', publishedAt: now - 3600000, points: 0, comments: 0 },
    { title: '本月热榜第一', url: 'https://x/2', summary: 'AI 讨论', source: 'Hacker News', type: 'product', lang: 'en', publishedAt: now - 2 * DAY, points: 900, comments: 120 },
    { title: '本月热榜第二', url: 'https://x/3', summary: 'AI 讨论', source: 'Hacker News', type: 'research', lang: 'en', publishedAt: now - 3 * DAY, points: 400, comments: 30 },
    { title: '很旧的新闻', url: 'https://x/4', summary: '旧', source: '量子位', type: 'industry', lang: 'zh', publishedAt: now - 40 * DAY, points: 0, comments: 0 },
  ])
  const day = await getNewsFeed(root, { period: 'today', now })
  assert.equal(day.items.some((x) => x.title === '很旧的新闻'), false)
  assert.equal(day.items[0].title, '新模型发布')
  assert.equal(day.lang, 'zh')

  // 中文月榜按时间归档，不伪造 HN 分数排名
  const zhMonth = await getNewsFeed(root, { period: 'month', lang: 'zh', now })
  assert.equal(zhMonth.ranking, false)
  assert.equal(zhMonth.items[0].title, '新模型发布')

  const month = await getNewsFeed(root, { period: 'month', lang: 'en', now })
  assert.equal(month.ranking, true)
  assert.equal(month.items[0].title, '本月热榜第一')
  assert.equal(month.items[0].rank, 1)
  assert.equal(month.items[1].rank, 2)
  assert.equal(month.items[0].heat, 900 + 120 * 2)

  const typed = await getNewsFeed(root, { period: 'month', lang: 'en', type: 'research', now })
  assert.equal(typed.items.length, 1)
  assert.equal(typed.items[0].title, '本月热榜第二')
  assert.equal(typed.items[0].rank, 1, '按类型筛选后应重新从 #1 排名')

  const searched = await getNewsFeed(root, { period: 'today', q: '新模型', now })
  assert.equal(searched.items.length, 1)
  assert.equal(searched.types.length >= 7, true)
})

test('lang=all：一次请求拿中英全部条目；月榜排名只看真实热度', async () => {
  const root = makeRoot()
  const now = Date.now()
  seedCache(root, [
    { title: '中文今日', url: 'https://x/zh1', summary: '模型更新', source: '量子位', type: 'model', lang: 'zh', publishedAt: now - 3600000, points: 0, comments: 0 },
    { title: 'English today', url: 'https://x/en1', summary: 'AI discussion', source: 'Hacker News', type: 'product', lang: 'en', publishedAt: now - 7200000, points: 300, comments: 40 },
  ])

  // 「不限」= lang=all / 空值：不过滤语言
  const all = await getNewsFeed(root, { period: 'today', lang: 'all', now })
  assert.equal(all.lang, '')
  assert.equal(all.items.some((x) => x.lang === 'zh'), true, '「不限」里必须有中文')
  assert.equal(all.items.some((x) => x.lang === 'en'), true, '「不限」里必须有英文')
  const blank = await getNewsFeed(root, { period: 'today', lang: '', now })
  assert.equal(blank.items.length, all.items.length, '空 lang 与 all 等价')

  // 「英文」必须是英文条目
  const en = await getNewsFeed(root, { period: 'today', lang: 'en', now })
  assert.equal(en.items.length, 1)
  assert.equal(en.items[0].lang, 'en')

  // 本月 + 英文：有真实热度 → 出现排名与热度
  const enMonth = await getNewsFeed(root, { period: 'month', lang: 'en', now })
  assert.equal(enMonth.ranking, true)
  assert.equal(enMonth.items.every((x) => x.lang === 'en'), true)
  assert.equal(enMonth.items[0].rank, 1)
  assert.equal(enMonth.items[0].heat, 300 + 40 * 2)

  // 本月 + 中文：没有公开热度 → 归档视图，不伪造排名
  const zhMonth = await getNewsFeed(root, { period: 'month', lang: 'zh', now })
  assert.equal(zhMonth.ranking, false)
  assert.equal(zhMonth.items.every((x) => x.rank === undefined), true)

  // 本月 + 不限：中英都要在（中文不能被 points=0 过滤掉），且只有真实热度条目有排名
  const mixMonth = await getNewsFeed(root, { period: 'month', lang: 'all', now })
  assert.equal(mixMonth.ranking, true)
  assert.equal(mixMonth.items.some((x) => x.lang === 'zh'), true, '不限语言的月榜里中文归档仍要出现')
  assert.equal(mixMonth.items.filter((x) => (x.points || 0) > 0).every((x) => x.rank > 0), true)
  assert.equal(mixMonth.items.filter((x) => (x.points || 0) === 0).every((x) => x.heat === 0), true)
})

test('API：/news/feed 返回真实资讯形状', async () => {
  const root = makeRoot()
  const now = Date.now()
  seedCache(root, [
    { title: 'API 资讯', url: 'https://x/api', summary: '摘要', source: 'Example', type: 'model', lang: 'zh', publishedAt: now - 1000, points: 1, comments: 0 },
  ], now)
  const api = createApi({ vaultDir: () => root, getSettings: () => ({}) })
  const out = { status: 0, body: '' }
  const res = { req: { headers: {} }, writeHead(s) { out.status = s }, end(b) { out.body = String(b || '') }, setHeader() {}, on() {}, once() {}, emit() {} }
  await api({ url: API_PREFIX + '/news/feed?period=today', method: 'GET', headers: {} }, res)
  const data = JSON.parse(out.body)
  assert.equal(out.status, 200, out.body)
  assert.equal(data.ok, true)
  assert.equal(data.items[0].title, 'API 资讯')
  assert.equal(Array.isArray(data.types), true)
  closeAllDb()
})
