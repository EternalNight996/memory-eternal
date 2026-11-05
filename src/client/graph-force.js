// 知识图谱力导向内核：Barnes–Hut 四叉树斥力 + 单步物理（纯函数，便于单测）。
//
// 背景（真实事故）：GraphCanvas 每个 tick 对全部节点做 O(n²) 全对斥力。
// 2049 节点时单次 tick ≈ 4.2M 次距离计算（实测 20–40ms），而点击/悬停/选中都会
// 唤醒连续 tick —— 一帧 30–45ms，点击后要连续跑几十帧才可能静下来，表现就是
// 「点击即渲染卡死」。
//
// 这里把斥力换成 Barnes–Hut 四叉树：远处的一团节点按质心近似，单次 tick 降到
// O(n log n)。力常数、阻尼、速度上限、边弹簧、聚类重力全部保持原样，所以布局观感
// 与改造前一致（仅远处成团节点被近似）。
//
// 设计约束：
//   - 复用缓冲（Float64Array/Int32Array），每 tick 不分配新对象，避免 GC 抖动；
//   - theta 是精度/速度旋钮：0 = 精确全对（仅测试用），越大越快；
//   - 四叉树节点池固定容量，超出时把叶子退化为「质心叶」，绝不无限增长。

/** 按节点数取与改造前完全一致的力常数（theta 是新增的 BH 精度参数）。 */
export function forceParamsFor(nodeCount) {
  const nn = Math.floor(Number(nodeCount) || 0)
  const repulsion = nn > 1000 ? 3000 : nn > 100 ? 2000 : nn > 50 ? 1200 : 800
  const attraction = nn > 100 ? 0.002 : 0.005
  const centerGravity = nn > 1000 ? 0.012 : nn > 100 ? 0.005 : 0.01
  const velCap = nn > 1000 ? 6 : nn > 200 ? 12 : 24
  return { repulsion, attraction, centerGravity, velCap, theta: 0.8 }
}

/** 一次 tick 后判定静止的阈值（与改造前一致）。 */
export const QUIET_RMS = 0.05
/** 连续静帧超过这个数就停车（与改造前一致）。 */
export const QUIET_TICKS = 30

function quadrant(cx, cy, x, y) {
  return (x >= cx ? 1 : 0) + (y >= cy ? 2 : 0)
}

/**
 * 可复用的四叉树斥力引擎。
 * 容量按节点数一次性分配；每 tick 只把 count 归零并复用节点槽位。
 */
export class RepulsionEngine {
  constructor(capacity) {
    // 四叉树每个内部节点固定占 4 个槽位（孩子可能暂时为空），
    // 典型分布下内部节点 ≈ n/2，总槽位 ≈ 3n；留 6n 冗余，避免退化成「质心叶」。
    const cap = Math.max(16, Math.floor(Number(capacity) || 0) * 6 + 16)
    this.capacity = Math.max(0, Math.floor(Number(capacity) || 0))
    this.cap = cap
    this.cx = new Float64Array(cap)
    this.cy = new Float64Array(cap)
    this.half = new Float64Array(cap)
    this.mass = new Float64Array(cap)
    this.mx = new Float64Array(cap)
    this.my = new Float64Array(cap)
    this.child = new Int32Array(cap * 4)
    this.point = new Int32Array(cap) // -1 空叶 / -2 聚合叶 / >=0 单点叶
    this.fx = new Float64Array(this.capacity)
    this.fy = new Float64Array(this.capacity)
    this.count = 0
    this.lastVisits = 0
  }

  ensureCapacity(size) {
    if (size <= this.capacity) return
    // 节点数变化的极端情况：整体重建（正常使用不会触发）
    const next = new RepulsionEngine(size)
    this.capacity = next.capacity
    this.cap = next.cap
    this.cx = next.cx
    this.cy = next.cy
    this.half = next.half
    this.mass = next.mass
    this.mx = next.mx
    this.my = next.my
    this.child = next.child
    this.point = next.point
    this.fx = next.fx
    this.fy = next.fy
    this.count = 0
  }

  newNode(cx, cy, half) {
    if (this.count >= this.cap) return -1
    const i = this.count++
    this.cx[i] = cx
    this.cy[i] = cy
    this.half[i] = half
    this.mass[i] = 0
    this.mx[i] = 0
    this.my[i] = 0
    this.point[i] = -1
    const c = i * 4
    this.child[c] = -1
    this.child[c + 1] = -1
    this.child[c + 2] = -1
    this.child[c + 3] = -1
    return i
  }

