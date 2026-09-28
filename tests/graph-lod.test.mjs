// #7 回归：图谱 LOD —— 视口剔除的数学必须正确（漏算会把可见节点剔除掉）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visibleWorldRect, inRect, labelBudget, pickLabelIds } from '../src/client/graph-lod.js'

test('visibleWorldRect：默认缩放下的可见世界矩形', () => {
  const r = visibleWorldRect({ panX: 0, panY: 0, zoom: 1, w: 800, h: 600, margin: 0 })
  assert.deepEqual(r, { x0: 0, y0: 0, x1: 800, y1: 600 })
})

test('visibleWorldRect：平移与缩放（放大后可见范围变小）', () => {
  const r = visibleWorldRect({ panX: -200, panY: -100, zoom: 2, w: 800, h: 600, margin: 0 })
  assert.equal(r.x0, 100)   // (0 - (-200)) / 2
  assert.equal(r.y0, 50)
  assert.equal(r.x1, 500)   // (800 + 200) / 2
  assert.equal(r.y1, 350)
  assert.ok((r.x1 - r.x0) < 800, '放大后世界可见宽度必须变小')
})

test('inRect：相交/不相交与半径余量', () => {
  const rect = { x0: 0, y0: 0, x1: 100, y1: 100 }
  assert.equal(inRect(50, 50, 5, rect), true)
  assert.equal(inRect(-4, 50, 5, rect), true, '半径压线仍算可见')
  assert.equal(inRect(-6, 50, 5, rect), false)
  assert.equal(inRect(200, 200, 5, rect), false)
  assert.equal(inRect(200, 200, 5, null), true, '无 rect 视为全部可见')
})

test('labelBudget：随节点数收敛', () => {
  assert.equal(labelBudget(50), Infinity)
  assert.equal(labelBudget(120), Infinity)
  assert.equal(labelBudget(300), 160)
  assert.equal(labelBudget(589), 90)
  assert.equal(labelBudget(2000), 60)
})

test('pickLabelIds：焦点必留、数量受预算限制、按度数优先', () => {
  const nodes = Array.from({ length: 500 }, (_, i) => ({ id: 'n' + i }))
  const degree = {}
  for (let i = 0; i < 500; i++) degree['n' + i] = i   // n499 度数最高
  const ids = pickLabelIds(nodes, { limit: 10, focusId: 'n0', hoverId: 'n1', degree })
  assert.equal(ids.size, 10)
  assert.ok(ids.has('n0') && ids.has('n1'), '焦点与悬停必须保留')
  assert.ok(ids.has('n499') && ids.has('n498'), '剩余名额给度数最高的')
  assert.ok(!ids.has('n2'), '低度数节点不应占名额')
  const hits = pickLabelIds(nodes, { limit: 5, searchHits: ['n7', 'n8'], degree })
  assert.ok(hits.has('n7') && hits.has('n8'), '搜索命中优先')
  assert.equal(hits.size, 5)
  const all = pickLabelIds([{ id: 'a' }, { id: 'b' }], { limit: Infinity })
  assert.equal(all.size, 2, 'Infinity 预算 = 全画')
})
