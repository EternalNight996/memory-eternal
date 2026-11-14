// 套餐主动对账：用 `mbt_` 拉 MengBot 的 subscription，补齐 webhook 可能漏掉的状态。
//
// 为什么需要：套餐状态原本 100% 依赖 webhook 推送。MengBot 的重试是
// 1s / 5s / 30s 三次（共 36 秒）—— 如果这 36 秒内我们服务在重启（发版就会重启），
// 事件永久丢失，用户状态会错到下一次事件，而那可能是下个月续费。
//
// ⚠️ **最危险的误操作是把付费用户降级**。
// 这里的策略刻意保守：
//   · 默认**只补空缺、只升级**，不降级
//     - 本地 free + 远端 pro  → 升级（安全）
//     - 本地 active + 远端没数据/未付费 → **不动**（可能是 webhook 刚推的，
//       而 subscription 侧还没落库；错降级比晚同步严重得多）
//   · 只有显式 `force: true` 才按远端覆盖（人工刷新/排查时用）
//
// 数据来源：`GET /api/v1/accounts/{email}/subscription`
// 鉴权：`MEMORY_MENGBOT_API_TOKEN`（scope=client 的 `mbt_`）
// 限流：单 token + 单 IP 300 次/分钟。我们单机部署，全租户共享 —— 所以
// 默认 10 分钟才对一次，且失败不重试（避免把额度耗在坏路径上）。

import { readEntitlement, writeEntitlement } from './entitlement.js'

/** 远端鉴权与地址。 */
function apiBase(env) {
  return String((env && (env.MEMORY_MENGBOT_API_BASE || env.MEMORY_OIDC_ISSUER)) || '').trim().replace(/\/+$/, '')
}
function apiToken(env) {
  return String((env && env.MEMORY_MENGBOT_API_TOKEN) || '').trim()
}

/** 对账是否可用（没配 token 就完全不启用，静默跳过）。 */
export function syncReady(env = process.env) {
  return !!(apiBase(env) && apiToken(env))
}

/** 默认多久对一次（分钟）。 */
export const DEFAULT_STALE_MINUTES = 10

/** 本地 entitlement 是否已经"够新"，不需要对账。 */
export function isFresh(ent, staleMinutes = DEFAULT_STALE_MINUTES, now = Date.now()) {
  // staleMinutes <= 0 表示"永不算新"（对账测试 / force 场景要用）
  if (!(Number(staleMinutes) > 0)) return false
  if (!ent || !ent.fetchedAt) return false
  const t = Date.parse(String(ent.fetchedAt))
  if (!Number.isFinite(t)) return false
  return now - t < Number(staleMinutes) * 60000
}

/**
 * 拉远端 subscription（纯读取，不改任何本地状态）。
 * @returns {{ok:boolean, entitlement?:object, subscription?:object, error?:string, skipped?:boolean}}
 */
