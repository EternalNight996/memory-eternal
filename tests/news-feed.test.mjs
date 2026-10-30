// 真实 AI 资讯聚合：解析、分类、缓存过滤、API 形状。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseFeedXml, classifyNews, getNewsFeed } from '../lib/news-feed.js'
import { createApi, API_PREFIX } from '../lib/api.js'
import { closeAllDb } from '../lib/db.js'

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'me-feed-'))
const DAY = 86400000

function seedCache(root, items, fetchedAt = Date.now()) {
  fs.mkdirSync(path.join(root, 'news'), { recursive: true })
  fs.writeFileSync(path.join(root, 'news', '.feed-cache.json'), JSON.stringify({ fetchedAt, items, errors: [] }), 'utf8')
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

  const atom = '<feed><entry><title>Research benchmark</title><link rel="alternate" href="https://example.com/b"/><summary>new benchmark</summary><updated>2026-10-30T10:00:00Z</updated></entry></feed>'
  const a = parseFeedXml(atom, { id: 'y', name: 'Atom', weight: 2 })
  assert.equal(a.length, 1)
  assert.equal(a[0].url, 'https://example.com/b')
  assert.equal(a[0].type, 'research')
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
    { title: '新模型发布', url: 'https://x/1', summary: '模型更新', source: '量子位', type: 'model', publishedAt: now - 3600000, points: 0, comments: 0 },
    { title: '本月热榜第一', url: 'https://x/2', summary: 'AI 讨论', source: 'Hacker News', type: 'product', publishedAt: now - 2 * DAY, points: 900, comments: 120 },
    { title: '本月热榜第二', url: 'https://x/3', summary: 'AI 讨论', source: 'Hacker News', type: 'research', publishedAt: now - 3 * DAY, points: 400, comments: 30 },
    { title: '很旧的新闻', url: 'https://x/4', summary: '旧', source: '量子位', type: 'industry', publishedAt: now - 40 * DAY, points: 0, comments: 0 },
  ])
  const day = await getNewsFeed(root, { period: 'today', now })
  assert.equal(day.items.some((x) => x.title === '很旧的新闻'), false)
  assert.equal(day.items[0].title, '新模型发布')

  const month = await getNewsFeed(root, { period: 'month', now })
  assert.equal(month.items[0].title, '本月热榜第一')
  assert.equal(month.items[0].rank, 1)
  assert.equal(month.items[1].rank, 2)
  assert.equal(month.items[0].heat, 900 + 120 * 2)

  const typed = await getNewsFeed(root, { period: 'month', type: 'research', now })
  assert.equal(typed.items.length, 1)
  assert.equal(typed.items[0].title, '本月热榜第二')
  assert.equal(typed.items[0].rank, 1, '按类型筛选后应重新从 #1 排名')

  const searched = await getNewsFeed(root, { period: 'today', q: '新模型', now })
  assert.equal(searched.items.length, 1)
  assert.equal(searched.types.length >= 7, true)
})

test('API：/news/feed 返回真实资讯形状', async () => {
  const root = makeRoot()
  const now = Date.now()
  seedCache(root, [
    { title: 'API 资讯', url: 'https://x/api', summary: '摘要', source: 'Example', type: 'model', publishedAt: now - 1000, points: 1, comments: 0 },
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
