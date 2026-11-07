// 记忆核心 · 新闻「关注」引擎（Follow）
//
// 这层要守的四件事：
//   1. 一句话 → 结构化关注：主题词剥干净、域只可能是白名单枚举里的值；
//   2. **不做任意 URL 抓取器**：任何非法域/来源都不得进入出站参数；
//   3. 关注持久化：新增 / 去重 / 删除 / 上限；
//   4. 有缓存时不打外网（TTL），没网络也能解释清楚。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  FOLLOW_DOMAINS, parseFollowIntent, cleanFollowQuery,
  listFollows, saveFollow, removeFollow, followItems, runFollow, pickDshPlugins, normalizeDshRegistry,
  ensureDefaultFollow, parseTrending,
} from '../lib/news-follows.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-news-follows-'))
after(async () => { try { await fs.rm(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄 */ } })
const fresh = async (name) => { const r = path.join(tmp, name); await fs.mkdir(r, { recursive: true }); return r }

test('意图解析：「github 最新热门」→ 只落 GitHub 域，主题词被剥空', () => {
  const r = parseFollowIntent('帮我推送github最新热门')
  assert.deepEqual(r.domains, ['github'])
  assert.equal(r.query, '', '指令词不该被当成仓库搜索词')
  assert.equal(r.label, 'GitHub 热门')
})

test('意图解析：人物词默认落 AI 资讯域，并明确告知覆盖不到', () => {
  const r = parseFollowIntent('刘慈欣')
  assert.deepEqual(r.domains, ['news'])
  assert.equal(r.query, '刘慈欣')
  assert.ok(r.notes.some((n) => n.includes('9 个白名单媒体')), '必须提前说清人物类话题大概率没有')
})

test('意图解析：虚词/论文/讨论等噪音要剥干净', () => {
  assert.equal(parseFollowIntent('订阅 arXiv 上的扩散模型论文').query, '扩散模型')
  assert.equal(parseFollowIntent('hacker news 里的 rust 讨论').query, 'rust')
  assert.deepEqual(parseFollowIntent('hacker news 里的 rust 讨论').domains, ['hn'])
})

test('意图解析：媒体名是「来源限定」，不是主题词', () => {
  const r = parseFollowIntent('每天给我看看量子位关于多模态的新闻')
  assert.equal(r.query, '多模态', '「量子位」留在 query 里会变成荒谬的标题检索')
  assert.deepEqual(r.sourceIds, ['qbitai'])
  assert.ok(r.notes.some((n) => n.includes('来源限定')))
})

test('安全：任何非法域都会被收敛到白名单内（不做任意 URL 抓取器）', async () => {
  const root = await fresh('v-sec')
  const out = await saveFollow(root, { query: 'x', domains: ['evil.com', 'http://attacker'], label: 'x' })
  assert.deepEqual(out.follow.domains, ['news'], '非法域必须被丢弃，回落到默认域')
  for (const d of out.follow.domains) assert.ok(FOLLOW_DOMAINS.some((x) => x.id === d))
})

test('安全：非法 sourceId 不会被持久化', async () => {
  const root = await fresh('v-src')
  const out = await saveFollow(root, { query: 'x', domains: ['news'], sourceIds: ['qbitai', '../../etc/passwd'], label: 'x' })
  assert.deepEqual(out.follow.sourceIds, ['qbitai'])
})

test('关注持久化：新增 / 去重 / 删除', async () => {
  const root = await fresh('v-crud')
  assert.equal((await listFollows(root)).length, 0)
  const a = await saveFollow(root, { query: '扩散模型', domains: ['arxiv'], label: '扩散模型' })
  assert.equal(a.duplicate, false)
  const b = await saveFollow(root, { query: '扩散模型', domains: ['arxiv'], label: '扩散模型' })
  assert.equal(b.duplicate, true, '同主题同域不该堆两个')
  assert.equal((await listFollows(root)).length, 1)
  await removeFollow(root, a.follow.id)
  assert.equal((await listFollows(root)).length, 0)
})

test('有缓存且未过期时不发网络请求', async () => {
  const root = await fresh('v-ttl')
  const follow = {
    id: 'f1', query: 'rust', domains: ['hn'], label: 'rust',
    cache: { fetchedAt: Date.now(), items: [{ url: 'https://a', title: 'A' }], errors: [] },
  }
  const ran = await runFollow(root, follow, { now: Date.now() })
  assert.equal(ran.fromCache, true)
  assert.equal(ran.cache.items.length, 1)
})

test('followItems 按 URL 去重', async () => {
  const follows = [
    { id: 'a', cache: { items: [{ url: 'https://x', title: 'X' }, { url: 'https://y', title: 'Y' }] } },
    { id: 'b', cache: { items: [{ url: 'https://x', title: 'X2' }] } },
  ]
  const items = await followItems(null, follows)
  assert.equal(items.length, 2)
})

test('意图解析：DSH 插件域（中文不用 \\b，单独输入「插件」也要命中）', () => {
  const a = parseFollowIntent('dsh 最新插件')
  assert.deepEqual(a.domains, ['dsh'])
  assert.equal(a.query, '')
  assert.equal(a.label, 'DSH 最新插件')
  // 注意：「插件」单独出现现在是 Agent 插件域；只有提到 dsh / 插件市场才归 DSH
  assert.deepEqual(parseFollowIntent('插件').domains, ['plugins'])
  assert.deepEqual(parseFollowIntent('帮我推送一些 dsh 插件').domains, ['dsh'])
  assert.ok(parseFollowIntent('dsh 最新插件').notes.some((n) => n.includes('快照')), '必须说明是本机快照')
})

test('意图解析：github 最新热库 → GitHub 域，主题词不残留「热库」', () => {
  const r = parseFollowIntent('github 最新热库')
  assert.deepEqual(r.domains, ['github'])
  assert.equal(r.query, '', '「热库」是指令词，不该变成仓库检索词')
})

test('pickDshPlugins：按更新时间排序、可按关键词过滤、插件优先于 non-plugin', () => {
  const repos = [
    { full_name: 'a/old', name: 'old', updated_at: '2026-01-01T00:00:00Z', stargazers_count: 999, installable: 'plugin' },
    { full_name: 'b/new', name: 'new', updated_at: '2026-09-01T00:00:00Z', stargazers_count: 1, installable: 'plugin' },
    { full_name: 'c/tool', name: 'tool', updated_at: '2026-09-02T00:00:00Z', stargazers_count: 5, installable: 'non-plugin' },
  ]
  const out = pickDshPlugins(repos, { maxItems: 3 })
  assert.deepEqual(out.map((r) => r.name), ['new', 'old', 'tool'], '插件优先，其次按更新时间；non-plugin 垫底')
  assert.deepEqual(pickDshPlugins(repos, { query: 'old' }).map((r) => r.name), ['old'])
})

test('normalizeDshRegistry：线上清单 → 统一形状，added 作为「最新」的时间轴', () => {
  const raw = {
    updated: '2026-11-05',
    plugins: [
      { name: 'A', owner: 'o1', url: 'https://github.com/o1/A', description: { zh: '中文描述', en: 'en' }, stars: 12, added: '2026-11-05', version: '1.0.0', category: 'ui' },
      { name: 'B', owner: 'o2', url: 'https://github.com/o2/B', description: { en: 'en only' }, stars: 0, added: '2026-10-01' },
      { name: 'bad-no-url' },
    ],
  }
  const out = normalizeDshRegistry(raw, { now: Date.UTC(2026, 10, 7) })
  assert.equal(out.count, 2, '缺 url 的条目被丢弃')
  assert.equal(out.sourceUpdated, '2026-11-05')
  assert.equal(out.repos[0].full_name, 'o1/A')
  assert.equal(out.repos[0].description, '中文描述', '中文描述优先')
  assert.ok(out.repos[0].updated_at.startsWith('2026-11-05'), 'added → updated_at')
  assert.equal(out.repos[1].description, 'en only', '没有中文时回退英文')
})

test('最新排序：added 越新越靠前（线上清单的真实语义）', () => {
  const repos = [
    { full_name: 'x/old', name: 'old', updated_at: '2026-10-01T00:00:00.000Z', stargazers_count: 900 },
    { full_name: 'x/new', name: 'new', updated_at: '2026-11-05T00:00:00.000Z', stargazers_count: 0 },
  ]
  assert.deepEqual(pickDshPlugins(repos, { maxItems: 2 }).map((r) => r.name), ['new', 'old'])
})

test('意图解析：agent 技能 / claude 插件 落到生态域', () => {
  assert.deepEqual(parseFollowIntent('看看最近的 agent 技能').domains, ['skills'])
  assert.deepEqual(parseFollowIntent('claude 插件 最新').domains, ['plugins'])
  assert.deepEqual(parseFollowIntent('mcp server 有什么新的').domains, ['plugins'])
  // 「dsh 插件」仍然优先归 DSH，不被生态域抢走
  assert.deepEqual(parseFollowIntent('dsh 插件').domains, ['dsh'])
})

test('域枚举包含新增的 skills / plugins', () => {
  const ids = FOLLOW_DOMAINS.map((d) => d.id)
  for (const id of ['github', 'skills', 'plugins']) assert.ok(ids.includes(id), id + ' 缺失')
})

test('ensureDefaultFollow：首次创建「生态速览」，删掉后不会再生', async () => {
  const root = await fresh('default-follow')
  const first = await ensureDefaultFollow(root)
  assert.equal(first.length, 1)
  assert.equal(first[0].label, '生态速览')
  assert.deepEqual(first[0].domains, ['github', 'skills', 'plugins'])

  // 再调一次：不重复创建
  const second = await ensureDefaultFollow(root)
  assert.equal(second.length, 1)

  // 用户删掉后：不应该被塞回来
  await removeFollow(root, first[0].id)
  const third = await ensureDefaultFollow(root)
  assert.equal(third.length, 0, '删掉后不该重新播种子')
})

test('parseTrending：从榜单 HTML 里解出 repo / 描述 / 今日 star', () => {
  const html = [
    '<h2 class="h3 lh-condensed">',
    '<a href="/anthropics/skills">x</a>',
    '<p class="col-9 color-fg-muted my-1 tmp-pr-4"> Public repository for Agent Skills </p>',
    '<span itemprop="programmingLanguage">Python</span>',
    '<svg></svg> 622 stars today',
  ].join('')
  const out = parseTrending(html)
  assert.equal(out.length, 1)
  assert.equal(out[0].repo, 'anthropics/skills')
  assert.equal(out[0].desc, 'Public repository for Agent Skills')
  assert.equal(out[0].today, 622)
})
