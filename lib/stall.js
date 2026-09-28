// 记忆核心 · 「轮次收尾事件是否真的没来」判定
//
// 旧判据：turnsStarted > turnsStopped && claimIdleMs > 15min && idleMs > 15min。两个毛病：
//   1) 两个计数**累积且永不归零**，而被取消/被拒的轮次不发 turn-stopping（子代理轮次同样不计）
//      → 差额一旦出现就永久为真，判据退化成「只要空闲 15 分钟就报一次」（issue #4 的
//      「已开始 16 / 已收尾 12，且 15 分钟无任何沉淀活动」就是这么来的）；
//   2) 真故障的特征恰好相反：轮次**持续开始**、只是没有收尾 —— 此时 claimed 一直新鲜，
//      claimIdleMs 条件不满足 → 真故障反而不报。
//
// 现在改成滑动窗口：只看「窗口内开始了几个、收尾了几个」。
//   持续开始 + 零收尾 → 判停滞；用户离开（窗口内 0 开始）→ 不报。

/**
 * @param {object} input
 * @param {number[]} input.claimedAt 轮次开始时间戳（ms）
 * @param {number[]} input.stoppedAt 轮次收尾时间戳（ms）
 * @param {number} [input.now] 当前时间
 * @param {number} [input.windowMs] 观察窗口，默认 20 分钟
 * @param {number} [input.minStarted] 窗口内至少开始几个轮次才判停滞，默认 3
 * @returns {{alert:boolean, started:number, stopped:number, windowMs:number}}
 */
export function evaluateStall({ claimedAt = [], stoppedAt = [], now = Date.now(), windowMs = 20 * 60 * 1000, minStarted = 3 } = {}) {
  const from = now - windowMs
  const started = claimedAt.filter((t) => t >= from).length
  const stopped = stoppedAt.filter((t) => t >= from).length
  return { alert: started >= minStarted && stopped === 0, started, stopped, windowMs }
}

/** 时间戳数组的裁剪上限：只保留窗口相关的近邻，避免长跑无界增长。 */
export const MAX_STAMPS = 200
