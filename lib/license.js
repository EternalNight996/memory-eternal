// 授权校验（商用）：离线签名 license，过期降级。
//
// 形态：JWS compact（ES256）—— `header.payload.signature` 三段 base64url。
//   header : {"alg":"ES256","typ":"JWT"}
//   payload: {"sub":"客户标识","plan":"pro|team","seats":5,"exp":1767225600,"features":["cloud"]}
// 服务端只内嵌**公钥**，私钥在签发方手里（`scripts/license-issue.mjs`，私钥绝不进仓库）。
//
// 降级策略（MEMORY_LICENSE_DEGRADE，默认 warn）：
//   warn     —— 照常服务，但日志/`/cloud/config` 标记不合法（试用友好）
//   readonly —— 写接口返回 403，读接口正常（到期后还能导出数据）
//   stop     —— 整体拒绝（除 `/cloud/config` 与 `/cloud/whoami`，方便排查）
//
// 为什么用离线签名而不是联网校验：私有部署常在离线内网；离线 license 到期靠 exp 判定，
// 不需要每次请求打回签发方。

import crypto from 'node:crypto'

/** 内置公钥（P-256）。签发方的私钥不进仓库，见 scripts/license-issue.mjs。 */
export const DEFAULT_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEOaG7Ookj4hYabUAJYO+Cc3vojZbD
EocU3h9kjb7cbxszM0knDYRxFgdLW/e5JixQiuWjvxbre/LQKmy4T2H0fg==
-----END PUBLIC KEY-----`

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const fromB64u = (s) => Buffer.from(String(s), 'base64url')

/** 解析 JWS compact（不验签，只拆结构；验签在 verifyLicense）。 */
export function parseLicense(token) {
  const parts = String(token || '').trim().split('.')
  if (parts.length !== 3) return { ok: false, error: 'license 格式不对（应为 header.payload.signature 三段）' }
  try {
    const header = JSON.parse(fromB64u(parts[0]).toString('utf8'))
    const payload = JSON.parse(fromB64u(parts[1]).toString('utf8'))
    return { ok: true, header, payload, signature: parts[2], signingInput: parts[0] + '.' + parts[1] }
  } catch (e) {
    return { ok: false, error: 'license 解析失败：' + String((e && e.message) || e) }
  }
}

/**
 * 验签 + 校验过期。
 * @returns {{ok:boolean, status:'valid'|'expired'|'invalid'|'missing', payload?:object, error?:string, expiresAt?:string, daysLeft?:number}}
 */
export function verifyLicense(token, { publicKey = DEFAULT_PUBLIC_KEY_PEM, now = Date.now(), graceDays = 0 } = {}) {
  if (!token) return { ok: false, status: 'missing', error: '未提供 license（MEMORY_SERVER_LICENSE）' }
  const parsed = parseLicense(token)
  if (!parsed.ok) return { ok: false, status: 'invalid', error: parsed.error }
  const { header, payload, signature, signingInput } = parsed

  if (String(header.alg || '').toUpperCase() !== 'ES256') {
    return { ok: false, status: 'invalid', error: '不支持的签名算法：' + header.alg }
  }
  let sigOk = false
  try {
    sigOk = crypto.verify(
      'sha256',
      Buffer.from(signingInput, 'utf8'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      fromB64u(signature),
    )
  } catch (e) {
    return { ok: false, status: 'invalid', error: '验签异常：' + String((e && e.message) || e) }
  }
  if (!sigOk) return { ok: false, status: 'invalid', error: '签名不匹配（license 被改动或公钥不对）', payload }

  const exp = Number(payload.exp || 0)
  if (!exp) return { ok: false, status: 'invalid', error: 'license 缺少 exp（到期时间）', payload }
  const expMs = exp * 1000
  const daysLeft = Math.floor((expMs - now) / 86400000)
  const expired = now > expMs + graceDays * 86400000
  return {
    ok: !expired,
    status: expired ? 'expired' : 'valid',
    payload,
    expiresAt: new Date(expMs).toISOString(),
    daysLeft,
    error: expired ? `license 已于 ${new Date(expMs).toISOString()} 到期` : undefined,
  }
}

/** 签发（签发方用私钥；服务端不需要）。测试里也用它造样本。 */
export function signLicense(payload, privateKeyPem) {
  const header = { alg: 'ES256', typ: 'JWT' }
  const h = b64u(JSON.stringify(header))
  const p = b64u(JSON.stringify(payload))
  const input = h + '.' + p
  const sig = crypto.sign('sha256', Buffer.from(input, 'utf8'), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' })
  return input + '.' + b64u(sig)
}

/**
 * 当前进程的 license 状态（读 `MEMORY_SERVER_LICENSE`）。
 * @returns {{status:string, ok:boolean, degrade:'warn'|'readonly'|'stop', canWrite:boolean, payload:object|null, error?:string, daysLeft?:number, expiresAt?:string}}
 */
export function licenseState(env = process.env, opts = {}) {
  const raw = String(env.MEMORY_SERVER_LICENSE || '').trim()
  const degrade = normaliseDegrade(env.MEMORY_LICENSE_DEGRADE)
  if (!raw) {
    return {
      ok: false, status: 'missing', degrade,
      // 没配 license 时：readonly/stop 才拦写；warn 放行（试用/自用）
      canWrite: degrade === 'warn',
      payload: null,
      error: '未配置 MEMORY_SERVER_LICENSE',
    }
  }
  const r = verifyLicense(raw, { publicKey: opts.publicKey || DEFAULT_PUBLIC_KEY_PEM, now: opts.now, graceDays: opts.graceDays })
  return {
    ok: r.ok, status: r.status, degrade,
    canWrite: r.ok || degrade === 'warn',
    payload: r.payload || null,
    error: r.error,
    daysLeft: r.daysLeft,
    expiresAt: r.expiresAt,
  }
}

function normaliseDegrade(v) {
  const s = String(v || '').trim().toLowerCase()
  if (s === 'readonly' || s === 'read-only' || s === 'ro') return 'readonly'
  if (s === 'stop' || s === 'closed' || s === 'off') return 'stop'
  return 'warn'
}

/** 只读降级时允许通过的路径（读 + 诊断 + 导出，方便客户拿回自己的数据）。 */
export const READONLY_ALLOW = [
  /^\/cloud\/(config|whoami|connect|client)/,
  /^\/overview$/, /^\/cards$/, /^\/card$/, /^\/stats$/, /^\/tag-cloud$/,
  /^\/type-cloud$/, /^\/audit\/(list|preview|kinds)$/, /^\/recycle\/(list)?$/,
  /^\/backup\/(status|config|export)$/, /^\/diagnostics$/, /^\/config$/, /^\/setup-status$/,
]

/** 该请求在只读降级下是否放行。**非 GET/HEAD 一律拦**（同一路径可能读写双语义，如 /card）。 */
export function allowedWhenReadonly(subPath, method = 'GET') {
  const m = String(method || 'GET').toUpperCase()
  if (m !== 'GET' && m !== 'HEAD') return false
  const p = String(subPath || '').split('?')[0]
  return READONLY_ALLOW.some((re) => re.test(p))
}

/** 给客户端看的摘要（**不含 license 原文**）。 */
export function licenseSummary(state) {
  return {
    status: state.status,
    ok: state.ok,
    degrade: state.degrade,
    canWrite: state.canWrite,
    plan: state.payload && state.payload.plan || null,
    owner: state.payload && state.payload.sub || null,
    seats: state.payload && state.payload.seats || null,
    features: state.payload && state.payload.features || null,
    expiresAt: state.expiresAt || null,
    daysLeft: state.daysLeft ?? null,
    error: state.error || null,
  }
}
