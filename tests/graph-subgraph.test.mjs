// #8 回归：大图默认只画热区 —— 服务端按度数裁剪子图的数学必须正确。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { topDegreeSubgraph } from '../lib/vault.js'

const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))
const edges = [
  { source: 'a', target: 'b' },
  { source: 'a', target: 'c' },
  { source: 'a', target: 'd' },
  { source: 'b', target: 'c' },
]

test('topDegreeSubgraph：取度数最高的 N 张，边只保留两端都在子图里的', () => {
  const out = topDegreeSubgraph(nodes, edges, 2)
  assert.equal(out.total, 5)
  assert.equal(out.shown, 2)
  assert.deepEqual(out.nodes.map((n) => n.id), ['a', 'b'], 'a(3) b(2) 度数最高')
  assert.equal(out.edges.length, 1, '只剩 a-b')
  assert.deepEqual(out.edges[0], { source: 'a', target: 'b' })
})

test('topDegreeSubgraph：limit=0 / 超过总量时原样返回', () => {
  const all = topDegreeSubgraph(nodes, edges, 0)
  assert.equal(all.shown, 5)
  assert.equal(all.edges.length, 4)
  const big = topDegreeSubgraph(nodes, edges, 99)
  assert.equal(big.shown, 5)
  assert.equal(big.total, 5)
})

test('topDegreeSubgraph：空输入不炸', () => {
  const out = topDegreeSubgraph([], [], 10)
  assert.equal(out.total, 0)
  assert.equal(out.shown, 0)
  assert.equal(out.edges.length, 0)
})
