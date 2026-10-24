// 知识星图「打开空白 / 白屏」回归守卫（v0.15.x）。
//
// 真实事故：GraphCanvas 在挂载 effect 里同步跑 200 次 O(n²) tick。1084 张卡时实测
// 主线程一次性阻塞 1.3–2.8s（4× CPU 降速下 5.3s），期间画布空白、点击无响应 ——
// 用户看到的就是「打开知识星图一片空白」。而渲染循环里的空 catch 还会把绘制异常
// 静默吞掉，effect 里的同步重绘一旦抛异常又会卸载整棵树（整页白屏、无错误边界）。
//
// 本文件锁三件事：
//   1) 预热策略：总次数随节点数收缩、有最小/最大边界（纯函数，直接单测）；
//   2) 预热是分帧跑的：源码里不再有「一次性 for 200 次 tick」的同步循环；
//   3) 白屏兜底还在：错误边界 + 绘制异常告警 + 未知 kind 兜底。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WARM_FRAME_BUDGET_MS, WARM_TICKS_MAX, WARM_TICKS_MIN, warmTicksFor } from '../src/client/graph-warmup.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')

test('预热次数：随节点数收缩，且有上下界（不再固定 200 次）', () => {
  assert.equal(warmTicksFor(0), 0, '空图不需要预热（没有节点可布局）')
  assert.equal(warmTicksFor(1), WARM_TICKS_MAX, '小图仍做满 200 次，保持原有的收敛观感')
  assert.equal(warmTicksFor(300), WARM_TICKS_MAX)
  assert.ok(warmTicksFor(301) <= WARM_TICKS_MAX, '越过阈值后必须开始收缩')
  assert.ok(warmTicksFor(1084) < warmTicksFor(301), '节点越多，单次 tick 越贵 → 次数必须更少')
  assert.ok(warmTicksFor(1084) <= 80, '1084 节点（用户真实库规模）预热必须降到 80 次以内，实测 1084 节点一次 tick ≈5.6ms')
  assert.ok(warmTicksFor(5000) >= WARM_TICKS_MIN, '再大的图也不能退化成 0 次')
  // 单调不增：节点数只增不减时，预热次数不能反而变多
  let prev = Infinity
  for (const n of [1, 50, 200, 300, 301, 500, 700, 701, 1000, 1084, 1200, 1201, 3000]) {
    const v = warmTicksFor(n)
    assert.ok(v <= prev, 'warmTicksFor 必须单调不增：' + n + ' 节点拿到 ' + v)
    prev = v
  }
})

test('预热是分帧跑的：源码里不允许出现「一次性同步 tick 200 次」', () => {
  assert.doesNotMatch(src, /for \(let s = 0; s < 200; s\+\+\) tick\(\)/, '旧的一次性 200 次同步 tick 必须删除')
  assert.match(src, /requestAnimationFrame\(warmStep\)/, '预热必须通过 rAF 分帧推进（帧间让出主线程）')
  assert.match(src, /performance\.now\(\) - t0 < WARM_FRAME_BUDGET_MS/, '每帧必须受时间预算约束，否则单帧还是会长时间独占主线程')
  assert.ok(WARM_FRAME_BUDGET_MS > 0 && WARM_FRAME_BUDGET_MS <= 16, '单帧预算不得超过一帧时长（16ms），实测 ' + WARM_FRAME_BUDGET_MS)
  assert.match(src, /try \{ render\(\) \} catch \(e\) \{ warnGraphDrawError\(e, 'first-frame'\) \}/, '首帧必须同步画（不依赖 rAF：窗口未聚焦/被遮挡时 rAF 不会来）')
  assert.match(src, /graphWarming/, '预热期间必须有可见提示（「正在布局 N 个节点…」），不能是无声空白')
})

test('白屏兜底：错误边界 + 绘制异常不再被静默吞掉 + 未知 kind 兜底', () => {
  assert.match(src, /class PanelErrorBoundary extends React\.Component/, '面板最外层要有错误边界（否则任何渲染期异常 = 整页白屏）')
  assert.match(src, /static getDerivedStateFromError/, '错误边界要真的接住异常')
  assert.match(src, /<PanelErrorBoundary>/, 'MemoryLibrary 导出必须真的被边界包住')
  assert.match(src, /function warnGraphDrawError/, '绘制异常统一走告警函数（只告警一次，绝不往上抛）')
  assert.doesNotMatch(src, /catch \(er\) \{ \/\* 绘制\/物理异常不拖垮窗口 \*\/ \}/, '旧的空 catch 必须换成有线索的兜底')
  assert.match(src, /KG\.colors\[kind\] \|\| KG\.colors\.other/, '未知 kind 必须有配色兜底（undefined 会让 gradientFor 的 color.slice 抛 TypeError）')
  assert.match(src, /KG\.shapes\[kind\] \|\| 'circle'/, '未知 kind 必须有形状兜底')
  assert.match(src, /catch \(e\) \{ warnGraphDrawError\(e, 'filter\/timeDim'\) \}/, '时间维/图例重绘（effect 内同步调用）必须兜住异常 —— 它是「整页白屏」的最短路径')
})
