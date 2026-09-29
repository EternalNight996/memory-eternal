// P1-2 回归：精灵 key 必须稳定可复用、LRU 必须真的淘汰。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zoomBucket, radiusBucket, nodeSpriteKey, labelSpriteKey, SpriteCache, staticLayerKey } from '../src/client/graph-sprites.js'

test('zoomBucket：同档位内缩放复用同一精灵，跨档位才换', () => {
  assert.equal(zoomBucket(1), zoomBucket(1.05), '1 与 1.05 应同一档（√2 分级）')
  assert.equal(zoomBucket(1), 0)
  assert.equal(zoomBucket(2), 2, '2× = 两个 √2 档')
  assert.notEqual(zoomBucket(1), zoomBucket(2), '1 与 2 应跨档')
  assert.equal(zoomBucket(0), 0, '非法缩放按 1 处理')
  assert.equal(zoomBucket(NaN), 0)
})

test('nodeSpriteKey / labelSpriteKey：稳定且区分关键维度', () => {
  const a = nodeSpriteKey({ kind: 'knowledge', radius: 9.2, zoom: 1.0, dark: false })
  const b = nodeSpriteKey({ kind: 'knowledge', radius: 9.4, zoom: 1.05, dark: false })
  assert.equal(a, b, '半径与缩放落在同一桶内应复用')
  assert.notEqual(a, nodeSpriteKey({ kind: 'tool', radius: 9.2, zoom: 1.0 }))
  assert.notEqual(a, nodeSpriteKey({ kind: 'knowledge', radius: 9.2, zoom: 1.0, dark: true }))
  assert.equal(labelSpriteKey({ text: '缓存', fontPx: 12 }), labelSpriteKey({ text: '缓存', fontPx: 12 }))
  assert.notEqual(labelSpriteKey({ text: '缓存' }), labelSpriteKey({ text: '图谱' }))
  assert.equal(radiusBucket(8.6), 9)
})

test('SpriteCache：命中复用、尺寸变化重建、超限淘汰最旧', () => {
  const made = []
  const cache = new SpriteCache({ max: 2, createCanvas: (w, h) => { made.push(w + 'x' + h); return { width: w, height: h, getContext: () => ({}) } } })
  let renders = 0
  const render = () => { renders++ }
  const e1 = cache.get('a', 10, 10, render)
  assert.equal(renders, 1)
  assert.equal(cache.get('a', 10, 10, render), e1, '应命中同一对象')
  assert.equal(renders, 1, '命中不应重绘')
  cache.get('a', 12, 12, render)
  assert.equal(renders, 2, '尺寸变了要重建')
  cache.get('b', 10, 10, render)
  cache.get('c', 10, 10, render)   // 触发淘汰（max=2）
  assert.equal(cache.size, 2)
  assert.equal(cache.hits, 1)
  assert.ok(cache.misses >= 4)
  cache.clear()
  assert.equal(cache.size, 0)
})

test('staticLayerKey：只有变换/尺寸/过滤/主题/数据版本变化才失效', () => {
  const base = { panX: 0, panY: 0, zoom: 1, w: 800, h: 600, dpr: 2, tick: 10, filter: 'all', dark: false, dataVersion: 1 }
  assert.equal(staticLayerKey(base), staticLayerKey({ ...base }), '同输入必须同 key')
  assert.notEqual(staticLayerKey(base), staticLayerKey({ ...base, panX: 5 }))
  assert.notEqual(staticLayerKey(base), staticLayerKey({ ...base, zoom: 1.5 }))
  assert.notEqual(staticLayerKey(base), staticLayerKey({ ...base, tick: 11 }))
  assert.notEqual(staticLayerKey(base), staticLayerKey({ ...base, filter: 'knowledge' }))
  assert.notEqual(staticLayerKey(base), staticLayerKey({ ...base, dark: true }))
})
