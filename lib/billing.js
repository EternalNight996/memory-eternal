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
// 鉴权：代用户调 MengBot 用 OIDC access_token（见 lib/oidc.js 的 getValidAccessToken）。

import { readOidcConfig, oidcReady, discoverOidc, getValidAccessToken, readAccessStore } from './oidc.js'
import { readEntitlement } from './entitlement.js'

/** MengBot 的云端 API 根（`/api/cloud/desktop/*` 挂在它下面）。 */
export function mengbotApiBase(env = process.env) {
  return String(
    env.MEMORY_MENGBOT_API_BASE
    || env.MEMORY_MENGBOT_BASE_URL
    || env.MEMORY_OIDC_ISSUER
    || '',
  ).trim().replace(/\/+$/, '')
}

export const CHECKOUT_PLANS = ['pro', 'team', 'enterprise']

/**
 * 发起支付：`POST {API_BASE}/api/cloud/desktop/checkout { plan, source }`
 * @returns {{ok:boolean, url?:string, raw?:object, error?:string}}
 */
export async function createCheckout({ plan = 'pro', source = 'memory-eternal-cloud', owner, env = process.env, fetchImpl = fetch } = {}) {
  const p = String(plan || '').trim().toLowerCase()
  if (!CHECKOUT_PLANS.includes(p)) {
    return { ok: false, error: `不支持的套餐：${plan}（可选 ${CHECKOUT_PLANS.join(' / ')}）` }
  }
  if (!owner) return { ok: false, error: '缺少 owner（必须先登录）' }

  const base = mengbotApiBase(env)
  if (!base) return { ok: false, error: '未配置 MengBot API 根（MEMORY_MENGBOT_API_BASE / MEMORY_OIDC_ISSUER）' }

  // 代用户调用需要 access_token：缓存失效时自动 refresh
  const cfg = readOidcConfig(env)
  if (!oidcReady(cfg)) return { ok: false, error: 'OIDC 未配置，无法代用户调用 MengBot' }
  const disc = await discoverOidc(cfg, { fetchImpl })
  if (!disc.ok) return { ok: false, error: 'OIDC discovery 失败：' + disc.error }
  const tk = await getValidAccessToken(cfg, disc.endpoints, owner, { env, fetchImpl })
  if (!tk.ok) return { ok: false, error: '取 access_token 失败：' + (tk.error || '需重新登录') }

  try {
    const r = await fetchImpl(base + '/api/cloud/desktop/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk.accessToken },
      body: JSON.stringify({ plan: p, source }),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) {
      const reason = d.error || d.message || `HTTP ${r.status}`
      return { ok: false, error: 'MengBot 下单失败：' + reason, raw: d }
    }
    // 兼容不同字段名（url / checkoutUrl / checkout_url）
    const url = d.url || d.checkoutUrl || d.checkout_url || (d.checkout && d.checkout.url) || ''
    if (!url) return { ok: false, error: 'MengBot 未返回支付页地址', raw: d }
    return { ok: true, url, plan: p, raw: d }
  } catch (e) {
    return { ok: false, error: '连接 MengBot 失败：' + String((e && e.message) || e) }
  }
}

/** 只读的套餐视图（本地 entitlement + 是否有可用 access_token）。 */
export function planView(owner, env = process.env) {
  const ent = readEntitlement(env)
  const access = owner ? readAccessStore(env)[owner] : null
  return {
    owner: owner || null,
    plan: ent ? ent.plan : 'free',
    status: ent ? ent.status : 'inactive',
    expiresAt: ent ? ent.expiresAt || null : null,
    caps: ent ? ent.caps || null : null,
    version: ent ? ent.version ?? null : null,
    fetchedAt: ent ? ent.fetchedAt || null : null,
    canCheckout: !!(owner && access && access.expiresAt && Date.parse(access.expiresAt) > Date.now()),
    plans: CHECKOUT_PLANS,
  }
}
