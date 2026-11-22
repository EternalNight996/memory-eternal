// 近似重复（nearDuplicate）与「同一技能多份」（sameSource）的检测 + 按类别全量处置。
//
// 守六件事（每条都对应本轮真实翻车点）：
//   ① 同标题 + 正文高度相似（Jaccard ≥ 0.9）才算近重复，长度差 > 40% 直接跳过
//   ② 标题不同不两两比对（全局 LSH 在几万张上代价太高，要抓的是「同名不同时间」）
//   ③ 保留顺序：10-* 正式位置 → 主库 → created_at 最早
//   ④ sameSource 必须读 kind —— SELECT 里漏了 kind 时这类恒为 0（静默失效）
//   ⑤ reclaimable / truncated 口径要含近重复，否则界面出现「可回收 17 / 近重复 9565」
//   ⑥ 按类别处置走 filter 全量取，不受扫描候选窗口（默认 200/500）限制
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { scanJunk, pickByFilter } from '../lib/junk.js'
import { getDb, closeDb } from '../lib/db.js'
import { contentHash } from '../lib/card-hash.js'

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'me-neardup-'))
}

function cleanup(root) {
  try { closeDb(root) } catch { /* 忽略 */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

/** 最近时间：避免测近重复时被 neverRecalled / stale 规则抢走候选。 */
function recent() {
  return new Date(Date.now() - 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)
}

// 正文要够长、字符组合够多样 —— 太短时「多一行标题」会把 Jaccard 拉到 0.9 以下
// （实测 41 个 bigram 时加 5 个新 bigram，估计值会掉到 0.81，那是样本问题不是实现问题）。
const BODY = Array.from({ length: 40 }, (_, i) => `第${i}段：这段文字用于测试近似重复的判定，编号${i}让字符组合更有多样性。`).join('\n')

function seedCards(root, rows) {
  const db = getDb(root)
  const ins = db.prepare(`
    INSERT INTO cards (id, path, kind, title, tags, body, summary, status, source, created_at, updated_at, content_hash, recall_count)
    VALUES (?, ?, ?, ?, '[]', ?, '', 'approved', ?, ?, ?, ?, ?)
  `)
  rows.forEach((r, i) => ins.run(
    i + 1, r.path, r.kind || 'knowledge', r.title, r.body,
    r.source || '', r.created || recent(), r.created || recent(),
    contentHash(r.title, r.body), r.recall === undefined ? 1 : r.recall,
  ))
  return db
}

function seedQuarantine(root, rows) {
  const db = getDb(root)
  const ins = db.prepare(`
    INSERT INTO quarantine (id, path, kind, title, tags, body, summary, status, source, created_at, updated_at, content_hash)
    VALUES (?, ?, ?, ?, '[]', ?, '', 'pending', ?, ?, ?, ?)
  `)
  rows.forEach((r, i) => ins.run(
    100 + i, r.path, r.kind || 'knowledge', r.title, r.body,
    r.source || '', r.created || recent(), r.created || recent(), contentHash(r.title, r.body),
  ))
  return db
}

test('同标题 + 正文高度相似 → nearDuplicate（length 差很小）', () => {
  const root = tmpVault()
  seedCards(root, [
    { path: '20-Notes/a.md', title: '同一段对话', body: BODY },
    { path: '20-Notes/b.md', title: '同一段对话', body: '# 重复标题行\n\n' + BODY },
  ])
  const r = scanJunk(root)
  assert.equal(r.summary.nearDuplicate, 1, '应判 1 条近重复，实际 ' + r.summary.nearDuplicate)
  const nd = r.candidates.filter((c) => c.reason === 'nearDuplicate')
  assert.equal(nd.length, 1)
  assert.equal(nd[0].suggestion, 'delete')
  cleanup(root)
})

test('长度差 > 40% 直接跳过（不两两精算）', () => {
  const root = tmpVault()
  seedCards(root, [
    { path: 'a.md', title: '同标题', body: BODY },
    { path: 'b.md', title: '同标题', body: BODY + BODY + BODY },
  ])
  const r = scanJunk(root)
  assert.equal(r.summary.nearDuplicate, 0, '长度差过大不该判近重复')
  cleanup(root)
})

test('标题不同不比对（要抓的是同名不同时间）', () => {
  const root = tmpVault()
  seedCards(root, [
    { path: 'a.md', title: '标题A', body: BODY },
    { path: 'b.md', title: '标题B', body: BODY },
  ])
  const r = scanJunk(root)
  assert.equal(r.summary.nearDuplicate, 0)
  cleanup(root)
})

test('保留顺序：10-* 正式位置优先当正本', () => {
  const root = tmpVault()
  seedCards(root, [
    { path: '20-Notes/a.md', title: 'T', body: BODY, created: '2026-11-01 00:00:00' },
    { path: '10-Zettel/b.md', title: 'T', body: BODY + '\n# 多一行标题', created: '2026-11-02 00:00:00' },
  ])
  const r = scanJunk(root)
  const nd = r.candidates.filter((c) => c.reason === 'nearDuplicate')
  assert.equal(nd.length, 1)
  assert.equal(nd[0].path, '20-Notes/a.md', '被清理的应是 20-* 那张')
  assert.equal(nd[0].keep, '10-Zettel/b.md', '正本应是 10-* 那张')
  cleanup(root)
})

test('主库优先当正本（隔离区的副本被清理）', () => {
  const root = tmpVault()
  seedCards(root, [{ path: '20-Notes/main.md', title: 'T', body: BODY }])
  seedQuarantine(root, [{ path: '20-Notes/copy.md', title: 'T', body: BODY + '\n# 多一行' }])
  const r = scanJunk(root)
  const nd = r.candidates.filter((c) => c.reason === 'nearDuplicate')
  assert.equal(nd.length, 1, '隔离区副本应被判近重复')
  assert.equal(nd[0].path, '20-Notes/copy.md')
  assert.equal(nd[0].store, 'quarantine')
  assert.equal(nd[0].keep, '20-Notes/main.md')
  cleanup(root)
})

test('sameSource：kind=skill + source 相同 → 判同一技能多份（SELECT 漏 kind 时恒为 0）', () => {
  const root = tmpVault()
  // cards(source) 上有 UNIQUE 索引（kind='skill' AND source LIKE 'skill:%'），
  // 所以真实场景里同 source 的副本只会是「主库 + 隔离区」这种跨表形态。
  seedCards(root, [
    { path: '10-Skills/foo.md', title: 'foo', body: BODY, kind: 'skill', source: 'skill:foo' },
  ])
  seedQuarantine(root, [
    { path: '20-Notes/foo-copy.md', title: 'foo', body: BODY + '\n# 版本差异', kind: 'skill', source: 'skill:foo' },
  ])
  const r = scanJunk(root)
  assert.equal(r.summary.sameSource, 1, '同一 source 应判 sameSource，实际 ' + r.summary.sameSource)
  const ss = r.candidates.filter((c) => c.reason === 'sameSource')
  assert.equal(ss.length, 1)
  assert.equal(ss[0].path, '20-Notes/foo-copy.md', '保留 10-Skills 那张，清理隔离区副本')
  cleanup(root)
})

test('reclaimable / truncated 口径包含近重复（否则界面数字自相矛盾）', () => {
  const root = tmpVault()
  seedCards(root, [
    { path: 'a.md', title: 'T', body: BODY },
    { path: 'b.md', title: 'T', body: BODY + '\n# 多一行 A' },
    { path: 'c.md', title: 'T', body: BODY + '\n# 多一行 B' },
  ])
  const r = scanJunk(root, { limit: 1 })
  assert.ok(r.summary.reclaimable >= 2, 'reclaimable 应含近重复，实际 ' + r.summary.reclaimable)
  assert.equal(r.truncated, true, '候选被截断时必须置 truncated')
  cleanup(root)
})

test('pickByFilter 按类别全量取（不受扫描候选项截断影响）', () => {
  const root = tmpVault()
  seedCards(root, [
    { path: 'a.md', title: 'T', body: BODY },
    { path: 'b.md', title: 'T', body: BODY + '\n# 多一行 A' },
    { path: 'c.md', title: 'T', body: BODY + '\n# 多一行 B' },
  ])
  const near = pickByFilter(root, { reason: 'nearDuplicate' })
  assert.equal(near.length, 2, '三条同标题应取到 2 条近重复，实际 ' + near.length)
  const multi = pickByFilter(root, { reasons: ['nearDuplicate', 'duplicate'] })
  assert.equal(multi.length, 2, 'reasons 数组形式也要能用')
  cleanup(root)
})

test('UI 接线：分类处置走 filter、近重复不并入一键清理、确认弹窗用统一文案表', () => {
  const src = fs.readFileSync('src/client/index.tsx', 'utf8')

  // 分类批量按钮传 filter（全量），而不是传扫描窗口里的 paths
  assert.match(src, /filter: \{ reason, limit: 20000 \}/, 'askJunkAction 要传 filter 全量取')

  // 真执行两种选法都要支持
  assert.match(src, /if \(st\.filter\) payload\.filter = st\.filter/, 'runJunkAction 要透传 filter')

  // 「立即清理」不并入近重复：一次软删上万张影响面太大（注释里可以提，但代码里不能出现该分类）
  const idx = src.indexOf('const cleanNow = async')
  assert.ok(idx > 0, '找不到 cleanNow')
  const block = src.slice(idx, idx + 2200)
  assert.doesNotMatch(block, /['"]nearDuplicate['"]/, '「立即清理」不该并入 nearDuplicate')
  assert.match(block, /action: 'delete', filter: \{/, '可回收类仍走 delete + filter')

  // 弹窗分类文案统一走 junkReasonLabel（新增分类漏登记就会显示原始 key）
  assert.match(src, /const junkReasonLabel = \(reason\)/, '要有统一的分类文案映射')
  assert.match(src, /sameSource: 'junkSameSource'/, '映射要含同源')
  assert.match(src, /nearDuplicate: 'junkNearDuplicate'/, '映射要含近重复')
  assert.match(src, /junkReasonLabel\(x\.trim\(\)\)/, '弹窗要用映射，而不是再写一遍 if 链')
})
