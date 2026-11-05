// 知识图谱斥力内核回归：Barnes–Hut 四叉树 vs 精确 O(n²)
//
// 锁三件事：
//   1) 正确性：BH 近似与精确全对斥力的方向/量级一致（theta 越小越精确，theta=0 应逐点吻合）；
//   2) 量级：2049 节点（真实库规模）单 tick 的耗时基线与访问次数，必须远低于 O(n²)；
//   3) 退化与边界：空图/单点/重合点/NaN、拖拽节点被跳过、静置 quietTicks、速度上限。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RepulsionEngine, stepSimulation, bruteForceRepulsion, forceParamsFor, QUIET_RMS } from '../src/client/graph-force.js'

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), 1 | t)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomNodes(count, seed = 7) {
  const rnd = mulberry32(seed)
  return Array.from({ length: count }, (_, i) => ({
    id: 'n' + i,
    type: 'knowledge',
    x: (rnd() - 0.5) * 1200,
    y: (rnd() - 0.5) * 900,
    vx: 0,
    vy: 0,
  }))
}

function cosine(a, b, i) {
  const dot = a.fx[i] * b.fx[i] + a.fy[i] * b.fy[i]
  const na = Math.hypot(a.fx[i], a.fy[i])
  const nb = Math.hypot(b.fx[i], b.fy[i])
  return na && nb ? dot / (na * nb) : 1
}

test('力常数与改造前 tick() 逐项一致（不同规模）', () => {
  assert.deepEqual(forceParamsFor(30), { repulsion: 800, attraction: 0.005, centerGravity: 0.01, velCap: 24, theta: 0.8 })
  // 120：>100 走 2000 斥力 / 0.002 边吸引 / 0.005 重力，但 velCap 仍是 24（>200 才降到 12）
  assert.deepEqual(forceParamsFor(120), { repulsion: 2000, attraction: 0.002, centerGravity: 0.005, velCap: 24, theta: 0.8 })
  assert.deepEqual(forceParamsFor(600), { repulsion: 2000, attraction: 0.002, centerGravity: 0.005, velCap: 12, theta: 0.8 })
  assert.deepEqual(forceParamsFor(2049), { repulsion: 3000, attraction: 0.002, centerGravity: 0.012, velCap: 6, theta: 0.8 })
})

test('theta=0（不近似）时 BH 与精确全对斥力逐点吻合', () => {
  const nodes = randomNodes(200, 11)
  const repulsion = 3000
  const exact = bruteForceRepulsion(nodes, repulsion)
  const engine = new RepulsionEngine(nodes.length)
  const approx = engine.compute(nodes, { repulsion, theta: 0 })
  let worst = 0
  for (let i = 0; i < nodes.length; i += 1) {
    const ex = exact.fx[i], ey = exact.fy[i]
    const ax = approx.fx[i], ay = approx.fy[i]
    const scale = Math.hypot(ex, ey) || 1
    worst = Math.max(worst, Math.hypot(ax - ex, ay - ey) / scale)
  }
  assert.ok(worst < 1e-6, 'theta=0 时应逐点精确，实测最大相对误差 ' + worst)
})

test('theta=0.8 的近似保持方向与量级（400 节点统计）', () => {
  const nodes = randomNodes(400, 41)
  const repulsion = 3000
  const exact = bruteForceRepulsion(nodes, repulsion)
  const engine = new RepulsionEngine(nodes.length)
  const approx = engine.compute(nodes, { repulsion, theta: 0.8 })
  const rel = []
  const cos = []
  for (let i = 0; i < nodes.length; i += 1) {
    const ex = Math.hypot(exact.fx[i], exact.fy[i])
    const ax = Math.hypot(approx.fx[i], approx.fy[i])
    rel.push(Math.abs(ax - ex) / (ex || 1))
    // 合力极小的节点方向本身是噪声，只用其它节点评估方向一致性
    if (ex > 0.02) cos.push((approx.fx[i] * exact.fx[i] + approx.fy[i] * exact.fy[i]) / (ax * ex))
  }
  rel.sort((a, b) => a - b)
  cos.sort((a, b) => a - b)
  const p50 = rel[Math.floor(rel.length * 0.5)]
  const p95 = rel[Math.floor(rel.length * 0.95)]
  const cos05 = cos[Math.floor(cos.length * 0.05)]
  console.log('    · theta=0.8：力大小误差 p50 ' + (p50 * 100).toFixed(2) + '% / p95 ' + (p95 * 100).toFixed(2) + '% · 方向余弦 p05 ' + cos05.toFixed(4))
  assert.ok(p50 < 0.05, '力大小误差中位数应 < 5%，实测 ' + (p50 * 100).toFixed(2) + '%')
  assert.ok(p95 < 0.15, '力大小误差 p95 应 < 15%，实测 ' + (p95 * 100).toFixed(2) + '%')
  assert.ok(cos05 > 0.99, '斥力方向应几乎一致（p05 余弦 > 0.99），实测 ' + cos05.toFixed(4))
})