  insert(nodes, idx, nodeIndex) {
    const p = nodes[nodeIndex]
    if (!p) return
    const x = Number(p.x) || 0
    const y = Number(p.y) || 0
    this.mass[idx] += 1
    this.mx[idx] += x
    this.my[idx] += y
    const c = idx * 4
    if (this.child[c] === -1 && this.child[c + 1] === -1 && this.child[c + 2] === -1 && this.child[c + 3] === -1) {
      if (this.point[idx] === -1) {
        this.point[idx] = nodeIndex
        return
      }
      const half = this.half[idx] / 2
      if (half < 1e-3 || this.count + 4 > this.cap) {
        // 无法再细分：把叶子当「质心叶」（mass 已累计，力按质心近似）
        this.point[idx] = -2
        return
      }
      const cx = this.cx[idx]
      const cy = this.cy[idx]
      for (let q = 0; q < 4; q += 1) {
        this.child[c + q] = this.newNode(cx + (q & 1 ? half : -half), cy + (q & 2 ? half : -half), half)
      }
      const previous = this.point[idx]
      this.point[idx] = -2
      if (previous >= 0) {
        const prev = nodes[previous]
        this.insert(nodes, this.child[c + quadrant(cx, cy, Number(prev.x) || 0, Number(prev.y) || 0)], previous)
      }
      this.insert(nodes, this.child[c + quadrant(cx, cy, x, y)], nodeIndex)
      return
    }
    this.insert(nodes, this.child[c + quadrant(this.cx[idx], this.cy[idx], x, y)], nodeIndex)
  }

  build(nodes) {
    const nn = nodes.length
    this.count = 0
    this.lastVisits = 0
    if (nn === 0) return -1
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < nn; i += 1) {
      const x = Number(nodes[i].x) || 0
      const y = Number(nodes[i].y) || 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const half = Math.max(1, Math.max(maxX - minX, maxY - minY) / 2) * 1.001
    const root = this.newNode(cx, cy, half)
    if (root < 0) return -1
    for (let i = 0; i < nn; i += 1) this.insert(nodes, root, i)
    return root
  }

  accumulate(idx, target, tx, ty, repulsion, theta) {
    const mass = this.mass[idx]
    if (mass <= 0) return
    const comX = this.mx[idx] / mass
    const comY = this.my[idx] / mass
    const dx = tx - comX
    const dy = ty - comY
    const d2 = dx * dx + dy * dy
    if (d2 < 1e-9) return
    const isLeaf = this.child[idx * 4] === -1
    if (isLeaf && this.point[idx] === target) return
    const d = Math.sqrt(d2)
    this.lastVisits += 1
    if (isLeaf || (2 * this.half[idx]) / d < theta) {
      const f = (repulsion * mass) / d2
      this.fx[target] += (dx / d) * f
      this.fy[target] += (dy / d) * f
      return
    }
    const c = idx * 4
    for (let q = 0; q < 4; q += 1) {
      const child = this.child[c + q]
      if (child >= 0) this.accumulate(child, target, tx, ty, repulsion, theta)
    }
  }

  /**
   * 用 Barnes–Hut 计算斥力（结果写入 this.fx / this.fy）。
   * @param {Array<{x:number,y:number}>} nodes
   * @param {{repulsion:number, theta?:number, skipIndex?:number}} params
   */
  compute(nodes, params) {
    const nn = nodes.length
    this.ensureCapacity(nn)
    const fx = this.fx
    const fy = this.fy
    fx.fill(0)
    fy.fill(0)
    this.lastVisits = 0
    const root = this.build(nodes)
    if (root < 0) return { fx, fy, visits: 0 }
    const repulsion = params.repulsion
    const theta = params.theta === undefined ? 0.8 : params.theta
    const skip = params.skipIndex === undefined ? -1 : params.skipIndex
    for (let i = 0; i < nn; i += 1) {
      if (i === skip) continue
      const n = nodes[i]
      this.accumulate(root, i, Number(n.x) || 0, Number(n.y) || 0, repulsion, theta)
    }
    return { fx, fy, visits: this.lastVisits }
  }
}

/**
 * 一步力导向模拟（与改造前的 tick 力学习惯完全一致，只把斥力换成 BH）。
 * sim 需要：nodes[{x,y,vx,vy,type}], edges[{sourceNodeId,targetNodeId,weight}],
 *          nodeById(Map), clustered, typeCenters, dragNode, tickCount, quietTicks。
 * @returns {{rms:number, tickCount:number, quietTicks:number, params:object, visits:number}}
 */
