// 配额（quota）：把 MengBot 下发的 caps 变成**真正会拦的动作**。
//
// 现状问题：`caps: { seats: 10, apps: 5 }` 只出现在 /cloud/billing/plan 的返回里，
// 对实际调用没有任何约束 —— 意味着「套餐」只是显示，不构成限制，收费没有抓手。
//
// 这里定义三类可执行配额（都按租户 owner 维度）：
//   · cards  卡片总数上限（写操作时校验，超限 429）
//   · rpm    每分钟请求数（滑动窗口，超限 429）
//   · vaults 可访问的库数量（多库场景预留）
//
// 配额来源优先级：access.caps 显式字段 > plan 默认 > 兜底默认。
// 这样 MengBot 只要在 webhook / entitlement 里带上 caps.cards，无需改代码就生效。

/** 各套餐的默认配额（MengBot 没传 caps 时用）。 */
export const PLAN_QUOTA = {
  free: { cards: 500, rpm: 60, vaults: 1 },
  pro: { cards: 5000, rpm: 300, vaults: 1 },
  team: { cards: 20000, rpm: 600, vaults: 5 },
  enterprise: { cards: 200000, rpm: 1200, vaults: 50 },
}

/** 兜底（连 plan 都认不出时）：宁可比 free 宽松一点，也不要误伤。 */
export const DEFAULT_QUOTA = { cards: 2000, rpm: 120, vaults: 1 }

/** 数字清洗：正整数才算数，别让 "abc" / -1 / null 把限制算成 NaN。 */
function posInt(v) {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 解析某个租户实际生效的配额。
 * @param {{plan?:string, caps?:object, status?:string}} access resolveAccess() 的返回值
 * @param {object} [env] 可选：允许用 MEMORY_QUOTA_* 覆盖（运维兜底）
 */
export function quotaFor(access = {}, env = process.env) {
  const plan = String((access && access.plan) || 'free').toLowerCase()
  const base = { ...(PLAN_QUOTA[plan] || DEFAULT_QUOTA) }
  const caps = (access && access.caps) || {}

  // ① caps 里显式给了就用它（MengBot 可以随时调整套餐而不必发版）
  for (const k of ['cards', 'rpm', 'vaults']) {
    const v = posInt(caps[k])
    if (v) base[k] = v
  }

  // ② 兜底换算：MengBot 目前只下发 seats / apps，没有 cards。
  //
  // 【这段逻辑的来源与移除条件 —— 别让它变成历史遗留】
  //   约定出处：MengBot 第 3 封回复（docs/mengbot-round3.md §2）B1 答复——
  //     「字段下发前，你们继续用 seats × 1000 兜底，不需要改代码」
  //     「caps.cards 上线时先按不低于对端兜底值下发（pro ≥ seats×1000 = 10000、rpm ≥ 300、vaults ≥ 1）」
  //
  //   移除条件：**当 MengBot 开始下发 caps.cards 之后**，这个分支自然不再触发
  //   （因为上面 ① 已经写入 base.cards，下面 `!posInt(caps.cards)` 为 false）。
  //   也就是说不需要专门删代码，只要确认线上 entitlement 里出现了 caps.cards 即可。
  //
  //   为什么保留 1000/席位：这是给对方认可的默认值。下调前他们会提前一轮通知，
  //   由我们决定是否放宽硬拦（我们的 429 是真拦，数值定低了会直接打断在用用户）。
  const SEATS_TO_CARDS = 1000
  if (posInt(caps.seats) && !posInt(caps.cards)) {
    base.cards = Math.max(base.cards, posInt(caps.seats) * SEATS_TO_CARDS)
    // 只提示一次（这个方法每个请求都会调，刷屏没意义）
    if (!seatsFallbackWarned && env && env.MEMORY_QUOTA_QUIET !== '1') {
      seatsFallbackWarned = true
      try {
        console.error(
          `[memory-eternal-cloud] 配额兜底：entitlement 未下发 caps.cards，按 seats(${posInt(caps.seats)}) × ${SEATS_TO_CARDS} = ${base.cards} 张估算。` +
          `（MengBot 承诺后续下发显式 caps.cards，届时本提示自动消失）`,
        )
      } catch { /* 忽略 */ }
    }
  }

  // ③ 运维覆盖（紧急放行某租户用）
  const envCards = posInt(env && env.MEMORY_QUOTA_CARDS)
  const envRpm = posInt(env && env.MEMORY_QUOTA_RPM)
  if (envCards) base.cards = envCards
  if (envRpm) base.rpm = envRpm

  return { ...base, plan, source: posInt(caps.cards) ? 'caps' : 'plan+seats-fallback' }
}

/** seats→cards 兜底只提示一次（避免每请求刷一行日志）。 */
let seatsFallbackWarned = false

/**
 * 滑动窗口限速器（进程内，按 owner 分桶）。
 *
 * 为什么不用固定窗口：固定窗口在边界处能放过去 2 倍流量。
 * 为什么放内存：限速本来就是「尽力而为」，进程重启清零可以接受；
 * 上 Redis 会让云端多一个强依赖，不值得。
 */
export function createRateLimiter({ now = () => Date.now() } = {}) {
  /** @type {Map<string, number[]>} owner → 时间戳数组 */
  const buckets = new Map()

  return {
    /**
     * 记一次请求并判断是否超限。
     * @param {string} owner
     * @param {number} rpm 每分钟上限
     * @returns {{ok:boolean, used:number, limit:number, retryAfterSeconds:number}}
     */
    hit(owner, rpm) {
      const key = String(owner || 'anonymous')
      const limit = posInt(rpm) || DEFAULT_QUOTA.rpm
      const t = now()
      const windowMs = 60_000
      const arr = (buckets.get(key) || []).filter((ts) => t - ts < windowMs)
      if (arr.length >= limit) {
        const oldest = arr[0] || t
        const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (t - oldest)) / 1000))
        buckets.set(key, arr)
        return { ok: false, used: arr.length, limit, retryAfterSeconds }
      }
      arr.push(t)
      buckets.set(key, arr)
      // 顺手清理：桶太大就砍掉过期项，避免内存无限涨
      if (buckets.size > 5000) {
        for (const [k, v] of buckets) {
          if (!v.length || t - v[v.length - 1] > windowMs * 2) buckets.delete(k)
        }
      }
      return { ok: true, used: arr.length, limit, retryAfterSeconds: 0 }
    },
    /** 测试/诊断用：看某租户当前窗口内的请求数。 */
    peek(owner) {
      const t = now()
      return ((buckets.get(String(owner || 'anonymous')) || []).filter((ts) => t - ts < 60_000)).length
    },
    reset() { buckets.clear() },
  }
}

/**
 * 卡片数配额判断。
 * @param {number} used 当前卡片数
 * @param {{cards:number}} quota
 * @returns {{ok:boolean, used:number, limit:number}}
 */
export function checkCardQuota(used, quota) {
  const limit = posInt(quota && quota.cards) || DEFAULT_QUOTA.cards
  const u = Number(used) || 0
  return { ok: u < limit, used: u, limit }
}

/** 统一的配额超限响应体（客户端据此显示「升级套餐」）。 */
export function quotaExceededBody({ kind, used, limit, plan, retryAfterSeconds = 0 }) {
  const label = kind === 'rpm' ? '请求' : kind === 'cards' ? '卡片' : kind
  return {
    ok: false,
    code: 'quota_exceeded',
    error: `已达套餐上限：${label} ${used}/${limit}（${plan} 套餐）`,
    kind,
    used,
    limit,
    plan,
    retryAfterSeconds,
    hint: '升级套餐后立即生效，无需重新登录',
  }
}
