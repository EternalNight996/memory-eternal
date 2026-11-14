// 商户接入：把「个人订阅」与「商户接入」彻底分开。
//
// 两种完全不同的场景：
//   ① **客户端订阅**（个人）：用户在 memory-eternal 云端订阅 personal/pro/max，
//      自己用；凭据是 `me_` 访问密钥或 `mb_` 会话令牌。
//   ② **商户接入**：商户有自己的云端实例，想接入 MengBot 托管（账号体系 + 计费 + 权益下发）。
//      需要：注册商户 → 订阅**商户套餐** → 拿到商户凭据（`mch_` / `msk_`）。
//
// 为什么必须分开而不是复用同一套凭据：
//   · 个人密钥按「人」计量，商户密钥按「组织」计量（一个商户可能对应多个终端用户）；
//   · 商户密钥会嵌进商户自己的服务端，泄漏面比个人密钥大得多 —— 要能单独吊销；
//   · 计费主体不同（个人套餐 vs 商户套餐），合在一起会导致权益判定混乱。
//
// 商户凭据（`msk_`）与访问密钥一样**只存 hash**，明文只在注册时返回一次。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const MERCHANT_ID_PREFIX = 'mch_'
export const MERCHANT_KEY_PREFIX = 'msk_'

/** 商户台账文件。 */
export function merchantStorePath(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'cloud-merchants.json')
}

function readStore(env) {
  try {
    const raw = JSON.parse(fs.readFileSync(merchantStorePath(env), 'utf8'))
    if (!raw || typeof raw !== 'object') return { version: 1, merchants: [] }
    return { version: 1, merchants: Array.isArray(raw.merchants) ? raw.merchants : [] }
  } catch {
    return { version: 1, merchants: [] }
  }
}

function writeStore(store, env) {
  const f = merchantStorePath(env)
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = f + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, f)
}

export function hashCode(v) {
  return crypto.createHash('sha256').update(String(v || ''), 'utf8').digest('hex')
}