test('成对斥力：两点互相推开且合力为零（牛顿第三定律）', () => {
  const nodes = [{ x: 0, y: 0 }, { x: 100, y: 0 }]
  const engine = new RepulsionEngine(2)
  const { fx, fy } = engine.compute(nodes, { repulsion: 3000, theta: 0 })
  assert.ok(fx[0] < 0 && fx[1] > 0, '两点应沿 x 轴互相推开：' + fx[0] + ' / ' + fx[1])
  assert.ok(Math.abs(fy[0]) < 1e-9 && Math.abs(fy[1]) < 1e-9, 'y 方向不该有分量')
  assert.ok(Math.abs(fx[0] + fx[1]) < 1e-9, '合力应为零')
})

test('对称分布的节点受力互相抵消（不会整体漂移）', () => {
  const nodes = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ x: Math.cos((i / 8) * Math.PI * 2) * 200, y: Math.sin((i / 8) * Math.PI * 2) * 200 }))
  const engine = new RepulsionEngine(nodes.length)
  const { fx, fy } = engine.compute(nodes, { repulsion: 3000, theta: 0 })
  const sumX = fx.reduce((a, b) => a + b, 0)
  const sumY = fy.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sumX) < 1e-6 && Math.abs(sumY) < 1e-6, '环形分布合力应为零：' + sumX + ' / ' + sumY)
})

test('重合点与 NaN 不产生非有限值', () => {
  const nodes = [{ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 10 }, { x: NaN, y: 4 }, { x: 4, y: undefined }]
  const engine = new RepulsionEngine(nodes.length)
  const { fx, fy } = engine.compute(nodes, { repulsion: 3000 })
  for (let i = 0; i < nodes.length; i += 1) {
    assert.ok(Number.isFinite(fx[i]) && Number.isFinite(fy[i]), '第 ' + i + ' 个节点受力出现非有限值：' + fx[i] + ',' + fy[i])
  }
})

test('空图 / 单节点：不抛异常，受力为零', () => {
  const empty = new RepulsionEngine(0)
  const r0 = empty.compute([], { repulsion: 800 })
  assert.equal(r0.fx.length, 0)
  const one = new RepulsionEngine(1)
  const r1 = one.compute([{ x: 5, y: 5 }], { repulsion: 800 })
  assert.equal(r1.fx[0], 0)
  assert.equal(r1.fy[0], 0)
})

test('拖拽节点被跳过（自身不受力），但仍对邻居产生斥力', () => {
  const nodes = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 120, y: 0 }]
  const engine = new RepulsionEngine(nodes.length)
  const { fx } = engine.compute(nodes, { repulsion: 3000, skipIndex: 1 })
  assert.equal(fx[1], 0, '拖拽中节点自身不应受力')
  assert.notEqual(fx[0], 0, '邻居仍应被拖拽节点推开')
  assert.ok(fx[0] < 0, '左侧邻居应被推向左')
})

test('单步模拟：速度上限、边弹簧吸引、静置 quietTicks', () => {
  const nodes = [
    { id: 'a', type: 'knowledge', x: -400, y: 0, vx: 0, vy: 0 },
    { id: 'b', type: 'knowledge', x: 400, y: 0, vx: 0, vy: 0 },
  ]
  const sim = {
    nodes,
    edges: [{ sourceNodeId: 'a', targetNodeId: 'b', weight: 1 }],
    nodeById: new Map(nodes.map((n) => [n.id, n])),
    clustered: false,
    typeCenters: {},
    dragNode: null,
    tickCount: 0,
    quietTicks: 0,
  }
  stepSimulation(sim, { params: { repulsion: 2000, attraction: 0.05, centerGravity: 0, velCap: 6, theta: 0.9 } })
  assert.ok(nodes[0].vx > 0 && nodes[1].vx < 0, '边弹簧应把两端拉近')

  // 速度上限作用在斥力/重力积分那一步（与改造前一致：边弹簧在其后叠加）
  const noEdge = {
    nodes: [{ id: 'c', type: 'knowledge', x: 1, y: 0, vx: 0, vy: 0 }, { id: 'd', type: 'knowledge', x: -1, y: 0, vx: 0, vy: 0 }],
    edges: [],
    nodeById: null,
    clustered: false,
    typeCenters: {},
    dragNode: null,
    tickCount: 10,
    quietTicks: 0,
  }
  stepSimulation(noEdge, { params: { repulsion: 4000, attraction: 0, centerGravity: 0, velCap: 6, theta: 0.9 } })
  assert.ok(Math.abs(noEdge.nodes[0].vx) <= 6, '斥力积分后速度必须被 velCap 截断，实测 ' + noEdge.nodes[0].vx)
  assert.ok(Math.abs(noEdge.nodes[1].vx) <= 6, '另一侧同样截断')

  // 把两端手动放到理想距离、速度清零 → 静置计数应开始增长
  const still = {
    nodes: nodes.map((n) => Object.assign({}, n, { x: -50, y: 0, vx: 0, vy: 0 })),
    edges: [],
    nodeById: null,
    clustered: false,
    typeCenters: {},
    dragNode: null,
    tickCount: 200,
    quietTicks: 0,
  }
  for (let i = 0; i < 5; i += 1) stepSimulation(still, { params: { repulsion: 0, attraction: 0, centerGravity: 0, velCap: 6, theta: 0.9 } })
  assert.ok(still.quietTicks >= 5, '静止时应累计 quietTicks（改造前的停车依据），实测 ' + still.quietTicks)
  assert.ok(QUIET_RMS > 0, '静置阈值保持原值')
})

