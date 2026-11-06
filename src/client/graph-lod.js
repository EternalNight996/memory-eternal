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
export function labelBudget(nodeCount) {
  const n = Number(nodeCount) || 0
  if (n <= 120) return Infinity
  if (n <= 300) return 160
  if (n <= 600) return 90
  return 60
}

/**
 * 挑出允许画标签的节点 id 集合。
 * @param {Array<{id:string}>} nodes
 * @param {{limit?:number, focusId?:string|null, hoverId?:string|null, searchHits?:Iterable<string>|null, degree?:Record<string,number>|null}} opts
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
  const rest = []
  for (const n of Array.isArray(nodes) ? nodes : []) if (n && n.id && !out.has(n.id)) rest.push(n)
  rest.sort((a, b) => deg(b.id) - deg(a.id))
  for (const n of rest) { if (out.size >= limit) break; out.add(n.id) }
  return out
}
