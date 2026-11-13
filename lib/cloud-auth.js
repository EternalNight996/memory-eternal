// 云端多租户鉴权：**每人一把密钥 → 每人一个独立 SQLite**。
//
// 设计取舍（用户拍板的架构）：
//   · 不用 PG、不动现有 SQLite 写入路径 —— 云端就是一个"能按密钥分库"的服务端；
//   · 每个用户一个独立 vault 目录（`$DSH_HOME/cloud-vaults/<owner>/memory-eternal.db`），
//     彼此物理隔离：一个人的库坏了/被删了，不会影响别人；
//   · 两种进门方式：① 云端签发的 Bearer 密钥；② MengBot 授权登录换来的令牌。
//
// 密钥只存 sha256（明文只在创建时返回一次），文件 0600。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const KEY_PREFIX = 'me_'
const KEY_BYTES = 24

/** 云端根目录（所有租户库的父目录）。 */
export function cloudRoot(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'cloud-vaults')
}

/** 密钥台账文件（只存哈希）。 */
export function keyStorePath(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'cloud-keys.json')
}

/** 单个租户的 vault 目录：owner 做文件名前缀，顺便挡掉路径穿越。 */
export function tenantVault(owner, env = process.env) {
  const safe = String(owner || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 64)
  if (!safe) throw new Error('owner 不合法')
  return path.join(cloudRoot(env), safe)
}

export function hashCode(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex')
}

function readStore(env) {
  try {
    const raw = JSON.parse(fs.readFileSync(keyStorePath(env), 'utf8'))
    return { version: 1, keys: Array.isArray(raw.keys) ? raw.keys : [], mengbot: raw.mengbot || {}, ...{} }
  } catch {
    return { version: 1, keys: [], mengbot: {} }
  }
}

