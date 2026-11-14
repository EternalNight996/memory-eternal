// 订阅全量核对：每日把所有已知租户的套餐与 MengBot 对一遍，**只记差异、不自动改**。
//
// 为什么需要：
//   · webhook 是推送 —— 对方重试只有 1s/5s/30s 三次（36 秒），我们一重启就永久丢事件；
//   · 按需对账（/cloud/billing/plan 顺带查）只在**有人访问**时才发生 ——
//     如果那个用户一个月不登录，他的套餐状态就错一个月；
//   · 中间没有任何"兜底扫一遍"的机制。
//
// ⚠️ **只记录差异，绝不自动覆盖**。
//   批量 force 对账一旦 owner 映射出错（见 cloud-auth 的 tenantVault 碰撞问题），
//   会一次性把一批付费用户降级 —— 那是灾难性的。所以这里只产出"待人工确认"的清单。
//
// 差异类型：
//   missing_local  → 远端付费有效，本地还是 free（漏推送，最常见）
//   missing_remote → 本地付费有效，远端已 free（过期/退款/取消没收到）
//   caps_drift     → 两边都付费但 caps 不同（配额漂移）
//   plan_drift     → 两边都付费但套餐等级不同（升降级漏推送）

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fetchSubscription, syncReady } from './subscription-sync.js'
import { readEntitlement } from './entitlement.js'
import { cloudRoot, keyStorePath } from './cloud-auth.js'

/** 核对结果文件。 */
export function auditPath(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'cloud-subscription-audit.json')
}

/** 每日核算的默认配置。 */
export const AUDIT_DEFAULTS = {
  enabled: true,
  intervalHours: 24,
  // 限速：mbt_ 的额度是 300 次/分钟（单 token + 单 IP），取 5/s = 300/min 的一半，留足裕度
  ratePerSec: 5,
  // 单轮最多核多少个租户（防止租户暴涨时把额度吃光）
  maxTenants: 500,
}

function posNum(v, d) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : d
}

/**
 * 枚举"值得核对"的租户。
 *
 * 来源三处合并（都是**原始 owner**，不是有损转义的目录名）：
 *   ① cloud-keys.json 的 keys[].owner          —— 签发过访问密钥的人
 *   ② cloud-keys.json 的 mengbot.sessions[].owner —— 登录过的人
 *   ③ cloud-entitlement-<encoded>.json 的文件名反解 —— 有过套餐记录的人
 *
 * 为什么不扫 cloud-vaults/ 目录：目录名是有损转义（`@`→`_`、小写、截断），
 * **无法反推原 owner**，拿它去查 subscription 会查错人。
 */
export function listKnownOwners(env = process.env) {
  const set = new Set()

  // ① 密钥表 + 会话表
  try {
    const store = JSON.parse(fs.readFileSync(keyStorePath(env), 'utf8'))
    for (const k of store.keys || []) {
      if (k && k.owner && !k.revoked) set.add(String(k.owner))
    }
    const mb = store.mengbot || {}
    for (const s of mb.sessions || []) {
      if (s && s.owner) set.add(String(s.owner))
    }
  } catch { /* 没有就是空的 */ }

  // ③ entitlement 文件名反解
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  try {
    for (const f of fs.readdirSync(home)) {
      const m = /^cloud-entitlement-(.+)\.json$/.exec(f)
      if (!m) continue
      try { set.add(decodeURIComponent(m[1])) } catch { /* 坏文件名跳过 */ }
    }
  } catch { /* 目录不存在 */ }

  return Array.from(set).sort()
}

/** 只核"付费相关"的租户：远端 free 且本地也 free 的没意义，跳过省额度。 */
function isPaidLike(ent) {
  if (!ent) return false
  const plan = String(ent.plan || '').toLowerCase()
  if (!plan || plan === 'free') return false
  return true
}