test('2049 节点 / 10106 边：单 tick 耗时基线与访问次数（远低于 O(n²)）', () => {
  const nodes = randomNodes(2049, 41)
  const edges = []
  const rnd = mulberry32(99)
  for (let i = 0; i < 10106; i += 1) edges.push({ sourceNodeId: 'n' + Math.floor(rnd() * 2049), targetNodeId: 'n' + Math.floor(rnd() * 2049), weight: 1 })
  const sim = {
    nodes,
    edges,
    nodeById: new Map(nodes.map((n) => [n.id, n])),
    clustered: false,
    typeCenters: {},
    dragNode: null,
    tickCount: 0,
    quietTicks: 0,
  }
  const params = forceParamsFor(2049)
  // 预热编译路径，再取 10 tick 的平均值（与探针一样取稳定态）
  for (let i = 0; i < 3; i += 1) stepSimulation(sim, { params, theta: 0.9 })
  const t0 = performance.now()
  let visits = 0
  for (let i = 0; i < 10; i += 1) visits = stepSimulation(sim, { params, theta: 0.9 }).visits
  const perTick = (performance.now() - t0) / 10
  const bruteStart = performance.now()
  bruteForceRepulsion(nodes, params.repulsion)
  const bruteMs = performance.now() - bruteStart
  console.log('    · 2049 节点单 tick（BH, theta=0.9）: ' + perTick.toFixed(2) + 'ms · 访问 ' + visits + ' 次（n² = ' + (2049 * 2049) + '）')
  console.log('    · 同规模精确 O(n²) 斥力单次: ' + bruteMs.toFixed(2) + 'ms · 加速比 ' + (bruteMs / perTick).toFixed(1) + '×')
  assert.ok(visits > 0 && visits < (2049 * 2049) / 4, 'Barnes–Hut 访问次数必须远低于全对：' + visits)
  assert.ok(perTick < 16, '2049 节点单 tick 必须 < 16ms，实测 ' + perTick.toFixed(2) + 'ms')
  assert.ok(perTick < bruteMs / 3, 'BH 至少应比精确 O(n²) 快 3×，实测 ' + (bruteMs / perTick).toFixed(1) + '×')
})

test('布局质量：BH 与精确 O(n²) 各自跑 60 tick，整体尺度与平均距离接近', () => {
  const build = () => randomNodes(300, 5)
  const run = (nodes, theta) => {
    const sim = {
      nodes,
      edges: [],
      nodeById: null,
      clustered: false,
      typeCenters: {},
      dragNode: null,
      tickCount: 0,
      quietTicks: 0,
    }
    const params = Object.assign(forceParamsFor(300), { repulsion: 2000 })
    for (let i = 0; i < 60; i += 1) stepSimulation(sim, { params, theta })
    return nodes
  }
  const approx = run(build(), 0.9)
  const exact = run(build(), 0)
  const stats = (nodes) => {
    const xs = nodes.map((n) => n.x)
    const ys = nodes.map((n) => n.y)
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    let sum = 0
    let pairs = 0
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        sum += Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y)
        pairs += 1
      }
    }
    return { span, mean: sum / pairs }
  }
  const a = stats(approx)
  const b = stats(exact)
  assert.ok(Math.abs(a.span - b.span) / b.span < 0.2, '整体尺度偏差应 < 20%：' + a.span.toFixed(1) + ' vs ' + b.span.toFixed(1))
  assert.ok(Math.abs(a.mean - b.mean) / b.mean < 0.2, '平均节点间距应接近：' + a.mean.toFixed(1) + ' vs ' + b.mean.toFixed(1))
  const nan = approx.filter((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y))
  assert.equal(nan.length, 0, '布局过程不允许出现 NaN 坐标')
})
