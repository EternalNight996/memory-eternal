// 知识图谱 LOD（细节层级）工具：视口剔除 + 标签预算。
//
// 背景：589 张卡时「放大后异常卡顿」。根因是两件事叠加：
//   1) 放大越过 labelThreshold 后，**所有**节点每帧都要 measureText + 圆角矩形 + fillText；
//   2) 整张图（含视口外的节点与边）每帧都在画 —— 放大后绝大多数元素根本不在屏幕上。
// 这里只放纯数学，便于单测；渲染循环调用它们做剔除与标签预算。

/** 当前视口对应的世界坐标矩形（含 margin 余量）。世界→屏幕： s = w * zoom + pan。 */
export function visibleWorldRect({ panX = 0, panY = 0, zoom = 1, w = 0, h = 0, margin = 60 } = {}) {
  const z = zoom || 1
  return {
    x0: (0 - panX) / z - margin,
    y0: (0 - panY) / z - margin,
    x1: (w - panX) / z + margin,
    y1: (h - panY) / z + margin,
  }
}

/** 半径为 r 的圆是否与视口矩形相交（rect 为空视为全部可见）。 */
export function inRect(x, y, r, rect) {
  if (!rect) return true
  return x + r >= rect.x0 && x - r <= rect.x1 && y + r >= rect.y0 && y - r <= rect.y1
}

/**
 * 标签预算随节点数收敛：小图全画；大图只画焦点/悬停/搜索命中 + 度数最高的若干。
 * @returns {number} Infinity 表示不限制
 */
export function labelBudget(nodeCount, quality = 0) {
  const n = Number(nodeCount) || 0
  const q = Number(quality) || 0
  if (n <= 60) return Infinity
  // 160 条标签在放大时每帧都要 measureText + 圆角矩形 + fillText，是「放大后卡顿」的一半原因。
  // 收到 64：悬停/选中/搜索命中必留，其余按度数优先，够读且帧率稳。
  const base = n <= 600 ? 64 : 48
  // 自适应画质降到最低档（仍在掉帧）时，标签再减半：文字光栅化在弱 GPU 上很贵。
  return q >= 3 ? Math.min(base, 32) : base
}

/**
 * 挑出允许画标签的节点 id 集合。
 * @param {Array<{id:string}>} nodes
 * @param {{limit?:number, focusId?:string|null, hoverId?:string|null, searchHits?:Iterable<string>|null, degree?:Record<string,number>|null, order?:string[]|null}} opts
 * @returns {Set<string>}
 */
export function pickLabelIds(nodes, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : Infinity
  const out = new Set()
  const push = (id) => { if (id && out.size < limit) out.add(id) }
  push(opts.focusId)
  push(opts.hoverId)
  if (opts.searchHits) for (const id of opts.searchHits) { if (out.size >= limit) break; out.add(id) }
  const degree = opts.degree || {}
  const deg = (id) => Number(degree[id]) || 0
  const present = new Set()
  for (const n of Array.isArray(nodes) ? nodes : []) if (n && n.id) present.add(n.id)
  // order：调用方预先按度数排好的 id 列表（每帧省一次 O(n log n) 排序 + 一次数组分配）。
  const order = Array.isArray(opts.order) && opts.order.length
    ? opts.order
    : (Array.isArray(nodes) ? nodes : []).slice().sort((a, b) => deg(b.id) - deg(a.id)).map((n) => n.id)
  for (const id of order) {
    if (out.size >= limit) break
    if (id && present.has(id) && !out.has(id)) out.add(id)
  }
  return out
}