/** 比较本地与远端，返回差异对象或 null。 */
function diffOne(owner, local, remote) {
  const localPaid = isPaidLike(local)
  const remotePaid = isPaidLike(remote)
  const lp = String((local && local.plan) || 'free').toLowerCase()
  const rp = String((remote && remote.plan) || 'free').toLowerCase()

  if (remotePaid && !localPaid) {
    return { type: 'missing_local', detail: `远端 ${rp} 有效，本地还是 ${lp}（漏推送）` }
  }
  if (localPaid && !remotePaid) {
    return { type: 'missing_remote', detail: `本地 ${lp} 有效，远端已 ${rp}（过期/退款/取消未收到）` }
  }
  if (lp !== rp) {
    return { type: 'plan_drift', detail: `本地 ${lp} vs 远端 ${rp}` }
  }
  // caps 漂移（只比我们真正执行的那三项）
  const keys = ['cards', 'rpm', 'vaults']
  const lc = (local && local.caps) || {}
  const rc = (remote && remote.caps) || {}
  const diffKeys = keys.filter((k) => (lc[k] ?? null) !== (rc[k] ?? null))
  if (diffKeys.length) {
    return {
      type: 'caps_drift',
      detail: diffKeys.map((k) => `${k}: 本地 ${lc[k] ?? '无'} vs 远端 ${rc[k] ?? '无'}`).join('；'),
    }
  }
  return null
}

/**
 * 跑一轮全量核对。
 *
 * @param {{env?:object, fetchImpl?:Function, ratePerSec?:number, maxTenants?:number, now?:number}} opts
 * @returns {Promise<{ok:boolean, at:string, scanned:number, checked:number, unreachable:number, diffs:Array, skipped:number}>}
 */
export async function runAudit({ env = process.env, fetchImpl = fetch, ratePerSec, maxTenants, now = Date.now() } = {}) {
  if (!syncReady(env)) {
    return { ok: false, at: new Date(now).toISOString(), scanned: 0, checked: 0, unreachable: 0, diffs: [], skipped: 0, error: '未配置 mbt_ 令牌，核对未启用' }
  }
  const rate = posNum(ratePerSec ?? env.MEMORY_AUDIT_RATE_PER_SEC, AUDIT_DEFAULTS.ratePerSec)
  const cap = posNum(maxTenants ?? env.MEMORY_AUDIT_MAX_TENANTS, AUDIT_DEFAULTS.maxTenants)
  const gapMs = Math.max(0, Math.floor(1000 / rate))

  const owners = listKnownOwners(env)
  const queue = owners.slice(0, cap)
  const diffs = []
  let checked = 0
  let unreachable = 0

  for (const owner of queue) {
    const local = readEntitlement(env, owner)
    // 本地和远端都可能是 free —— 没记录的就是 free，也要查（可能远端有订阅但我们完全没收到过）
    const got = await fetchSubscription(owner, { env, fetchImpl })
    if (!got.ok) {
      unreachable++
    } else {
      checked++
      const d = diffOne(owner, local, got.entitlement)
      if (d) diffs.push({ owner, ...d, localPlan: (local && local.plan) || 'free', remotePlan: got.entitlement.plan })
    }
    if (gapMs) await new Promise((r) => setTimeout(r, gapMs))
  }

  const result = {
    ok: true,
    at: new Date(now).toISOString(),
    scanned: owners.length,
    checked,
    unreachable,
    skipped: Math.max(0, owners.length - queue.length),
    diffs,
    ratePerSec: rate,
  }
  try {
    fs.mkdirSync(path.dirname(auditPath(env)), { recursive: true })
    fs.writeFileSync(auditPath(env), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  } catch { /* 写不下不影响返回 */ }
  if (diffs.length) {
    try {
      console.error(`[subscription-audit] 发现 ${diffs.length} 处差异（共核 ${checked} 个租户）：` +
        diffs.slice(0, 5).map((d) => `${d.owner}=${d.type}`).join(', ') +
        (diffs.length > 5 ? ' …' : ''))
    } catch { /* 忽略 */ }
  }
  return result
}

/** 读最近一次核对结果。 */
export function readAudit(env = process.env) {
  try {
    return JSON.parse(fs.readFileSync(auditPath(env), 'utf8'))
  } catch {
    return null
  }
}

/** 是否到了该扫的时间（按 intervalHours）。 */
export function auditDue(env = process.env, now = Date.now()) {
  const last = readAudit(env)
  if (!last || !last.at) return true
  const t = Date.parse(last.at)
  if (!Number.isFinite(t)) return true
  const hours = posNum(env.MEMORY_AUDIT_INTERVAL_HOURS, AUDIT_DEFAULTS.intervalHours)
  return now - t >= hours * 3600000
}
