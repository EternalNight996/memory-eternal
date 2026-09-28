// 图谱性能回归基线（issue：593 卡时打开图谱卡顿）。
// 用「同标签全连接」的极端构造：如果标签边退化成全连接，300 张卡会产生 C(300,2)=44,850 条边，
// 前端每帧都要遍历 —— 这个断言就是那条红线。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureVault, writeCard, graph } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'

const N = 300
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'me-perf-'))
after(async () => { closeAllDb(); try { await fs.rm(tmp, { recursive: true, force: true }) } catch {} })

// 每张卡正文必须真正互不相同：写卡带词法去重，正文太像会被合并掉（实测 300 张只剩 14 张）。
// 用确定性 PRNG（种子=序号）生成互不重叠的正文，标签仍然共享 —— 稠密标签场景不变。
const bodyOf = (i) => {
  let seed = (i + 1) * 2654435761 % 2147483647
  const rnd = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647 }
  const words = Array.from({ length: 60 }, () => 'w' + Math.floor(rnd() * 1e9).toString(36))
  return '# 性能基线卡 ' + i + '\n\n' + words.join(' ')
}

test('300 张卡（共享标签）图谱：边数必须远低于全连接，payload 可控', async () => {
  await ensureVault(tmp)
  for (let i = 0; i < N; i++) {
    await writeCard(tmp, {
      kind: 'knowledge',
      title: '性能基线卡 ' + i,
      tags: ['perf', 'group' + (i % 12)],
      body: bodyOf(i),
      status: 'approved',
      source: 'perf-test',
    })
  }
  const t0 = Date.now()
  const g = await graph(tmp)
  const cold = Date.now() - t0
  const naive = (N * (N - 1)) / 2
  assert.equal(g.nodes.length, N, '应写入 ' + N + ' 张卡（若不足说明被去重合并了）')
  assert.ok(g.edges.length < 3000, '边数 ' + g.edges.length + ' 必须远低于全连接 ' + naive)
  assert.ok(g.edges.length < naive / 10, '至少要比全连接少一个数量级')
  const payload = JSON.stringify(g).length
  assert.ok(payload < 1.5 * 1024 * 1024, 'payload ' + Math.round(payload / 1024) + 'KB 应可控')
  const t1 = Date.now()
  await graph(tmp)
  const warm = Date.now() - t1
  assert.ok(warm < Math.max(50, cold), 'warm 必须走缓存，实测 ' + warm + 'ms vs cold ' + cold + 'ms')
})
