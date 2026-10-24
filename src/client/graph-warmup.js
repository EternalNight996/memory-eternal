// 知识图谱「预热」策略（纯函数，便于单测，防止「200 次同步 tick」回归）。
//
// 背景（真实事故）：GraphCanvas 之前在主线程里一次性同步跑
//   for (let s = 0; s < 200; s++) tick()
// 1084 个节点时一次 tick 是 O(n²) ≈ 1.2M 次距离计算，实测单次阻塞 1.1–1.9s
// （低配 CPU 上 6.7s），期间页面完全冻结、画布空白 —— 用户看到的就是
// 「打开知识星图一片空白，点一下时间维就白屏」。
//
// 现在把预热拆成「多帧 + 每帧时间预算 + 总次数随节点数收缩」，并且先同步画
// 一帧（不依赖 requestAnimationFrame，窗口被遮挡/未聚焦时也能出内容）。

/** 每帧预热最多占用的主线程时间（ms）。一帧里跑满这个预算就必须让出线程。 */
export const WARM_FRAME_BUDGET_MS = 12

/** 预热总次数上限：节点越多，单次 tick 越贵，次数越少（1200 节点以上只做粗排）。 */
export const WARM_TICKS_MAX = 200
export const WARM_TICKS_MIN = 48

/**
 * 按节点数决定预热 tick 次数。
 * 目标：预热总工作量大致可控（≈ 300 节点 × 200 tick 的量级），而不是固定 200 次。
 * @param {number} nodeCount 节点数
 * @returns {number} 预热 tick 次数（WARM_TICKS_MIN..WARM_TICKS_MAX）
 */
export function warmTicksFor(nodeCount) {
  const n = Math.floor(Number(nodeCount) || 0)
  if (n <= 0) return 0 // 没有节点就没什么可预热的
  if (n > 1200) return WARM_TICKS_MIN
  if (n > 700) return 60
  if (n > 300) return 110
  return WARM_TICKS_MAX
}

/** 预热是否未完成（warmLeft > 0）——预热期间不启动常规 rAF 循环，避免双重 tick。 */
export function warmingLeft(warmLeft) {
  return Math.max(0, Math.floor(Number(warmLeft) || 0))
}
