// 界面改进（标签点击筛选）：/cards?tag= 的服务端过滤 + 客户端接线守卫。
// 关键点：tags 列是 JSON 数组字符串，必须按「带引号的完整标签」匹配 —— "a" 不能命中 "ab"。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeCard, listCards, countCards } from '../lib/vault.js'
import { snippetAround } from '../src/client/snippet.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

test('listCards/countCards 支持按标签过滤，且不会把 "a" 命中 "ab"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-tagfilter-'))
  try {
    const mk = (title, tags) => writeCard(dir, { kind: 'knowledge', title, tags, body: '# ' + title + '\n\n正文足够长，用于通过最小长度校验，内容不重要。', status: 'pending', submittedBy: 'test' }, { dedup: false })
    await mk('卡一', ['alpha', '共同'])
    await mk('卡二', ['ab', '共同'])
    await mk('卡三', ['beta'])
    const all = await listCards(dir, { status: ['pending'] })
    assert.equal(all.length, 3)
    const onlyAlpha = await listCards(dir, { status: ['pending'], tag: 'alpha' })
    assert.deepEqual(onlyAlpha.map((c) => c.title).sort(), ['卡一'], '"alpha" 只命中卡一')
    const onlyAB = await listCards(dir, { status: ['pending'], tag: 'ab' })
    assert.deepEqual(onlyAB.map((c) => c.title).sort(), ['卡二'], '"ab" 只命中卡二（前缀不串）')
    const common = await listCards(dir, { status: ['pending'], tag: '共同' })
    assert.equal(common.length, 2, '共享标签命中两张')
    assert.equal(await countCards(dir, { status: ['pending'], tag: 'alpha' }), 1, 'countCards 也要跟着过滤')
    assert.equal(await countCards(dir, { status: ['pending'] }), 3)
    // 标题排序路径（另一条 SQL 分支）同样要过滤
    const byTitle = await listCards(dir, { status: ['pending'], tag: '共同', sort: 'title' })
    assert.equal(byTitle.length, 2, 'sort=title 分支也要应用标签过滤')
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('搜索命中片段：截取关键词附近、折叠空白、两端加省略号、无命中返回空', () => {
  const long = '前面'.repeat(60) + '关键结论：停流后不回调参数' + '后面'.repeat(60)
  const sn = snippetAround(long, '关键结论', 20)
  assert.match(sn, /关键结论/, '必须包含关键词')
  assert.ok(sn.startsWith('…') && sn.endsWith('…'), '两头截断要有省略号')
  assert.equal(snippetAround('a\n\n  b', 'b', 10), 'a b', '换行/多空格折叠成单空格')
  assert.equal(snippetAround('abc', 'zzz'), '')
  assert.equal(snippetAround('', 'x'), '')
  assert.equal(snippetAround('abc', ''), '')
})

test('接线守卫：客户端把标签筛选接进请求、芯片可点、片段渲染在列表里', () => {
  const src = read('src/client/index.tsx')
  assert.match(src, /qs\.set\('tag', tagQ\)/, '请求要带 tag')
  assert.match(src, /const \[tagPick, setTagPick\] = useState\(''\)/);
  assert.match(src, /const onTagPick = \(tag\) => \{/, '要有统一的筛选入口')
  assert.match(src, /loadCards\(kind, query, statusFilter, \{ tag: next \}\)/, '同一 tick 用显式参数（避免读到旧 state）')
  assert.match(src, /🏷 \{tagPick\} <span style=\{\{ opacity: 0\.7 \}\}>✕<\/span>/, '工具栏要显示可清除的筛选芯片')
  assert.match(src, /className="mc-tag mc-tag-click"/, '列表标签可点')
  assert.match(src, /className="md-chip md-chip-tag mc-tag-click"/, '阅读器标签也可点')
  assert.match(src, /const sn = snippetAround\(card\.body \|\| '', query\)/, '列表要渲染命中片段')
  const api = read('lib/api.js')
  assert.match(api, /const tag = \(query\.get\('tag'\) \|\| ''\)\.trim\(\)/)
  assert.match(api, /countCards\(vaultRoot, \{ status: want, kind, agent, tag \}\)/)
})
