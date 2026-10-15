// issue #41：/write 传字符串 tags → writeCard 直接 JSON.stringify → **双重编码** → 读出来仍是字符串
// → 前端 tags.slice(...).map 抛错 → 整页黑屏（React 根组件挂载失败）。
// 这里守住三件事：① 写入口归一化；② 读路径也归一化（修既有坏数据）；③ 渲染层兜底（坏数据不许炸整棵树）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { normalizeTags, writeCard, listCards, readCard } from '../lib/vault.js'
import { getDb } from '../lib/db.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')

test('normalizeTags：数组 / JSON 字符串 / 逗号串 / 双重编码 / 垃圾输入 都收敛成数组', () => {
  assert.deepEqual(normalizeTags(['a', 'b']), ['a', 'b'])
  assert.deepEqual(normalizeTags('[\"a\",\"b\"]'), ['a', 'b'], 'JSON 字符串要解析成数组（这是 #41 的现场）')
  assert.deepEqual(normalizeTags('a, b ,c'), ['a', 'b', 'c'], '逗号串也照顾')
  assert.deepEqual(normalizeTags('\"[\\\"x\\\",\\\"y\\\"]\"'), ['x', 'y'], '双重编码的旧数据再剥一层')
  assert.deepEqual(normalizeTags(''), [])
  assert.deepEqual(normalizeTags(null), [])
  assert.deepEqual(normalizeTags(undefined), [])
  assert.deepEqual(normalizeTags({ a: 1 }), [], '非数组非字符串一律空数组')
  assert.deepEqual(normalizeTags('不是 JSON'), ['不是 JSON'], '解析失败就当单个标签，不再抛')
  assert.deepEqual(normalizeTags([1, ' b ', '']), ['1', 'b'], '数字转字符串、去空白、丢空项')
  assert.equal(normalizeTags(['x'.repeat(100)])[0].length, 30, '单个标签截断 30 字')
  assert.equal(normalizeTags(Array.from({ length: 40 }, (_, i) => 't' + i)).length, 20, '最多 20 个标签')
})

test('writeCard：tags 传字符串不再双重编码，读回来就是数组（含 /write 的调用形态）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-tags-'))
  try {
    const r = await writeCard(dir, {
      kind: 'knowledge', title: '标签归一化验证', tags: '[\"a\",\"b\"]',
      body: '# 标签归一化验证\n\n正文足够长，用来通过最小长度校验，内容无所谓。',
      status: 'pending', submittedBy: 'test',
    }, { dedup: false })
    assert.equal(r.ok, true)
    const cards = await listCards(dir, { status: ['pending', 'approved'] })
    const hit = cards.find((c) => c.path === r.path)
    assert.ok(Array.isArray(hit.tags), '读出来必须是数组（不是字符串）—— 否则前端会黑屏')
    assert.deepEqual(hit.tags, ['a', 'b'])
    const one = await readCard(dir, r.path, { allowUnapproved: true })
    assert.equal(one.path, r.path, 'readCard 也要能读回这张卡（它返回 {path,status,text}）')
    // 直接看落库形态：必须是 ["a","b"]，不是 "["a","b"]"
    const raw = getDb(dir).prepare('SELECT tags FROM quarantine WHERE path = ?').get(r.path)
    assert.equal(raw.tags, JSON.stringify(['a', 'b']), '落库不能是双重编码')
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('读路径兜底：库里已有的「双重编码」坏数据也能读成数组（不必等用户手工修）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-tags-legacy-'))
  try {
    const db = getDb(dir)
    // 模拟 #41 现场：tags 列里存的是「一个字符串的 JSON 表示」
    db.prepare('INSERT INTO cards (id, path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(9001, '03-Knowledge/legacy-bad-tags.md', 'knowledge', '旧坏数据', JSON.stringify('[\"a\",\"b\"]'), '# 旧坏数据\n正文', '旧坏数据', 'approved', '', 'test', 'info', '', new Date().toISOString(), new Date().toISOString())
    const cards = await listCards(dir, { status: ['approved'] })
    const hit = cards.find((c) => c.path === '03-Knowledge/legacy-bad-tags.md')
    assert.ok(hit, '坏数据卡本身要能列出来（不能因为它就整页不可用）')
    assert.deepEqual(hit.tags, ['a', 'b'], '双重编码的旧数据也必须被归一化')
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('渲染层兜底：坏 tags 不许把整棵 React 树带走（源码守卫）', () => {
  const client = read('src/client/index.tsx')
  assert.match(client, /const tagsOf = \(c\) => \(Array\.isArray\(c && c\.tags\) \? c\.tags : \[\]\)/, '要有渲染层兜底函数')
  assert.match(client, /tagsOf\(card\)\.length > 0/, '卡片列表要走兜底')
  assert.match(client, /tagsOf\(card\)\.slice\(0, 4\)/, '卡片列表渲染标签要走兜底')
  assert.match(client, /\(Array\.isArray\(tags\) \? tags : \[\]\)\.slice\(0, 8\)/, '卡片阅读器的标签也要兜底')
  assert.doesNotMatch(client, /card\.tags\.slice\(/, '不许再直接对 card.tags 调 slice')
})
