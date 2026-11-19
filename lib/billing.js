// 支付/套餐：**不自己收钱，全部交给 MengBot**。
//
// 为什么：收单、对账、退款、发票、税 —— 自建等于重踩一遍合规坑，而 MengBot 侧已有
// `checkout` / `upgrade` / `cancel` 全链路（见 docs/MENGBOT-OIDC-WEBHOOK.md）。
//
// 我方只做三件事：
//   ① 把「用户点升级」翻译成对 MengBot 的 checkout 调用，拿到支付页 URL 交给浏览器；
//   ② 支付结果不靠轮询猜——MengBot 通过 webhook 推 `entitlement.updated`（见 lib/webhook.js）；
//   ③ 兜底：用户下次登录/`/cloud/connect` 时用 `session` 拉一次最新套餐。
//
// 支付：**直接拼 subscribe 深链**，不代用户调 MengBot（见 createCheckout 的注释）。
// 因此这里不再依赖 OIDC access_token / refresh_token —— 少一整条失败链。

import { readEntitlement } from './entitlement.js'
// 支付域逻辑在 domains.js（公开模块）：billing 是私有模块，不能反过来被 api.js 依赖
import { resolvePayBase, payBaseFromCloudUrl, DEFAULT_PAY_BASE } from './domains.js'

export { resolvePayBase, payBaseFromCloudUrl, DEFAULT_PAY_BASE }

/** MengBot 的云端 API 根（`/api/cloud/desktop/*` 挂在它下面）。 */
export function mengbotApiBase(env = process.env) {
  return String(
    env.MEMORY_MENGBOT_API_BASE
    || env.MEMORY_MENGBOT_BASE_URL
    || env.MEMORY_OIDC_ISSUER
    || '',
  ).trim().replace(/\/+$/, '')
}

/**
 * 可下单的套餐（**以 MengBot 第 3 封 B2 的正式定稿为准**）。
 *
 * | 值 | sku | 价格 |
 * |---|---|---|
 * | `personal` | `sub-personal` | ¥39/月 |
 * | `pro` | `sub-pro` | ¥79/月 |
 * | `max` | `sub-max` | ¥329/月 |
 *
 * **不是** `pro`/`team`/`enterprise` —— `team` 目前不存在、`enterprise` 已废弃。
 * MengBot 侧对未知 plan 返回 400 `{error:"unknown_plan", allowed:[...]}`，所以这里必须对齐，
 * 否则用户点「升级」会直接吃到 400。
 *
 * 也接受直接传 sku（`sub-pro`），MengBot 后端会原样识别 —— 这里不额外做映射，
 * 让调用方传什么就透传什么，避免两份白名单各自漂移。
 */
export const CHECKOUT_PLANS = ['personal', 'pro', 'max']

/**
 * 发起支付：**直接拼 subscribe 深链，不再调 MengBot 的 checkout 端点**。
 *
 * 为什么这么改（MengBot 第 4 封 Q2 确认）：
 *   · `https://pay.mengbot.vip/subscribe?sku=sub-max&source=memory-eternal`
 *     是**深链**：页面打开即进入该套餐支付流程，未登录会先弹登录框；
 *   · `order` 参数**不是必需的**（它只是 checkout 建单后带过去的备注）；
 *   · `source` 会以 `source:memory-eternal` 写进订单 note，渠道归因保留。
 *
 * 相比"代用户调 checkout"的好处：
 *   ① **不需要 `omc_` 设备令牌**（那是桌面客户端的，我们拿不到）；
 *   ② **不需要 OIDC access_token / refresh_token**（去掉整条代调用链）；
 *   ③ **支付会话不经过我们服务器代持** —— 安全上更正确；
 *   ④ 少一次跨服务调用，少一类失败点。
 *
 * 代价：拿不到 `priceFen`。要显示价格可以读 `GET /api/v1/market/plans`
 *（client 令牌可用），或用静态文案「¥79/月起」。
 *
 * @returns {{ok:boolean, url?:string, plan?:string, sku?:string, error?:string}}
 */
export async function createCheckout({ plan = 'pro', source = 'memory-eternal', owner, env = process.env, cloudUrl = '' } = {}) {
  const p = String(plan || '').trim().toLowerCase()
  // 也接受直接传 sku（`sub-pro`）—— 对方说后端会原样识别，我们不额外做映射
  const isSku = p.startsWith('sub-')
  const planName = isSku ? p.slice(4) : p
  if (!isSku && !CHECKOUT_PLANS.includes(planName)) {
    return { ok: false, error: `不支持的套餐：${plan}（可选 ${CHECKOUT_PLANS.join(' / ')}，或直接传 sku 如 sub-pro）` }
  }
  if (!owner) return { ok: false, error: '缺少 owner（必须先登录）' }

  const sku = isSku ? p : 'sub-' + planName
  // 支付域跟随当前云端实例：切了域名，升级链接跟着切（显式配置优先）
  const payBase = resolvePayBase({ env, cloudUrl })
  // ⚠ 深链必须带 merchant（MengBot 对接说明 §5.2）：
  //   https://pay.mengbot.vip/subscribe?merchant=memory-eternal&sku=sub-pro&source=memory-eternal
  // 少了 merchant，订阅页不知道是哪家商户，用户点了会落在一个不认识 sku 的空白页。
  const merchant = String(env.MEMORY_MERCHANT_ID || 'memory-eternal').trim()
  const params = new URLSearchParams({ merchant, sku, source: source || 'memory-eternal' })
  return { ok: true, url: payBase + '/subscribe?' + params.toString(), plan: planName, sku, merchant, via: 'subscribe-deeplink' }
}