function writeStore(store, env) {
  const file = keyStorePath(env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  return store
}

/** 签发一把密钥：返回**明文一次**，库里只留哈希。 */
export function issueKey({ owner, note = '', vault = '' } = {}, env = process.env) {
  const name = String(owner || '').trim()
  if (!name) throw new Error('缺少 owner（这个密钥属于谁）')
  const token = KEY_PREFIX + crypto.randomBytes(KEY_BYTES).toString('base64url')
  const store = readStore(env)
  const rec = {
    id: 'k_' + crypto.randomBytes(6).toString('hex'),
    owner: name,
    hash: hashCode(token),
    note: String(note || '').slice(0, 120),
    vault: String(vault || ''),
    createdAt: new Date().toISOString(),
    lastUsedAt: '',
    revoked: false,
  }
  store.keys = [...store.keys, rec]
  writeStore(store, env)
  return { token, key: publicKey(rec) }
}

const publicKey = (k) => ({
  id: k.id, owner: k.owner, note: k.note, vault: k.vault || '',
  createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || '', revoked: !!k.revoked,
})

/** 列出密钥（**不含明文与哈希**）。 */
export function listKeys(env = process.env) {
  return readStore(env).keys.map(publicKey)
}

export function revokeKey(id, env = process.env) {
  const store = readStore(env)
  const hit = store.keys.find((k) => k.id === id)
  if (!hit) return { ok: false, error: '没有这把密钥' }
  hit.revoked = true
  writeStore(store, env)
  return { ok: true, key: publicKey(hit) }
}

/**
 * 用 token 换租户：命中返回 `{ ok, owner, vaultRoot, via }`；不命中返回 `{ ok:false, error }`。
 * via = `key`（云端密钥）或 `mengbot`（MengBot 令牌）。
 */
export function resolveTenant(authorization = '', env = process.env) {
  const raw = String(authorization || '').trim()
  const token = raw.replace(/^Bearer\s+/i, '').trim()
  if (!token) return { ok: false, error: '缺少 Authorization: Bearer <token>' }
  const store = readStore(env)

  if (token.startsWith(KEY_PREFIX)) {
    const h = hashCode(token)
    const hit = store.keys.find((k) => k.hash === h && !k.revoked)
    if (!hit) return { ok: false, error: '密钥无效或已吊销' }
    hit.lastUsedAt = new Date().toISOString()
    writeStore(store, env)
    const vault = hit.vault || tenantVault(hit.owner, env)
    return { ok: true, owner: hit.owner, vaultRoot: vault, via: 'key', keyId: hit.id }
  }

  // MengBot 令牌：由 oauth 校验后写入 `store.mengbot.sessions`（见 verifyMengbotLogin）
  const sess = (store.mengbot.sessions || []).find((s) => s.token === token)
  if (sess && (!sess.expiresAt || Date.parse(sess.expiresAt) > Date.now())) {
    return { ok: true, owner: sess.owner, vaultRoot: tenantVault(sess.owner, env), via: 'mengbot' }
  }
  return { ok: false, error: '无法识别的令牌' }
}

/**
 * MengBot 云端账号授权 —— **按 mengbot control-plane 的真实机制实现**。
 *
 * mengbot 云（`cloud.mengbot.com.cn`）用的是 better-auth：
 *   ① 发码   POST {base}/api/auth/email-otp/send-verification-otp  {email}        8 位、10 分钟、限流 60s/5
 *   ② 登录   POST {base}/api/auth/sign-in/email-otp                {email, otp}    → 会话（bearer token）
 *   ③ 校验   GET  {base}/v1/me                                     Bearer <token>  → {user:{id,email,...}}
 *
 * 另有**设备凭据**（长期，90 天）：
 *   ④ 创建   POST {base}/v1/installations   Bearer <用户会话>      → {credential:"mb_install_<22>.<43>", ...}
 *   ⑤ 自校验 GET  {base}/v1/installations/self  Bearer mb_install_... → {installation:{id,...}}
 *
 * 所以这里**不再假设 OAuth2 的 code→tokenUrl**（那是错的），改成三种入口：
 *   { token }              → 直接用令牌（用户会话 或 mb_install_* 设备凭据）
 *   { email }              → 代发 OTP，返回 step:'otp-sent'
 *   { email, otp }         → 登录换 token → 校验 → 签发本地令牌
 *
 * 配置（cloud-keys.json 的 mengbot，或环境变量）：
 *   { baseUrl: "https://cloud.mengbot.com.cn", allowList: [], ttlHours: 168 }
 */
export function readMengbotConfig(env = process.env) {
  const store = readStore(env)
  const mb = store.mengbot || {}
  return {
    baseUrl: String(mb.baseUrl || env.MEMORY_MENGBOT_BASE_URL || '').trim().replace(/\/+$/, ''),
    allowList: Array.isArray(mb.allowList) ? mb.allowList.map(String) : [],
    ttlHours: Math.max(1, Math.min(24 * 30, Number(mb.ttlHours) || 24 * 7)),
  }
}

/** 签一个本地令牌并计入会话表（与密钥一样解析成独立 vault）。 */
function issueSessionToken({ owner, via, ttlHours, env }) {
  const store = readStore(env)
  const token = 'mb_' + crypto.randomBytes(20).toString('base64url')
  const sessions = [...((store.mengbot && store.mengbot.sessions) || []).slice(-200), {
    token, owner, via, at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlHours * 3600000).toISOString(),
  }]
  store.mengbot = { ...(store.mengbot || {}), sessions }
  writeStore(store, env)
  return token
}

