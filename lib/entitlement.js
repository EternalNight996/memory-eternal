// 权限来源编排：**MengBot entitlement（主）→ 本地 license（离线兜底）→ 降级策略**。
//
// 为什么两层而不是一层：
//   · MengBot 是账号+支付的权威源（plan/status/expiresAt/version/caps），在线时以它为准；
//   · 但 MengBot 控制面可能不可达（未上线 / 内网隔离 / 私有部署），此时不能把客户一起拖死 ——
//     本地离线签名 license 兜住，客户照常可用；
//   · 两者都失效才降级（warn/readonly/stop，见 lib/license.js）。
//
// **缓存按租户分文件**（这是本轮修的架构缺陷）：
//   · 无 owner（本地/单租户模式）→ $DSH_HOME/cloud-entitlement.json（与旧版兼容）
//   · 有 owner（云端多租户）    → $DSH_HOME/cloud-entitlement-<encoded-owner>.json
// 改之前是全局单文件，多租户下**所有租户共享同一份套餐状态** —— A 用户的对账会把
// B 用户的套餐冲掉。单租户时看不出问题，一旦有第二个付费用户就必然串号。
//
// 字段：{ owner, plan, status, expiresAt, version, revision, caps, fetchedAt, source }
// version 单调递增：服务端返回更旧的 version 时**不回退**（防止回滚攻击/缓存错乱）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { licenseState } from './license.js'

export const ENTITLEMENT_FILE = 'cloud-entitlement.json'

/**
 * 把 owner 转成安全的文件名片段。
 *
 * 为什么不用原始值：owner 是邮箱（`a@b.com`），`@` 在多数文件系统里合法但不通用，
 * 而且用户可注册任意字符串（含 `/`、`\`、`..`）—— 直接拼路径会穿越目录。
 * `encodeURIComponent` 把这些都转义掉，且仍然**可逆、肉眼可读**（`a%40b.com`）。
 */
function ownerSlug(owner) {
  const s = String(owner || '').trim()
  if (!s) return ''
  // 截断防超长文件名（encodeURIComponent 可能把中文撑到 9 倍长度）
  return encodeURIComponent(s).slice(0, 120)
}

/**
 * entitlement 缓存文件路径。
 * @param {object} env
 * @param {string} [owner] 有 owner → 按租户分文件；无 owner → 旧版全局文件（兼容本地模式）
 */
export function entitlementPath(env = process.env, owner = '') {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const slug = ownerSlug(owner)
  if (!slug) return path.join(home, ENTITLEMENT_FILE)
  return path.join(home, 'cloud-entitlement-' + slug + '.json')
}

/**
 * 判断是不是「付费且有效」。
 *
 * 旧实现写的是 `plan === 'pro'` —— 但 MengBot 第 3 封 B2 定稿的套餐是
 * **personal / pro / max**，那样写会把 personal 和 max 都当成未付费。
 * 这里改成「非 free 且 active 且未过期」，并把已知付费套餐列出来做正向判定。
 */
const PAID_PLANS = new Set(['personal', 'pro', 'max', 'team', 'enterprise'])
const isPaid = (e) => {
  if (!e) return false
  const plan = String(e.plan || '').toLowerCase()
  const status = String(e.status || '').toLowerCase()
  if (!plan || plan === 'free') return false
  if (status && status !== 'active') return false
  // 已知付费套餐直接算；未知但非 free 的（MengBot 以后加新套餐）也认 —— 宁放行不误拒
  return true
}
const notExpired = (e, now) => !e.expiresAt || Date.parse(e.expiresAt) > now

/**
 * 读缓存（坏文件当没有，不让它拖垮启动）。
 * @param {object} env
 * @param {string} [owner] 租户；省略则读旧版全局文件
 */
