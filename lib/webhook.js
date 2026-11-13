// Webhook 接收（MengBot → memory-eternal-cloud）：HMAC-SHA256 签名校验 + 事件分发。
//
// 双方各存一份 secret（`MEMORY_WEBHOOK_SECRET`）。MengBot 侧配置推送地址：
//   POST <我们>/memory-eternal/api/cloud/webhook/mengbot
//   X-MengBot-Signature: sha256=<hex>      ← HMAC(secret, rawBody)
//   X-MengBot-Event: entitlement.updated   ← 或下面的其他事件
//
// 处理的事件（写 cloud-entitlement.json，见 lib/entitlement.js）：
//   entitlement.updated  套餐/有效期变更（支付成功、续费、升级）
//   subscription.canceled 取消订阅 → plan=free / status=inactive
//   subscription.expired  到期
//
// 幂等：事件带 `id`，重复投递只应用一次（记在台账里）。

import crypto from 'node:crypto'
import { readEntitlement, writeEntitlement } from './entitlement.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const SIG_HEADER = 'x-mengbot-signature'
const ID_HEADER = 'x-mengbot-event-id'
const EVENT_HEADER = 'x-mengbot-event'

export const WEBHOOK_EVENTS = ['entitlement.updated', 'subscription.canceled', 'subscription.expired']

/**
 * 「测试/握手」类事件：只回 200，不改任何状态。
 * 各家后台的「发送测试」按钮通常发 `ping` / `test` / `webhook.test` 这类事件，
 * 如果按未知事件回 400，对方会以为接收方没接好 —— 所以单独放行。
 */
export const PING_EVENTS = ['ping', 'test', 'webhook.test', 'webhook.ping', 'healthcheck', 'health_check', '']

/** 时间戳容差（防重放）：5 分钟。 */
const MAX_SKEW_MS = 5 * 60 * 1000

export function webhookSecret(env = process.env) {
  return String(env.MEMORY_WEBHOOK_SECRET || '').trim()
}

/** 计算签名（也用于测试与自查）。 */
export function signPayload(secret, rawBody, timestamp = '') {
  const data = timestamp ? timestamp + '.' + rawBody : rawBody
  return 'sha256=' + crypto.createHmac('sha256', secret).update(data, 'utf8').digest('hex')
}

/** 定长时间比较，避免时序侧信道。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/**
 * 校验签名。支持两种形态：
 *   · `X-MengBot-Signature: sha256=<hex>`（body 直接签）
 *   · `X-MengBot-Signature: t=<ts>,v1=<hex>`（Stripe 风格，带时间戳防重放）
 */
export function verifyWebhookSignature({ secret, rawBody, header, now = Date.now() }) {
  if (!secret) return { ok: false, error: '未配置 MEMORY_WEBHOOK_SECRET' }
  const h = String(header || '').trim()
  if (!h) return { ok: false, error: '缺少 ' + SIG_HEADER }

  // 形态 A：sha256=xxxx
  if (/^sha256=/i.test(h)) {
    const want = signPayload(secret, rawBody)
    return safeEqual(want, h.toLowerCase()) ? { ok: true } : { ok: false, error: '签名不匹配' }
  }

  // 形态 B：t=<ts>,v1=<hex>
  const parts = {}
  for (const kv of h.split(',')) {
    const i = kv.indexOf('=')
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim()
  }
  const ts = Number(parts.t)
  const v1 = parts.v1
  if (!Number.isFinite(ts) || !v1) return { ok: false, error: '签名头格式无法识别' }
  if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, error: '时间戳超出容差（可能重放）' }
  // v1 是纯 hex，不带 `sha256=` 前缀 —— 比较时去掉前缀（否则长度不等永远失败）
  const want = signPayload(secret, rawBody, String(ts)).replace(/^sha256=/i, '')
  return safeEqual(want, v1.toLowerCase()) ? { ok: true } : { ok: false, error: '签名不匹配' }
}

// ---- 幂等台账 -------------------------------------------------------------
function seenPath(env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'cloud-webhook-seen.json')
}

function readSeen(env) {
  try {
    const a = JSON.parse(fs.readFileSync(seenPath(env), 'utf8'))
    return Array.isArray(a) ? a : []
  } catch { return [] }
}

function markSeen(eventId, env) {
  if (!eventId) return
  const seen = readSeen(env)
  if (seen.includes(eventId)) return
  const next = [...seen.slice(-190), eventId] // 只留最近 200 个
  try {
    const f = seenPath(env)
    fs.mkdirSync(path.dirname(f), { recursive: true })
    fs.writeFileSync(f, JSON.stringify(next), { mode: 0o600 })
  } catch { /* 台账写失败不影响主流程 */ }
}

/**
 * 处理一个事件，返回 `{ok, applied, reason}`。
 * `payload` 形状（MengBot 侧可自定义，这里做宽容解析）：
 *   { account: "user@example.com", plan: "pro", status: "active", expiresAt, version, caps }
 */
export function applyWebhookEvent({ event, payload, eventId = '' }, env = process.env) {
  const ev = String(event || '').trim().toLowerCase()
  // 握手/测试事件：验签已通过，直接回 200，不动状态
  if (PING_EVENTS.includes(ev)) {
    return { ok: true, applied: false, pong: true, reason: `握手事件 ${ev || '(空)'} —— 接收方在线，签名有效` }
  }
  if (!WEBHOOK_EVENTS.includes(ev)) {
    return { ok: false, applied: false, reason: '未知事件类型：' + event }
  }
  if (eventId && readSeen(env).includes(eventId)) {
    return { ok: true, applied: false, reason: '重复投递（已应用过）' }
  }
  const p = payload && typeof payload === 'object' ? payload : {}
  const base = {
    plan: p.plan || (event === 'entitlement.updated' ? 'pro' : 'free'),
    status: p.status || (event === 'entitlement.updated' ? 'active' : 'inactive'),
    expiresAt: p.expiresAt || null,
    version: Number(p.version) || Date.now(),
    caps: p.caps || null,
  }
  if (event === 'subscription.canceled' || event === 'subscription.expired') {
    base.plan = 'free'
    base.status = 'inactive'
  }
  const w = writeEntitlement(base, env)
  if (!w.ok) return { ok: false, applied: false, reason: w.error }
  markSeen(eventId, env)
  return {
    ok: true, applied: true,
    reason: `${event} → plan=${base.plan} status=${base.status}`,
    account: p.account || null,
    entitlement: w.entitlement,
  }
}

export const HEADERS = { SIG_HEADER, ID_HEADER, EVENT_HEADER }