export async function fetchSubscription(owner, { env = process.env, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const email = String(owner || '').trim()
  if (!email) return { ok: false, error: '缺少 owner（邮箱）' }
  if (!syncReady(env)) return { ok: false, skipped: true, error: '未配置 mbt_ 令牌，对账未启用' }
  const base = apiBase(env)
  const url = base + '/api/v1/accounts/' + encodeURIComponent(email) + '/subscription'
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(() => { try { ctrl && ctrl.abort() } catch { /* 忽略 */ } }, timeoutMs)
  try {
    const r = await fetchImpl(url, {
      headers: { Authorization: 'Bearer ' + apiToken(env) },
      signal: ctrl ? ctrl.signal : undefined,
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, error: `对账请求失败 HTTP ${r.status}：` + String(d.error || d.message || '').slice(0, 80) }
    const ent = d && d.entitlement
    if (!ent || typeof ent !== 'object') return { ok: false, error: '远端未返回 entitlement' }
    return { ok: true, entitlement: ent, subscription: d.subscription || null, raw: d }
  } catch (e) {
    return { ok: false, error: '对账连接失败：' + String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
  }
}

/** 判断远端算不算"付费且有效"。 */
function isPaidActive(ent) {
  if (!ent) return false
  const plan = String(ent.plan || '').toLowerCase()
  const status = String(ent.status || '').toLowerCase()
  if (plan === 'free' || !plan) return false
  if (status && status !== 'active') return false
  // 有过期时间且已过期 → 不算有效
  if (ent.expiresAt) {
    const t = Date.parse(String(ent.expiresAt))
    if (Number.isFinite(t) && t < Date.now()) return false
  }
  return true
}

/**
 * 对账并（按保守策略）回写本地 entitlement。
 *
 * 租户隔离：`lib/entitlement.js` 现在**按 owner 分文件**（`cloud-entitlement-<owner>.json`），
 * 所以读写天然隔离。下面那段「文件里 owner 不匹配就跳过」是**双保险** ——
 * 防止老版本留下的全局 `cloud-entitlement.json` 被误当成某个租户的数据。
 *
 * @param {string} owner 邮箱
 * @param {{env?:object, fetchImpl?:Function, force?:boolean, staleMinutes?:number}} opts
 * @returns {{ok:boolean, changed:boolean, reason:string, remote?:object}}
 */
export async function syncEntitlement(owner, { env = process.env, fetchImpl = fetch, force = false, staleMinutes = DEFAULT_STALE_MINUTES } = {}) {
  const local = readEntitlement(env, owner)
  const localOwner = local && local.owner ? String(local.owner) : ''
  // 防串号：文件里记的是别人 → 不去动它（多租户共享 entitlement 是已知缺陷，见上）
  if (localOwner && localOwner !== String(owner)) {
    return {
      ok: true,
      changed: false,
      reason: `entitlement 属于 ${localOwner}，与本次对账对象 ${owner} 不同 —— 跳过（多租户共享 entitlement 的已知缺陷）`,
    }
  }
  // 非强制模式下，本地够新就不打扰远端（省限流额度）
  if (!force && isFresh(local, staleMinutes)) {
    return { ok: true, changed: false, reason: '本地数据够新，跳过对账' }
  }

  const got = await fetchSubscription(owner, { env, fetchImpl })
  if (!got.ok) {
    // **对账失败绝不报错给用户**，当没对过
    return { ok: false, changed: false, reason: got.skipped ? '对账未启用' : String(got.error || '对账失败') }
  }
  const remote = got.entitlement
  const remotePaid = isPaidActive(remote)
  const localPaid = isPaidActive(local)

  if (!force) {
    // ① 本地付费 + 远端未付费 → **不降级**（宁可不改，也不误伤付费用户）
    if (localPaid && !remotePaid) {
      return { ok: true, changed: false, reason: '本地为付费有效，远端未付费 —— 保持本地（避免误降级）', remote }
    }
    // ② 都付费且套餐相同 → 无需改动
    if (localPaid && remotePaid && String(local.plan).toLowerCase() === String(remote.plan).toLowerCase()) {
      return { ok: true, changed: false, reason: '一致，无需改动', remote }
    }
    // ③ 本地没有/未付费 + 远端付费 → 升级（安全）
  }

  // 写入：以远端为准（远端是权威源）
  const next = {
    owner: String(owner),   // 防串号：见函数头注释
    plan: String(remote.plan || 'free').toLowerCase(),
    status: String(remote.status || 'inactive'),
    expiresAt: remote.expiresAt || null,
    version: remote.version,
    revision: remote.revision,
    caps: remote.caps || null,
    fetchedAt: new Date().toISOString(),
    source: force ? 'mengbot-sync-forced' : 'mengbot-sync',
  }
  const changed = !local
    || String(local.plan || '').toLowerCase() !== next.plan
    || String(local.status || '') !== next.status
    || String(local.expiresAt || '') !== String(next.expiresAt || '')
    || String(local.version ?? '') !== String(next.version ?? '')
  writeEntitlement(next, env, owner)
  return { ok: true, changed, reason: force ? '强制按远端覆盖' : '按远端补齐/升级', remote }
}