/**
 * 从 MengBot 拉**权威套餐表**（名称 + 价格 + 配额）。
 *
 * 为什么必须有：面板只做展示，MengBot 才是扣款的权威。两边各自硬编码价格，
 * 一定会开叉（面板写 ¥18、支付页扣 ¥39）—— 那是比不显示更糟的体验。
 * 所以：能拉到就显示真实值；拉不到就**不显示数字**，只提示「以订阅页为准」。
 *
 * 端点：GET {mengbotApiBase}/api/v1/market/plans（client 令牌可用）
 * 失败/超时/格式不认识一律返回 null，绝不抛错（面板不能因为拿不到价格就崩）。
 *
 * @returns {Promise<Array<{plan:string,name:string,priceFen:number|null,price:number|null,cards:number|null,rpm:number|null,vaults:number|null}>|null>}
 */
export async function fetchMarketPlans({ env = process.env, token = '', fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  // 权威端点：https://pay.mengbot.vip/api/pricing（**无需鉴权**，见 MengBot 2026-11-19 对接说明）。
  // 域名跟随当前基座（备案域 / 临时域由 resolvePayBase 决定），不写死。
  const base = resolvePayBase({ env })
  if (!base) return null
  const headers = { Accept: 'application/json' }
  let data
  try {
    // 接口带 Cache-Control: no-store，要求面板缓存不超过 5 分钟 → 由 cachedMarketPlans 控制
    const r = await fetchImpl(base + '/api/pricing', { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!r || !r.ok) return null
    data = await r.json()
  } catch { return null }

  const list = Array.isArray(data) ? data : (Array.isArray(data && data.plans) ? data.plans : null)
  if (!list || !list.length) return null

  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }
  const norm = (item, fallbackTier = '') => {
    if (!item || typeof item !== 'object') return null
    // tier 是权益等级（personal/pro/max），sku 是下单凭据（sub-personal / sub-pro-year …）
    const tier = String(item.tier || fallbackTier || '').trim().toLowerCase()
    const sku = String(item.sku || '').trim()
    const plan = tier || String(item.plan || item.id || '').trim().toLowerCase().replace(/^sub-/, '')
    if (!plan) return null
    const fen = Number(item.priceFen)
    // priceFen 是权威值；price 仅用于展示（文档明确要求）
    const yuan = Number.isFinite(fen) ? Math.round(fen / 100) : num(item.price)
    return {
      plan,          // 与 /cloud/billing/plan 的 plan 字段对齐
      tier: tier || plan,
      sku,           // ⚠ 下单必须原样使用，不能自己拼
      name: String(item.name || '').trim(),
      price: Number.isFinite(yuan) ? yuan : null,
      priceFen: Number.isFinite(fen) ? fen : null,
      days: num(item.days),
      cards: num(item.caps && item.caps.cards),
      rpm: num(item.caps && item.caps.rpm),
      vaults: num(item.caps && item.caps.vaults),
      backupDays: num(item.backup && item.backup.days),
      backupDr: !!(item.backup && item.backup.dr),
    }
  }

  const plans = list.map((x) => norm(x)).filter(Boolean)
  if (!plans.length) return null
  const per = (data && data.periodPlans) || {}
  const half = (Array.isArray(per.half) ? per.half : []).map((x) => norm(x)).filter(Boolean)
  const year = (Array.isArray(per.year) ? per.year : []).map((x) => norm(x)).filter(Boolean)
  return { plans, periodPlans: { half, year }, currency: String(data.currency || 'CNY') }
}

/** 套餐表的进程内缓存（5 分钟）：面板每开一次都打一次 MengBot 太浪费。 */
const plansCache = { at: 0, key: '', value: null }
export async function cachedMarketPlans({ env = process.env, token = '', fetchImpl = fetch, ttlMs = 5 * 60 * 1000 } = {}) {
  const key = mengbotApiBase(env) + '|' + (token ? 't' : '-')
  if (plansCache.key === key && Date.now() - plansCache.at < ttlMs) return plansCache.value
  const v = await fetchMarketPlans({ env, token, fetchImpl })
  plansCache.key = key; plansCache.at = Date.now(); plansCache.value = v
  return v
}

/** 只读的套餐视图（本地 entitlement + 是否有可用 access_token）。 */
export function planView(owner, env = process.env) {
  const ent = readEntitlement(env, owner)   // 按租户读（多租户每人一份 entitlement）
  return {
    owner: owner || null,
    plan: ent ? ent.plan : 'free',
    status: ent ? ent.status : 'inactive',
    expiresAt: ent ? ent.expiresAt || null : null,
    caps: ent ? ent.caps || null : null,
    version: ent ? ent.version ?? null : null,
    fetchedAt: ent ? ent.fetchedAt || null : null,
    source: ent ? ent.source || null : null,
    // 支付改成直跳 subscribe 深链之后，**下单不再需要 access_token / refresh_token** ——
    // 只要登录了（有 owner）就能拿到支付页地址，剩下的登录与支付都在 MengBot 页面上完成。
    canCheckout: !!owner,
    // 兼容老客户端：字段保留，含义已变（不再是"有没有可用的 access_token"）
    canCheckoutReason: owner ? 'subscribe-deeplink' : 'need-login',
    plans: CHECKOUT_PLANS,
  }
}