export function readEntitlement(env = process.env, owner = '') {
  try {
    const raw = JSON.parse(fs.readFileSync(entitlementPath(env, owner), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return raw
  } catch {
    return null
  }
}

/**
 * 写入 entitlement（MengBot 返回后调用）。
 * **version 回退保护**：新 version 不大于缓存时不覆盖，只在字段更完整时合并。
 *
 * @param {object} next { owner?, plan, status, expiresAt?, version?, revision?, caps?, fetchedAt?, source? }
 * @param {object} env
 * @param {string} [ownerIn] 租户（不传则用 next.owner）
 */
export function writeEntitlement(next, env = process.env, ownerIn = '') {
  if (!next || typeof next !== 'object') return { ok: false, error: '空 entitlement' }
  const owner = String(ownerIn || next.owner || '').trim()
  const prev = readEntitlement(env, owner)
  const prevVer = Number(prev && prev.version)
  const nextVer = Number(next.version)
  if (Number.isFinite(prevVer) && Number.isFinite(nextVer) && nextVer < prevVer) {
    return { ok: false, error: `version 回退（缓存 ${prevVer} > 收到 ${nextVer}），已忽略` }
  }
  const merged = {
    ...(owner ? { owner } : (prev && prev.owner ? { owner: String(prev.owner) } : {})),
    plan: next.plan ?? (prev && prev.plan) ?? 'free',
    status: next.status ?? (prev && prev.status) ?? 'inactive',
    expiresAt: next.expiresAt ?? null,
    version: Number.isFinite(nextVer) ? nextVer : (prevVer || 0),
    revision: next.revision ?? (prev && prev.revision) ?? null,
    caps: next.caps ?? (prev && prev.caps) ?? null,
    // fetchedAt：默认取当前时间；但**允许调用方指定** —— 对账/测试需要按"这条数据有多新"判断，
    // 强制覆盖成 now 会让 isFresh() 永远为真，对账就永远被跳过。
    fetchedAt: next.fetchedAt || new Date().toISOString(),
    source: next.source || 'mengbot',
  }
  try {
    const file = entitlementPath(env, owner)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
    return { ok: true, entitlement: merged }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 综合判定权限。
 *
 * @param {object} env
 * @param {{now?:number, owner?:string}} [opts] owner 省略时按本地/单租户模式（读旧版全局文件）
 * @returns {{
 *   source:'mengbot'|'license'|'none', owner:string|null,
 *   plan:string, status:string, expiresAt:string|null, daysLeft:number|null,
 *   canWrite:boolean, degrade:string, caps:object|null,
 *   entitlement:object|null, license:object
 * }}
 */
export function resolveAccess(env = process.env, { now = Date.now(), owner = '' } = {}) {
  const lic = licenseState(env)
  const ent = readEntitlement(env, owner)
  const who = String(owner || '').trim() || null

  // ① MengBot entitlement 优先（付费且有效 —— personal/pro/max 都算）
  if (isPaid(ent) && notExpired(ent, now)) {
    const daysLeft = ent.expiresAt ? Math.floor((Date.parse(ent.expiresAt) - now) / 86400000) : null
    return {
      source: 'mengbot', owner: who, plan: ent.plan, status: ent.status,
      expiresAt: ent.expiresAt || null, daysLeft, caps: ent.caps || null,
      canWrite: true, degrade: lic.degrade, entitlement: ent, license: lic,
    }
  }

  // ② 本地 license 兜底
  if (lic.ok) {
    return {
      source: 'license', owner: who, plan: (lic.payload && lic.payload.plan) || 'pro', status: 'active',
      expiresAt: lic.expiresAt || null, daysLeft: lic.daysLeft ?? null,
      caps: { seats: (lic.payload && lic.payload.seats) || null },
      canWrite: true, degrade: lic.degrade, entitlement: ent, license: lic,
    }
  }

  // ③ 都失效 → 按策略降级
  return {
    source: 'none', owner: who, plan: (ent && ent.plan) || 'free', status: (ent && ent.status) || 'inactive',
    expiresAt: (ent && ent.expiresAt) || null, daysLeft: null, caps: (ent && ent.caps) || null,
    canWrite: lic.degrade === 'warn', degrade: lic.degrade, entitlement: ent, license: lic,
  }
}

/** 给客户端的摘要（不含 license 原文、不含 MengBot token）。 */
export function accessSummary(access) {
  return {
    source: access.source,
    owner: access.owner || null,
    plan: access.plan,
    status: access.status,
    expiresAt: access.expiresAt,
    daysLeft: access.daysLeft,
    canWrite: access.canWrite,
    degrade: access.degrade,
    caps: access.caps,
    entitlementVersion: access.entitlement && access.entitlement.version || null,
    entitlementAt: access.entitlement && access.entitlement.fetchedAt || null,
  }
}