export async function verifyMengbotLogin({ token = '', email = '', otp = '', env = process.env, fetchImpl = fetch } = {}) {
  const cfg = readMengbotConfig(env)
  if (!cfg.baseUrl) {
    return { ok: false, error: '未配置 MengBot 云地址（cloud-keys.json 的 mengbot.baseUrl 或 MEMORY_MENGBOT_BASE_URL，例如 https://cloud.mengbot.com.cn）' }
  }

  let bearer = String(token || '').trim()

  // ① 只有邮箱 → 代发 OTP（不落任何状态，等用户把码带回来）
  if (!bearer && email && !otp) {
    try {
      const r = await fetchImpl(cfg.baseUrl + '/api/auth/email-otp/send-verification-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: String(email) }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) return { ok: false, error: 'MengBot 发码失败：' + (d.message || d.error || ('HTTP ' + r.status)) }
      return { ok: true, pending: true, step: 'otp-sent', email: String(email), hint: '验证码已发到邮箱（8 位、10 分钟有效），把它连同 email 一起再提交一次' }
    } catch (e) {
      return { ok: false, error: '连接 MengBot 失败：' + String((e && e.message) || e) }
    }
  }

  // ② email + otp → 登录换 token
  if (!bearer && email && otp) {
    try {
      const r = await fetchImpl(cfg.baseUrl + '/api/auth/sign-in/email-otp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: String(email), otp: String(otp) }),
      })
      const d = await r.json().catch(() => ({}))
      // better-auth 的 bearer 插件的 token 可能在 body.token，也可能在 set-auth-token 头
      bearer = String(d.token || '').trim() || String((r.headers && typeof r.headers.get === 'function' ? r.headers.get('set-auth-token') : '') || '').trim()
      if (!r.ok || !bearer) {
        return { ok: false, error: 'MengBot 登录失败：' + (d.message || d.error || ('HTTP ' + r.status) || '未返回令牌') }
      }
    } catch (e) {
      return { ok: false, error: '连接 MengBot 失败：' + String((e && e.message) || e) }
    }
  }

  if (!bearer) return { ok: false, error: '缺少 token，或 email + otp' }

  // ③ 校验令牌：设备凭据走 /v1/installations/self，用户会话走 /v1/me
  try {
    const isInstall = bearer.startsWith('mb_install_')
    const path = isInstall ? '/v1/installations/self' : '/v1/me'
    const r = await fetchImpl(cfg.baseUrl + path, { headers: { Authorization: 'Bearer ' + bearer } })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) {
      return { ok: false, error: 'MengBot 令牌无效：' + (d.error || d.message || ('HTTP ' + r.status)) }
    }
    const owner = isInstall
      ? 'mb-inst-' + String((d.installation && d.installation.id) || '').slice(0, 36)
      : String((d.user && (d.user.email || d.user.id)) || '').trim()
    if (!owner || owner === 'mb-inst-') return { ok: false, error: 'MengBot 未返回用户标识' }
    if (cfg.allowList.length && !cfg.allowList.includes(owner)) return { ok: false, error: '该账号不在 allowList 内（' + owner + '）' }

    const local = issueSessionToken({ owner, via: isInstall ? 'mengbot-install' : 'mengbot', ttlHours: cfg.ttlHours, env })
    return {
      ok: true,
      token: local,
      owner,
      via: isInstall ? 'mengbot-install' : 'mengbot',
      vaultRoot: tenantVault(owner, env),
      upstream: { baseUrl: cfg.baseUrl, user: d.user || null, installation: d.installation || null },
      expiresInHours: cfg.ttlHours,
    }
  } catch (e) {
    return { ok: false, error: '连接 MengBot 失败：' + String((e && e.message) || e) }
  }
}

/** 云端配置（脱敏：不返回任何密钥/会话令牌）。 */
export function publicCloudConfig(env = process.env) {
  const store = readStore(env)
  const cfg = readMengbotConfig(env)
  const mb = store.mengbot || {}
  return {
    cloudRoot: cloudRoot(env),
    keys: store.keys.length,
    mengbot: {
      // 与 mengbot control-plane 的真实机制对齐：邮箱 OTP 登录 + bearer 会话 + 设备凭据
      configured: !!cfg.baseUrl,
      baseUrl: cfg.baseUrl,
      loginPath: cfg.baseUrl ? '/api/auth/sign-in/email-otp' : '',
      sendOtpPath: cfg.baseUrl ? '/api/auth/email-otp/send-verification-otp' : '',
      allowList: cfg.allowList,
      ttlHours: cfg.ttlHours,
      sessions: (mb.sessions || []).filter((s) => !s.expiresAt || Date.parse(s.expiresAt) > Date.now()).length,
    },
  }
}
