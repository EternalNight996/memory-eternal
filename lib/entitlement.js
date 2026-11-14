// 权限来源编排：**MengBot entitlement（主）→ 本地 license（离线兜底）→ 降级策略**。
//
// 为什么两层而不是一层：
//   · MengBot 是账号+支付的权威源（plan/status/expiresAt/version/caps），在线时以它为准；
//   · 但 MengBot 控制面可能不可达（未上线 / 内网隔离 / 私有部署），此时不能把客户一起拖死 ——
//     本地离线签名 license 兜住，客户照常可用；
//   · 两者都失效才降级（warn/readonly/stop，见 lib/license.js）。
//
// 缓存：$DSH_HOME/cloud-entitlement.json（与 MengBot 客户端同名字段，便于对照）
//   { plan, status, expiresAt, version, caps, fetchedAt, source }
// version 单调递增：服务端返回更旧的 version 时**不回退**（防止回滚攻击/缓存错乱）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { licenseState } from './license.js'

export const ENTITLEMENT_FILE = 'cloud-entitlement.json'

export function entitlementPath(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, ENTITLEMENT_FILE)
}

const isPro = (e) => !!e && e.plan === 'pro' && e.status === 'active'
const notExpired = (e, now) => !e.expiresAt || Date.parse(e.expiresAt) > now

/** 读缓存（坏文件当没有，不让它拖垮启动）。 */
export function readEntitlement(env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(entitlementPath(env), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    return raw
  } catch {
    return null
  }
}

/**
 * 写入 entitlement（MengBot 返回后调用）。
 * **version 回退保护**：新 version 不大于缓存时不覆盖，只在字段更完整时合并。
 */
export function writeEntitlement(next, env = process.env) {
  if (!next || typeof next !== 'object') return { ok: false, error: '空 entitlement' }
  const prev = readEntitlement(env)
  const prevVer = Number(prev && prev.version)
  const nextVer = Number(next.version)
  if (Number.isFinite(prevVer) && Number.isFinite(nextVer) && nextVer < prevVer) {
    return { ok: false, error: `version 回退（缓存 ${prevVer} > 收到 ${nextVer}），已忽略` }
  }
  const merged = {
    // owner：多租户下用来防串号（agents 对账时写入，见 lib/subscription-sync.js）。
    // 老文件没有这个字段，保持原样不硬塞 —— 免得把"未知归属"当成"属于某人"。
    ...(next.owner ? { owner: String(next.owner) } : (prev && prev.owner ? { owner: String(prev.owner) } : {})),
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
    const file = entitlementPath(env)
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
 * 综合判定当前服务端权限。
 * @returns {{
 *   source:'mengbot'|'license'|'none',
 *   plan:string, status:string, expiresAt:string|null, daysLeft:number|null,
 *   canWrite:boolean, degrade:string, caps:object|null,
 *   entitlement:object|null, license:object
 * }}
 */
export function resolveAccess(env = process.env, { now = Date.now() } = {}) {
  const lic = licenseState(env)
  const ent = readEntitlement(env)

  // ① MengBot entitlement 优先
  if (isPro(ent) && notExpired(ent, now)) {
    const daysLeft = ent.expiresAt ? Math.floor((Date.parse(ent.expiresAt) - now) / 86400000) : null
    return {
      source: 'mengbot', plan: ent.plan, status: ent.status,
      expiresAt: ent.expiresAt || null, daysLeft, caps: ent.caps || null,
      canWrite: true, degrade: lic.degrade, entitlement: ent, license: lic,
    }
  }

  // ② 本地 license 兜底
  if (lic.ok) {
    return {
      source: 'license', plan: (lic.payload && lic.payload.plan) || 'pro', status: 'active',
      expiresAt: lic.expiresAt || null, daysLeft: lic.daysLeft ?? null,
      caps: { seats: (lic.payload && lic.payload.seats) || null },
      canWrite: true, degrade: lic.degrade, entitlement: ent, license: lic,
    }
  }

  // ③ 都失效 → 按策略降级
  return {
    source: 'none', plan: (ent && ent.plan) || 'free', status: (ent && ent.status) || 'inactive',
    expiresAt: (ent && ent.expiresAt) || null, daysLeft: null, caps: (ent && ent.caps) || null,
    canWrite: lic.degrade === 'warn', degrade: lic.degrade, entitlement: ent, license: lic,
  }
}

/** 给客户端的摘要（不含 license 原文、不含 MengBot token）。 */
export function accessSummary(access) {
  return {
    source: access.source,
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
