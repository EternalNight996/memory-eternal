// 记忆核心 · 关注摘要（Digest）
//
// 守三件事：
//   1. 只挑「窗口内 + 去重 + 按热度」的条目，宁少勿滥；
//   2. 注入文本必须要求「一两句话带过」，否则模型会把标题念一遍，比不推还烦；
//   3. consumedAt 机制：同一份摘要只进一轮会话，不刷屏。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pickDigestItems, digestPrompt, writeDigest, readDigest, consumeDigest } from '../lib/news-digest.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-digest-'))
after(async () => { try { await fs.rm(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄 */ } })

const NOW = 1_800_000_000_000
const item = (over = {}) => ({
  title: 'T', url: 'https://x/' + Math.random(), source: 'GitHub', followLabel: 'GitHub 热门',
  points: 0, publishedAt: NOW, ...over,
})

test('pickDigestItems：窗口过滤 + 热度排序 + 去重 + 上限', () => {
  const items = [
    item({ title: 'old', url: 'https://old', points: 999, publishedAt: NOW - 48 * 3600000 }),
    item({ title: 'a', url: 'https://a', points: 10 }),
    item({ title: 'b', url: 'https://b', points: 50 }),
    item({ title: 'a-dup', url: 'https://a', points: 5 }),
    item({ title: 'c', url: 'https://c', points: 30 }),
  ]
  const out = pickDigestItems(items, { sinceMs: NOW - 24 * 3600000, maxItems: 2 })
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((x) => x.title), ['b', 'c'], '按热度倒序，且窗口外/重复的不进')
})

test('pickDigestItems：已推送过的 URL 不再重复推（GitHub 仓库不能用时间窗口筛）', () => {
  const items = [item({ title: 'a', url: 'https://a' }), item({ title: 'b', url: 'https://b' })]
  const out = pickDigestItems(items, { seenUrls: ['https://a'], maxItems: 5 })
  assert.deepEqual(out.map((x) => x.title), ['b'])
})

test('pickDigestItems：空输入 / 非法 maxItems 不炸', () => {
  assert.deepEqual(pickDigestItems(null), [])
  assert.equal(pickDigestItems([item()], { maxItems: 0 }).length, 1)
})

test('digestPrompt：没有条目就不注入（空串）', () => {
  assert.equal(digestPrompt({ items: [] }), '')
  assert.equal(digestPrompt(null), '')
})

test('digestPrompt：列出条目并要求「一两句话带过」，不许罗列', () => {
  const text = digestPrompt({ generatedAt: NOW, items: [item({ title: '某个仓库', url: 'https://r', points: 42 })] }, { maxItems: 5 })
  assert.ok(text.includes('某个仓库'))
  assert.ok(text.includes('42'), '热度要带上')
  assert.ok(text.includes('一两句话'), '必须约束输出长度，否则模型会念标题')
  assert.ok(text.includes('不要整段罗列'))
})

test('写读 + 消费：同一个 generatedAt 只能被消费一次语义', async () => {
  const root = path.join(tmp, 'v1')
  const d = await writeDigest(root, { ok: true, generatedAt: NOW, consumedAt: 0, items: [item({ url: 'https://k' })] })
  const back = await readDigest(root)
  assert.equal(back.generatedAt, NOW)
  assert.equal(back.items.length, 1)

  const consumed = await consumeDigest(root, NOW)
  assert.equal(consumed.consumedAt, NOW)
  // 消费后再次读取应保持
  assert.equal((await readDigest(root)).consumedAt, NOW)
  // 过期快照（generatedAt 不匹配）不允许被误标
  assert.equal(await consumeDigest(root, NOW - 1), null)
})
