// 记忆核心 · 检索索引（FTS5 + BM25）
//
// 这一层替换掉「全表扫描 + 子串计数」。本文件锁定：
//   1. 中文 bigram 切词（2 字词必须能搜到 —— FTS5 的 unicode61/trigram 都做不到）
//   2. 标题命中要排在正文命中前面（列权重生效）
//   3. 增量维护：写卡/改卡/删卡后，下一次检索立刻能看到，且不需要全量重建
//   4. 高频噪声词不得压过稀有词（IDF 生效）—— 这正是旧实现的病根
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tokenize, buildMatch, searchIndexed, ensureIndex, indexStats } from '../lib/search-index.js'
import { ensureVault, writeCard, search, deleteCard } from '../lib/vault.js'
import { getDb, closeAllDb } from '../lib/db.js'

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-search-idx-'))
after(async () => {
  closeAllDb()
  try { await fsp.rm(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
})

let n = 0
const freshRoot = async () => {
  const root = path.join(tmp, 'v' + n++)
  await ensureVault(root)
  return root
}
let seq = 0
const body = (tag) => {
  seq++
  let s = ''
  for (let i = 0; i < 60; i++) s += String.fromCharCode(0x4e00 + ((seq * 41 + i * 13) % 3000))
  return '[' + tag + '] ' + s
}

test('tokenize：中文 bigram、2 字词、英文词、单字', () => {
  assert.deepEqual(tokenize('检索'), ['检索'])
  assert.deepEqual(tokenize('数据库选型'), ['数据', '据库', '库选', '选型'])
  assert.deepEqual(tokenize('hello WORLD foo'), ['hello', 'world', 'foo'])
  assert.deepEqual(tokenize('中'), ['中'])
  assert.deepEqual(tokenize(''), [])
  // 混合：中文段与非中文段分别处理
  assert.ok(tokenize('用 FTS5 检索').includes('fts5'))
  assert.ok(tokenize('用 FTS5 检索').includes('检索'))
})

test('buildMatch：AND / OR 与引号转义', () => {
  assert.equal(buildMatch(['a', 'b'], 'and'), '"a" AND "b"')
  assert.equal(buildMatch(['a', 'b'], 'or'), '"a" OR "b"')
  assert.equal(buildMatch(['a"b']), '"a""b"')
  assert.equal(buildMatch([]), '')
})

test('2 字中文词能搜到（unicode61 / trigram 都做不到这件事）', async () => {
  const root = await freshRoot()
  await writeCard(root, { kind: 'knowledge', title: '检索能力实测', body: body('检索') + ' 这里讲检索精度的实测方法', status: 'approved' })
  const hits = await search(root, '检索')
  assert.ok(hits.length >= 1)
  assert.equal(hits[0].title, '检索能力实测')
})

test('标题命中排在正文命中之前（列权重生效）', async () => {
  const root = await freshRoot()
  await writeCard(root, { kind: 'knowledge', title: '普通标题', body: body('body-hit') + ' 缓存 一致性 讨论 在正文里出现', status: 'approved' })
  await writeCard(root, { kind: 'knowledge', title: '缓存 一致性 方案', body: body('title-hit') + ' 正文不含关键词', status: 'approved' })
  const hits = await search(root, '缓存')
  assert.ok(hits.length >= 2, '两张卡都应命中')
  assert.equal(hits[0].title, '缓存 一致性 方案', '标题命中的必须排前面')
})

test('IDF：高频噪声词不能压过稀有词（旧实现的病根）', async () => {
  const root = await freshRoot()
  // 10 张卡都含「用户」这个高频词；只有 1 张含稀有词「麒麟芯片」
  for (let i = 0; i < 10; i++) {
    await writeCard(root, { kind: 'knowledge', title: '用户反馈 ' + i, body: body('noise' + i) + ' 用户 用户 用户', status: 'approved' })
  }
  await writeCard(root, { kind: 'knowledge', title: '麒麟芯片 供应链', body: body('rare') + ' 麒麟芯片 的产能问题', status: 'approved' })
  const hits = await search(root, '麒麟芯片')
  assert.equal(hits[0].title, '麒麟芯片 供应链', '稀有词必须排第一')
})

test('增量维护：新增卡无需全量重建即可被搜到', async () => {
  const root = await freshRoot()
  await writeCard(root, { kind: 'knowledge', title: '第一张卡', body: body('a') + ' 关于 向量检索', status: 'approved' })
  await search(root, '向量检索') // 先触发一次索引
  await writeCard(root, { kind: 'knowledge', title: '第二张卡', body: body('b') + ' 关于 倒排索引 的实现', status: 'approved' })
  const hits = await search(root, '倒排索引')
  assert.ok(hits.some((h) => h.title === '第二张卡'), '增量索引必须立即可见')
})

test('删除后不再命中', async () => {
  const root = await freshRoot()
  const a = await writeCard(root, { kind: 'knowledge', title: '待删卡', body: body('del') + ' 独一无二的关键词 火漆印', status: 'approved' })
  assert.ok((await search(root, '火漆印')).length >= 1)
  await deleteCard(root, a.path)
  assert.equal((await search(root, '火漆印')).length, 0, '删卡后索引必须同步移除')
})

test('索引统计与重建入口可用', async () => {
  const root = await freshRoot()
  await writeCard(root, { kind: 'knowledge', title: '统计卡', body: body('stat'), status: 'approved' })
  const db = getDb(root)
  ensureIndex(db)
  const st = indexStats(db)
  assert.equal(st.indexed, 1)
  assert.equal(st.cards, 1)
})
