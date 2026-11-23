// 「反馈表非空 → 召回全空」回归（0.45.0 起复现，0.53.0 仍存在）。
//
// 根因：lib/vault.js 反馈反哺排序里写了 `queryTerms(f.query).some(...)`，而 queryTerms()
// 返回 Set；同一表达式里 `wanted.includes(...)` 的 wanted 也是 Set。二者在 feedback 表
// 一旦有记录时就抛 TypeError，被 search() 上层的 catch 吞掉，表现为「召回永远为空」。
//
// 本用例覆盖的正是既有测试的空白：vault.test.mjs 只在 addFeedback 之前调 search。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureVault, writeCard, search, addFeedback } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-feedback-search-'))
after(async () => {
  closeAllDb()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('feedback 表非空时 search 仍能返回命中（Set.some / Set.includes 回归）', async () => {
  const root = path.join(tmpRoot, 'vault')
  await ensureVault(root)

  const uniq = 'fbregress-' + Date.now().toString(36)
  const written = await writeCard(root, {
    kind: 'knowledge',
    title: `召回反馈回归-${uniq}`,
    tags: ['regression', 'search'],
    body: `# 召回反馈回归\n\n唯一标记：${uniq}\n该卡用于验证：feedback 表非空时 search() 不得抛错。\n` +
      `背景填充：${'召回链路回归用例'.repeat(40)}`,
    source: 'test:search-feedback',
    status: 'approved',
  })
  assert.equal(written.ok, true, '写卡应成功')

  const before = await search(root, uniq, { limit: 5 })
  assert.ok(before.length >= 1, '写入后（无反馈）应能召回')
  assert.equal(before[0].path, written.path)

  // 写入两条与查询有词重叠的反馈 —— 命中 overlap 分支，即触发旧代码的 TypeError。
  await addFeedback(root, { query: `${uniq} 召回 回归`, path: written.path, useful: true })
  await addFeedback(root, { query: '召回 回归', path: written.path, useful: false })

  const afterHits = await search(root, uniq, { limit: 5 })
  assert.ok(afterHits.length >= 1, 'feedback 表非空时仍必须能召回（旧代码在此抛 TypeError）')
  assert.equal(afterHits[0].path, written.path, '命中的卡不应被反馈打乱')
})