/** 商户域名/名称的清洗（只用于展示与去重，不做路径）。 */
function normalizeDomain(raw) {
  return String(raw || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .slice(0, 190)
}

/**
 * 注册一个商户。
 *
 * @param {{name:string, domain?:string, owner:string, env?:object}} opts
 *   `owner` 是注册人的账号（必须已登录）——商户归属于某个真实用户，避免匿名注册。
 * @returns {{ok:boolean, merchant?:object, secret?:string, error?:string}}
 *   ⚠️ `secret` **只在这里返回一次**，之后无法再取回。
 */
export function registerMerchant({ name, domain = '', owner, env = process.env } = {}) {
  const nm = String(name || '').trim().slice(0, 80)
  const who = String(owner || '').trim()
  const dom = normalizeDomain(domain)
  if (!nm) return { ok: false, error: '缺少商户名称' }
  if (!who) return { ok: false, error: '缺少注册人（必须先登录）' }

  const store = readStore(env)
  // 同一注册人名下：名称不可重复（不同注册人可以用同名商户，域名才要求全局唯一）
  if (store.merchants.some((m) => m.owner === who && m.name === nm && m.status !== 'revoked')) {
    return { ok: false, error: `你名下已有同名商户「${nm}」` }
  }
  // 域名全局唯一（一个域名只能接入一次，否则权益会串）
  if (dom && store.merchants.some((m) => m.domain && m.domain === dom && m.status !== 'revoked')) {
    return { ok: false, error: `域名 ${dom} 已被其他商户接入` }
  }

  const id = MERCHANT_ID_PREFIX + crypto.randomBytes(9).toString('base64url').slice(0, 12)
  const secret = MERCHANT_KEY_PREFIX + crypto.randomBytes(24).toString('base64url')
  const now = new Date().toISOString()
  const merchant = {
    id,
    name: nm,
    domain: dom || null,
    owner: who,
    secretHash: hashCode(secret),
    // 商户套餐由 MengBot 下发（`entitlement` webhook），这里只记本地状态
    plan: 'merchant-pending',
    status: 'pending',          // pending → active（订阅生效后）
    createdAt: now,
    updatedAt: now,
  }
  store.merchants.push(merchant)
  try {
    writeStore(store, env)
  } catch (e) {
    return { ok: false, error: '写入商户台账失败：' + String((e && e.message) || e) }
  }
  return { ok: true, merchant: publicMerchant(merchant), secret }
}

/** 对外展示的商户信息（不含 secretHash）。 */
export function publicMerchant(m) {
  if (!m) return null
  return {
    id: m.id,
    name: m.name,
    domain: m.domain || null,
    owner: m.owner,
    plan: m.plan,
    status: m.status,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  }
}

/** 列出某个注册人名下的商户。 */
export function listMerchantsByOwner(owner, env = process.env) {
  const who = String(owner || '').trim()
  if (!who) return []
  return readStore(env).merchants.filter((m) => m.owner === who && m.status !== 'revoked').map(publicMerchant)
}

/** 按商户 ID 查（对外展示形态）。 */
export function getMerchant(id, env = process.env) {
  const hit = readStore(env).merchants.find((m) => m.id === String(id || '').trim())
  return hit ? publicMerchant(hit) : null
}

/**
 * 用商户 ID + 密钥校验身份（商户实例接入时用）。
 * @returns {{ok:boolean, merchant?:object, error?:string}}
 */
export function verifyMerchant(id, secret, env = process.env) {
  const mid = String(id || '').trim()
  const sec = String(secret || '').trim()
  if (!mid || !sec) return { ok: false, error: '缺少商户 ID 或商户密钥' }
  const hit = readStore(env).merchants.find((m) => m.id === mid)
  if (!hit) return { ok: false, error: '商户不存在' }
  if (hit.status === 'revoked') return { ok: false, error: '商户已被吊销' }
  if (hit.secretHash !== hashCode(sec)) return { ok: false, error: '商户密钥无效' }
  return { ok: true, merchant: publicMerchant(hit) }
}

/**
 * 吊销商户的密钥（重新生成）。商户实例换密钥时必须走这里 ——
 * 商户密钥会嵌进对方服务端，泄漏了要能立刻作废。
 */
export function rotateMerchantSecret(id, env = process.env) {
  const store = readStore(env)
  const hit = store.merchants.find((m) => m.id === String(id || '').trim())
  if (!hit) return { ok: false, error: '商户不存在' }
  const secret = MERCHANT_KEY_PREFIX + crypto.randomBytes(24).toString('base64url')
  hit.secretHash = hashCode(secret)
  hit.updatedAt = new Date().toISOString()
  try {
    writeStore(store, env)
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
  return { ok: true, merchant: publicMerchant(hit), secret }
}

/** 吊销商户（彻底不可用）。 */
export function revokeMerchant(id, env = process.env) {
  const store = readStore(env)
  const hit = store.merchants.find((m) => m.id === String(id || '').trim())
  if (!hit) return { ok: false, error: '商户不存在' }
  hit.status = 'revoked'
  hit.updatedAt = new Date().toISOString()
  try {
    writeStore(store, env)
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
  return { ok: true, merchant: publicMerchant(hit) }
}

/** 权益 webhook 落到商户时更新套餐状态把 pending 转 active。 */
export function applyMerchantEntitlement(id, { plan, status } = {}, env = process.env) {
  const store = readStore(env)
  const hit = store.merchants.find((m) => m.id === String(id || '').trim())
  if (!hit) return { ok: false, error: '商户不存在' }
  if (plan) hit.plan = String(plan)
  if (status) hit.status = String(status)
  hit.updatedAt = new Date().toISOString()
  try {
    writeStore(store, env)
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
  return { ok: true, merchant: publicMerchant(hit) }
}