export function stepSimulation(sim, options = {}) {
  const nodes = sim.nodes
  const nn = nodes.length
  const params = options.params || forceParamsFor(nn)
  const theta = options.theta === undefined ? params.theta : options.theta
  sim.tickCount = (sim.tickCount || 0) + 1

  // 冷却（d3-force 同款思路）：先满强度跑 settleTicks 让结构自组织，
  // 之后 alpha 衰减到 0 —— 力归零、速度自然衰减，rms 才会真正掉到静置阈值以下，
  // rAF 才能停车。拖拽时把目标抬到 0.35（reheat），松手后继续冷却。
  const settleTicks = options.settleTicks === undefined ? 460 : options.settleTicks
  const alphaDecay = options.alphaDecay === undefined ? 0.08 : options.alphaDecay
  if (sim.alpha === undefined) sim.alpha = 1
  if (sim.tickCount <= settleTicks) sim.alpha = 1
  else sim.alpha += ((sim.dragNode ? 0.35 : 0) - sim.alpha) * alphaDecay
  if (sim.alpha < 1e-4) sim.alpha = 0
  // 「常驻自移动」模式的下限：冷却到 floor 后不再归零，力一直存在 → 布局像改造前一样持续轻微漂移。
  // 默认 0（旧行为：完全冷却停车），由调用方按需开启。
  const alphaFloor = Math.max(0, Math.min(1, Number(options.alphaFloor) || 0))
  if (sim.alpha < alphaFloor) sim.alpha = alphaFloor
  const alpha = options.alpha === undefined ? sim.alpha : options.alpha

  const cool = Math.min(0.4, sim.tickCount / 1500)
  // 常驻自移动时允许调用方放宽阻尼：阻尼越小，速度保留越久，散乱漂移越明显
  // （默认仍是 0.9 - cool，与改造前完全一致；只有漂移模式会传 override）。
  const damping = options.damping === undefined ? 0.9 - cool : Math.max(0.1, Math.min(0.95, Number(options.damping) || 0.5))
  const dragIndex = sim.dragNode ? nodes.indexOf(sim.dragNode) : -1

  if (!sim.forceEngine || sim.forceEngine.capacity < nn) sim.forceEngine = new RepulsionEngine(nn)
  const repulsion = sim.forceEngine.compute(nodes, { repulsion: params.repulsion * alpha, theta: theta, skipIndex: dragIndex })
  const fx = repulsion.fx
  const fy = repulsion.fy

  for (let i = 0; i < nn; i += 1) {
    if (i === dragIndex) continue
    const n = nodes[i]
    let ax = fx[i]
    let ay = fy[i]
    if (!Number.isFinite(ax)) ax = 0
    if (!Number.isFinite(ay)) ay = 0
    if (sim.clustered && sim.typeCenters && sim.typeCenters[n.type]) {
      const tc = sim.typeCenters[n.type]
      ax += (tc.x - n.x) * 0.006 * alpha
      ay += (tc.y - n.y) * 0.006 * alpha
    } else {
      ax -= n.x * params.centerGravity * alpha
      ay -= n.y * params.centerGravity * alpha
    }
    let nvx = ((Number(n.vx) || 0) + ax) * damping
    let nvy = ((Number(n.vy) || 0) + ay) * damping
    if (nvx > params.velCap) nvx = params.velCap
    else if (nvx < -params.velCap) nvx = -params.velCap
    if (nvy > params.velCap) nvy = params.velCap
    else if (nvy < -params.velCap) nvy = -params.velCap
    n.vx = nvx
    n.vy = nvy
  }

  const edges = sim.edges || []
  const pairs = sim.edgePairs || null
  const map = sim.nodeById || null
  const edgeCount = pairs ? pairs.length / 2 : edges.length
  for (let e = 0; e < edgeCount; e += 1) {
    let s
    let t
    if (pairs) {
      s = nodes[pairs[e * 2]]
      t = nodes[pairs[e * 2 + 1]]
    } else {
      const edge = edges[e]
      s = map ? map.get(edge.sourceNodeId) : null
      t = map ? map.get(edge.targetNodeId) : null
    }
    if (!s || !t) continue
    const dx = t.x - s.x
    const dy = t.y - s.y
    const d = Math.sqrt(dx * dx + dy * dy) || 1
    const f = (d - 100) * params.attraction * alpha
    const ax = (dx / d) * f
    const ay = (dy / d) * f
    if (sim.dragNode !== s) {
      s.vx += ax
      s.vy += ay
    }
    if (sim.dragNode !== t) {
      t.vx -= ax
      t.vy -= ay
    }
  }

  let kinetic = 0
  for (let i = 0; i < nn; i += 1) {
    const n = nodes[i]
    if (i === dragIndex) continue
    n.x += n.vx
    n.y += n.vy
    kinetic += n.vx * n.vx + n.vy * n.vy
  }
  const rms = nn ? Math.sqrt(kinetic / nn) : 0
  if (rms < QUIET_RMS && sim.tickCount > 60 && !sim.dragNode) sim.quietTicks = (sim.quietTicks | 0) + 1
  else sim.quietTicks = 0
  return { rms, tickCount: sim.tickCount, quietTicks: sim.quietTicks, params, visits: repulsion.visits, alpha }
}

/**
 * 精确 O(n²) 斥力（仅供单测对照 / 小图诊断；生产走 Barnes–Hut）。
 * 与改造前 tick() 里的公式逐字一致：f = repulsion / d²。
 */
export function bruteForceRepulsion(nodes, repulsion) {
  const nn = nodes.length
  const fx = new Float64Array(nn)
  const fy = new Float64Array(nn)
  for (let i = 0; i < nn; i += 1) {
    const n = nodes[i]
    let ax = 0
    let ay = 0
    for (let j = 0; j < nn; j += 1) {
      if (i === j) continue
      const m = nodes[j]
      const dx = n.x - m.x
      const dy = n.y - m.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const f = repulsion / (d * d)
      ax += (dx / d) * f
      ay += (dy / d) * f
    }
    fx[i] = ax
    fy[i] = ay
  }
  return { fx, fy }
}
