// P1-1 回归：MinHash 估计准、LSH 能召回近重复、且不把无关卡凑成候选。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mix32, minhashSignature, jaccardEstimate, lshBandKeys, lshCandidates } from '../lib/minhash.js'
import { ensureVault, writeCard, graph } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'

test('mix32：确定、32 位、不同 seed 不同结果', () => {
  assert.equal(mix32(12345, 0), mix32(12345, 0))
  assert.notEqual(mix32(12345, 0), mix32(12345, 1))
  for (const x of [0, 1, 1e9, 0xffffffff]) assert.ok(mix32(x, 7) >= 0 && mix32(x, 7) <= 0xffffffff)
})

test('minhashSignature：同集合签名相同，估计值接近真实 Jaccard', () => {
  const a = new Set(Array.from({ length: 300 }, (_, i) => i))
  const b = new Set(Array.from({ length: 300 }, (_, i) => i + 150)) // 交集 150 → J = 150/450 = 0.333
  const c = new Set(Array.from({ length: 300 }, (_, i) => i + 5000)) // 无交集
  const sa = minhashSignature(a, 256)
  const sb = minhashSignature(b, 256)
  const sc = minhashSignature(c, 256)
  assert.deepEqual([...minhashSignature(a, 256)], [...sa], '同集合签名必须稳定')
  assert.equal(jaccardEstimate(sa, sc), 0, '无交集估计应为 0')
  const est = jaccardEstimate(sa, sb)
  assert.ok(Math.abs(est - 0.333) < 0.08, '估计值应接近 0.333，实测 ' + est.toFixed(3))
})

test('lshBandKeys / lshCandidates：近重复进候选、无关卡不进', () => {
  assert.equal(lshBandKeys(new Uint32Array(8).fill(1), 4, 2).length, 4)
  const base = Array.from({ length: 400 }, (_, i) => i)
  const near = [...base.slice(0, 360), 9001, 9002]     // 与 base 极像
  const far = Array.from({ length: 400 }, (_, i) => i + 100000)
  const sigs = new Map([
    ['base', minhashSignature(base, 48)],
    ['near', minhashSignature(near, 48)],
    ['far', minhashSignature(far, 48)],
  ])
  const cands = lshCandidates(sigs, { bands: 24, rows: 2, maxPerCard: 10 })
  assert.ok((cands.get('base') || []).includes('near'), '近重复必须成为候选')
  assert.ok(!(cands.get('base') || []).includes('far'), '无关卡不该成为候选')
  assert.ok((cands.get('near') || []).includes('base'), '候选应双向')
})

test('端到端：哈希+LSH 管线仍能发现近重复卡（similar 边）', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'me-minhash-'))
  try {
    await ensureVault(tmp)
    // 造一对「像但没像到会被写卡去重合并」的卡：共享一半 bigram（J≈0.5）——
    // 高于图谱相似阈值 0.42，低于写卡去重阈值 0.62（否则会被合并成一张，测不到 similar 边）。
    const shared = Array.from({ length: 40 }, (_, i) => 'k' + i).join('')
    const aOnly = Array.from({ length: 20 }, (_, i) => 'a' + i).join('')
    const bOnly = Array.from({ length: 20 }, (_, i) => 'b' + i).join('')
    // dedup: false —— 这两张本来就像（相似度 0.556），默认写卡去重会把它们合并成一张，就测不到 similar 边了
    const ra = await writeCard(tmp, { kind: 'knowledge', title: 'A', tags: ['a'], body: shared + aOnly, status: 'approved', source: 'test', dedup: false })
    const rb = await writeCard(tmp, { kind: 'knowledge', title: 'B', tags: ['b'], body: shared + bOnly, status: 'approved', source: 'test', dedup: false })
    const pa = String(ra.path || ra.rel || '')
    const pb = String(rb.path || rb.rel || '')
    for (let i = 0; i < 20; i++) {
      await writeCard(tmp, { kind: 'knowledge', title: '无关卡 ' + i, tags: ['x'], body: 'q' + i + 'z'.repeat(40) + 'w' + (i * 7), status: 'approved', source: 'test', dedup: false })
    }
    const g = await graph(tmp)
    assert.ok(g.nodes.length >= 20, '应写入约 22 张，实测 ' + g.nodes.length)
    // 关键断言：A/B 这对近重复卡必须被哈希+LSH 管线抓出来（用写入返回的真实路径比对，避免 slug 差异）
    assert.ok(pa && pb, 'writeCard 应返回路径')
    const pair = g.edges.filter((e) => e.type === 'similar').filter((e) => {
      const s = String(e.source), t = String(e.target)
      return (s === pa && t === pb) || (s === pb && t === pa)
    })
    assert.equal(pair.length, 1, 'A/B 之间应恰好一条 similar 边，实测 ' + pair.length + '（全部 similar: ' + g.edges.filter((e) => e.type === 'similar').length + '）')
  } finally { closeAllDb(); await fs.rm(tmp, { recursive: true, force: true }) }
})
