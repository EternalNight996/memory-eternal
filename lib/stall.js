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
 * @param {number} [input.everStopped] 本次运行**至今**收到的收尾事件数（缺省 = stoppedAt.length）
 * @returns {{alert:boolean, started:number, stopped:number, windowMs:number, reason:string}}
 */
export function evaluateStall({ claimedAt = [], stoppedAt = [], now = Date.now(), windowMs = 20 * 60 * 1000, minStarted = 3, everStopped } = {}) {
  const from = now - windowMs
  const started = claimedAt.filter((t) => t >= from).length
  const stopped = stoppedAt.filter((t) => t >= from).length
  // 2026-10-09：再加一条硬前提 —— 「事件被改名/移除」是**进程生命周期**属性，不是窗口属性。
  // 只要本次运行里见过哪怕一次收尾，事件通路就是通的；窗口内 0 收尾只说明「当前这一轮还没结束」
  // （实测：一轮几十分钟的对话里 agent/inbox/claimed 会多次触发，而 turn-stopping 要等回合真的
  // 结束才来 —— 20 分钟窗口必然 3 次 claim / 0 收尾，于是长回合被误报成「收尾事件疑似失效」，
  // 并且把「自动沉淀异常」这个红警报推给了用户）。真的被改名时，本次运行会是 0 收尾。
  const ever = Number.isFinite(everStopped) ? Number(everStopped) : stoppedAt.length
  if (ever > 0) return { alert: false, started, stopped, windowMs, reason: 'wiring-proven' }
  return { alert: started >= minStarted && stopped === 0, started, stopped, windowMs, reason: 'no-stop-ever' }
}

/** 时间戳数组的裁剪上限：只保留窗口相关的近邻，避免长跑无界增长。 */
export const MAX_STAMPS = 200
