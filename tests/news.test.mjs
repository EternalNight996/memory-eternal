// 动态 / 新闻模块：用户自定义 Markdown，独立于记忆卡。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveNews, listNews, getNews, setNewsRead, deleteNews, parseNews } from '../lib/news.js'
import { listCards } from '../lib/vault.js'
import { createApi, API_PREFIX } from '../lib/api.js'
import { closeAllDb } from '../lib/db.js'

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'me-news-'))

test('新建 / 读取 / 更新 / 删除动态；内容存 Markdown', async () => {
  const root = makeRoot()
  const created = await saveNews(root, {
    title: 'v0.20.0 动态',
    category: '产品',
    source: 'GitHub',
    url: 'https://github.com/EternalNight996/memory-eternal',
    tags: ['release', 'news'],
    pinned: true,
    body: '# v0.20.0\n\n这是第一条用户自定义动态。',
  })
  assert.equal(created.ok, true, JSON.stringify(created))
  const id = created.item.id
  const file = path.join(root, 'news', id + '.md')
  assert.ok(fs.existsSync(file), '应写入 vault/news/*.md')
  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /^---/)
  assert.match(text, /pinned: true/)
  assert.match(text, /tag/)
  assert.equal(text.includes('这是第一条用户自定义动态'), true)

  const one = await getNews(root, id)
  assert.equal(one.title, 'v0.20.0 动态')
  assert.equal(one.category, '产品')
  assert.equal(one.pinned, true)

  const updated = await saveNews(root, { id, title: 'v0.20.0 动态（更新）', category: '产品', body: '更新后的正文。' })
  assert.equal(updated.ok, true)
  assert.equal(updated.item.id, id)
  const after = await getNews(root, id)
  assert.equal(after.title, 'v0.20.0 动态（更新）')
  assert.match(after.body, /更新后的正文/)

  const del = await deleteNews(root, id)
  assert.equal(del.ok, true)
  assert.equal(fs.existsSync(file), false)
})

test('列表：分类、搜索、置顶排序、未读计数、已读状态', async () => {
  const root = makeRoot()
  await saveNews(root, { title: '发布说明', category: '产品', tags: ['release'], body: '产品更新内容。', date: '2026-10-30' })
  await saveNews(root, { title: '团队周会', category: '团队', tags: ['meeting'], body: '周会结论与待办。', date: '2026-10-29', pinned: true })
  await saveNews(root, { title: '生态新闻', category: '生态', tags: ['dsh'], body: 'DSH 生态消息。', date: '2026-10-28' })

  let data = await listNews(root)
  assert.equal(data.counts.all, 3)
  assert.equal(data.counts.unread, 3)
  assert.equal(data.items[0].title, '团队周会', '置顶应排最前')
  assert.deepEqual(data.categories.sort(), ['产品', '团队', '生态'])

  data = await listNews(root, { category: '团队' })
  assert.equal(data.items.length, 1)
  assert.equal(data.items[0].title, '团队周会')

  data = await listNews(root, { q: 'DSH' })
  assert.equal(data.items.length, 1)
  assert.equal(data.items[0].title, '生态新闻')

  data = await listNews(root, { q: '产品 更新' })
  assert.equal(data.items.length >= 1, true, '多词 AND')

  const id = data.items[0].id
  await setNewsRead(root, id, true)
  data = await listNews(root)
  assert.equal(data.items.find((x) => x.id === id).read, true)
  assert.equal(data.counts.unread, 2)
  await setNewsRead(root, id, false)
  assert.equal((await listNews(root)).counts.unread, 3)
})

test('路径穿越被拒绝；动态不会变成记忆卡', async () => {
  const root = makeRoot()
  assert.equal(await getNews(root, '../memory-eternal.db'), null)
  assert.equal((await deleteNews(root, '../x')).ok, false)
  await saveNews(root, { title: '不应进记忆', body: '只存在于 news 目录。' })
  const cards = await listCards(root)
  assert.equal(cards.length, 0, '动态不能出现在记忆卡里')
})

test('API：/news 的增删查改与已读', async () => {
  const root = makeRoot()
  const api = createApi({ vaultDir: () => root, getSettings: () => ({}) })
  const call = async (route, { method = 'GET', body } = {}) => {
    const out = { status: 0, body: '' }
    const res = {
      req: { headers: {} },
      writeHead(s) { out.status = s },
      end(b) { out.body = String(b || '') },
      setHeader() {}, on() {}, once() {}, emit() {},
    }
    const iter = (async function* () { if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8') })()
    await api(Object.assign(iter, { url: API_PREFIX + route, method, headers: {} }), res)
    return { status: out.status, data: JSON.parse(out.body || 'null') }
  }

  const saved = await call('/news/save', { method: 'POST', body: { title: 'API 动态', category: '产品', body: '通过 API 写入。' } })
  assert.equal(saved.status, 200, JSON.stringify(saved))
  const id = saved.data.item.id
  const list = await call('/news')
  assert.equal(list.data.items.length, 1)
  assert.equal(list.data.items[0].title, 'API 动态')
  const one = await call('/news/item?id=' + encodeURIComponent(id))
  assert.equal(one.data.item.title, 'API 动态')
  const read = await call('/news/read', { method: 'POST', body: { id, read: true } })
  assert.equal(read.data.ok, true)
  const after = await call('/news')
  assert.equal(after.data.items[0].read, true)
  const del = await call('/news/delete', { method: 'POST', body: { id } })
  assert.equal(del.data.ok, true)
  assert.equal((await call('/news')).data.items.length, 0)
  closeAllDb()
})

test('UI：动态视图有导航、搜索、编辑器与阅读抽屉入口', () => {
  const src = fs.readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  for (const needle of ["newsTab:", "NewsPanel", "mc-news-search", "mc-news-reader", "mc-news-textarea", "'/news/save'", "'/news/delete'"]) {
    assert.ok(src.includes(needle), '缺少 ' + needle)
  }
})

test('frontmatter 解析：tags / pinned / url / 日期', () => {
  const item = parseNews('---\ntitle: 测试\ndate: 2026-10-30\ncategory: 产品\nsource: 博客\nurl: https://x.test\ntags: [a, b]\npinned: true\n---\n\n正文', 'x')
  assert.equal(item.title, '测试')
  assert.equal(item.category, '产品')
  assert.equal(item.url, 'https://x.test')
  assert.deepEqual(item.tags, ['a', 'b'])
  assert.equal(item.pinned, true)
  assert.equal(item.body, '正文')
})
