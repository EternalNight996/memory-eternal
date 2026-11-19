// 账号层：注册 / 登录 / 会话 / 身份绑定。
//
// 设计要点：
//   · 本地账号用 scrypt（Node 内置，不引第三方），不存明文、不存可逆哈希；
//   · 一个用户可绑多个身份源（local / mengbot-oidc / mengbot-otp），identities 表唯一约束防重复绑定；
//   · **只有 email_verified=true 才允许按邮箱自动合并**，否则新建 pending 账号 —— 防止用未验证邮箱顶替别人；
//   · 密码登录成功后**同时**签发一枚 me_ 访问密钥（只返回一次）：
//     业务面 resolveTenant 目前是同步读 JSON 的，先用现成密钥通道打通，
//     PG 会话接管业务面留到 P1（避免这一版就动鉴权主路径）。
import crypto from 'node:crypto'
import { q, tx, getPool, dbStatus } from './server-db.js'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function normalizeEmail(v) { return String(v || '').trim().toLowerCase() }
export function isEmail(v) { return EMAIL_RE.test(normalizeEmail(v)) }

// ---- 密码 ----
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 }

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$')
}

export function verifyPassword(plain, stored) {
  try {
    const [algo, n, r, p, saltB64, hashB64] = String(stored || '').split('$')
    if (algo !== 'scrypt') return false
    const salt = Buffer.from(saltB64, 'base64')
    const want = Buffer.from(hashB64, 'base64')
    const got = crypto.scryptSync(String(plain), salt, want.length, { N: Number(n), r: Number(r), p: Number(p) })
    return got.length === want.length && crypto.timingSafeEqual(got, want)
  } catch { return false }
}

export function passwordProblem(plain) {
  const s = String(plain || '')
  if (s.length < 8) return '密码至少 8 位'
  if (s.length > 200) return '密码过长'
  return ''
}

// ---- 用户 ----
export async function createUser({ email, password = '', displayName = '', status = 'active' }, env = process.env) {
  const mail = normalizeEmail(email)
  if (!isEmail(mail)) return { ok: false, error: '邮箱格式不正确' }
  if (password) {
    const bad = passwordProblem(password)
    if (bad) return { ok: false, error: bad }
  }
  try {
    const r = await q(
      'INSERT INTO users(email, display_name, password_hash, status) VALUES ($1,$2,$3,$4) RETURNING id, email, status, created_at',
      [mail, displayName || null, password ? hashPassword(password) : null, status], env)
    return { ok: true, user: r.rows[0] }
  } catch (e) {
    if (String(e && e.code) === '23505') return { ok: false, error: '该邮箱已注册', code: 'email_taken' }
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  }
}

export async function findUserByEmail(email, env = process.env) {
  const r = await q('SELECT id, email, display_name, status, password_hash, created_at FROM users WHERE email = $1', [normalizeEmail(email)], env)
  return r.rows[0] || null
}

export async function getUserById(id, env = process.env) {
  const r = await q('SELECT id, email, display_name, status, created_at, updated_at FROM users WHERE id = $1', [id], env)
  return r.rows[0] || null
}

export async function listUsers({ limit = 100, offset = 0, search = '' } = {}, env = process.env) {
  const like = '%' + String(search || '').trim().toLowerCase() + '%'
  const r = await q(
    `SELECT u.id, u.email, u.status, u.created_at,
            (SELECT count(*) FROM identities i WHERE i.user_id = u.id) AS identities,
            (SELECT count(*) FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS keys,
            (SELECT max(s.last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen
       FROM users u
      WHERE ($1 = '%%' OR u.email::text ILIKE $1)
      ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
    [like, Math.min(500, Number(limit) || 100), Math.max(0, Number(offset) || 0)], env)
  return r.rows
}

/** 改账号状态（active / disabled / pending）。管理端封禁/解封用。 */
export async function setUserStatus(id, status, env = process.env) {
  const s = String(status || '').trim()
  if (!['active', 'disabled', 'pending'].includes(s)) return { ok: false, error: '状态取值非法：' + s }
  const r = await q('UPDATE users SET status = $1, updated_at = now() WHERE id = $2 RETURNING id, email, status', [s, id], env)
  if (!r.rows.length) return { ok: false, error: '用户不存在' }
  // 封禁时顺手清掉该用户所有会话，避免「已封禁但仍在线」
  if (s !== 'active') await q('DELETE FROM sessions WHERE user_id = $1', [id], env)
  return { ok: true, user: r.rows[0] }
}

/** 用户详情：身份源 + 密钥 + 最近会话。 */
export async function getUserDetail(id, env = process.env) {
  const u = await getUserById(id, env)
  if (!u) return { ok: false, error: '用户不存在' }
  const [ids, keys, sess] = await Promise.all([
    q('SELECT provider, external_id, email, email_verified, created_at FROM identities WHERE user_id=$1 ORDER BY created_at', [id], env).then((r) => r.rows).catch(() => []),
    q('SELECT id, owner, note, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC', [id], env).then((r) => r.rows).catch(() => []),
    q('SELECT via, created_at, expires_at, last_seen, ip FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10', [id], env).then((r) => r.rows).catch(() => []),
  ])
  return { ok: true, user: u, identities: ids, keys, sessions: sess }
}

// ---- 身份（第三方绑定） ----
/**
 * 绑定或取回身份。合并规则：
 *   · (provider, externalId) 已存在 → 直接用那个 user；
 *   · 否则若 emailVerified 且有同邮箱 user → 绑定到该 user；
 *   · 否则建新 user（未验证邮箱的建为 pending，等人工合并）。
 */
export async function upsertIdentity({ provider, externalId, email = '', emailVerified = false, meta = null, displayName = '' }, env = process.env) {
  const mail = normalizeEmail(email)
  const ext = String(externalId || '').trim()
  if (!provider || !ext) return { ok: false, error: 'provider/externalId 必填' }
  try {
    const hit = await q('SELECT user_id FROM identities WHERE provider=$1 AND external_id=$2', [provider, ext], env)
    if (hit.rows.length) return { ok: true, userId: hit.rows[0].user_id, linked: 'by-identity' }

    let userId = ''
    if (mail && emailVerified) {
      const u = await findUserByEmail(mail, env)
      if (u) userId = u.id
    }
    let created = false
    if (!userId) {
      const cu = await createUser({ email: mail || (provider + ':' + ext), displayName: displayName || mail, status: emailVerified || !mail ? 'active' : 'pending' }, env)
      if (!cu.ok) return cu
      userId = cu.user.id
      created = true
    }
    await q('INSERT INTO identities(user_id, provider, external_id, email, email_verified, meta) VALUES ($1,$2,$3,$4,$5,$6)',
      [userId, provider, ext, mail || null, !!emailVerified, meta ? JSON.stringify(meta) : null], env)
    return { ok: true, userId, created, linked: created ? 'new-user' : 'by-email' }
  } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 160) } }
}

/**
 * 查（**不建**）某个第三方身份是否已存在。扫码登录用它判断「要不要走授权注册」。
 * 顺序：精确 identity → 已验证邮箱；未验证邮箱**不算命中**（否则又是账号劫持）。
 */
export async function lookupIdentity({ provider, externalId = '', email = '', emailVerified = false }, env = process.env) {
  const ext = String(externalId || '').trim()
  if (ext) {
    const r = await q('SELECT user_id FROM identities WHERE provider=$1 AND external_id=$2', [provider, ext], env)
    if (r.rows.length) return { ok: true, found: true, userId: r.rows[0].user_id, by: 'identity' }
  }
  const mail = normalizeEmail(email)
  if (mail && emailVerified) {
    const u = await findUserByEmail(mail, env)
    if (u) return { ok: true, found: true, userId: u.id, by: 'email' }
  }
  return { ok: true, found: false }
}

export async function listIdentities(userId, env = process.env) {
  const r = await q('SELECT provider, external_id, email, email_verified, meta, created_at FROM identities WHERE user_id=$1 ORDER BY created_at', [userId], env)
  return r.rows
}

// ---- 会话 ----
export function hashCode(t) { return crypto.createHash('sha256').update(String(t || ''), 'utf8').digest('hex') }

export async function issueSession(userId, { via = 'password', ttlHours = 24 * 7, ip = '', ua = '' } = {}, env = process.env) {
  const token = 'ms_' + crypto.randomBytes(24).toString('base64url')
  const exp = new Date(Date.now() + Math.max(1, Number(ttlHours) || 168) * 3600 * 1000)
  await q('INSERT INTO sessions(token_hash, user_id, via, expires_at, ip, ua) VALUES ($1,$2,$3,$4,$5,$6)',
    [hashCode(token), userId, via, exp.toISOString(), ip || null, String(ua || '').slice(0, 300)], env)
  return { token, expiresAt: exp.toISOString() }
}

export async function resolveSession(token, env = process.env) {
  if (!token) return { ok: false }
  const r = await q(`SELECT s.user_id, s.expires_at, u.email, u.status
                       FROM sessions s JOIN users u ON u.id = s.user_id
                      WHERE s.token_hash = $1`, [hashCode(token)], env)
  const row = r.rows[0]
  if (!row) return { ok: false, reason: 'unknown' }
  if (row.status !== 'active') return { ok: false, reason: 'disabled' }
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' }
  q('UPDATE sessions SET last_seen = now() WHERE token_hash = $1', [hashCode(token)], env).catch(() => {})
  return { ok: true, userId: row.user_id, email: row.email }
}

export async function revokeSession(token, env = process.env) {
  await q('DELETE FROM sessions WHERE token_hash = $1', [hashCode(token)], env)
}

// ---- 登录 ----
export async function loginWithPassword(email, password, env = process.env) {
  const u = await findUserByEmail(email, env)
  // 用户不存在也走一次 scrypt，避免用响应时间枚举邮箱
  if (!u || !u.password_hash) { verifyPassword(password, hashPassword('x')); return { ok: false, error: '邮箱或密码不正确' } }
  if (!verifyPassword(password, u.password_hash)) return { ok: false, error: '邮箱或密码不正确' }
  if (u.status !== 'active') return { ok: false, error: '账号状态：' + u.status + '，请联系管理员' }
  return { ok: true, user: u }
}


// ---- 角色（user / admin） ----
/** 读角色。首次管理员按方案是「在数据库里手工提权」，所以这里只读不写。 */
export async function getUserRole(userId, env = process.env) {
  const r = await q('SELECT role FROM users WHERE id = $1', [userId], env)
  return (r.rows[0] && r.rows[0].role) || 'user'
}

// ---- 库连接匹配码 ----

/**
 * 生成匹配码：客户端粘贴它来连**某个具体库**。
 * 明文只返回这一次（库里存 sha256），支持「仅本人」与 IP 白名单。
 */
export async function createPairCode({ userId, owner, vault, label = '', ipAllow = '', onlyOwner = true }, env = process.env) {
  const code = 'pc_' + crypto.randomBytes(18).toString('base64url')
  const r = await q(
    'INSERT INTO pair_codes(user_id, owner, vault, code_hash, label, ip_allow, only_owner) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, vault, created_at',
    [userId, String(owner || '').toLowerCase(), String(vault || 'default'), hashCode(code), String(label || '').slice(0, 60), String(ipAllow || '').slice(0, 200), !!onlyOwner], env)
  return { ok: true, code, row: r.rows[0] }
}

export async function listPairCodes(userId, env = process.env) {
  const r = await q('SELECT id, vault, label, ip_allow, only_owner, created_at, last_used_at, revoked_at FROM pair_codes WHERE user_id=$1 ORDER BY created_at DESC', [userId], env)
  return r.rows
}

export async function revokePairCode(id, userId, env = process.env) {
  const r = await q('UPDATE pair_codes SET revoked_at = now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL RETURNING id', [id, userId], env)
  return r.rows.length ? { ok: true } : { ok: false, error: '匹配码不存在或已吊销' }
}

export function ipAllowed(allow, ip) {
  const list = String(allow || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
  if (!list.length) return true                    // 未配白名单 = 不限
  const got = String(ip || '').replace(/^::ffff:/, '')
  for (const item of list) {
    if (item === got) return true
    if (item.endsWith('*') && got.startsWith(item.slice(0, -1))) return true   // 支持 10.0.0.*
  }
  return false
}

/** 校验匹配码：返回它绑定的 库 + 账号。IP 不在白名单直接拒绝。 */
export async function resolvePairCode(code, ip = '', env = process.env) {
  const c = String(code || '').trim()
  if (!c.startsWith('pc_')) return { ok: false, error: '匹配码格式不正确' }
  const r = await q('SELECT id, user_id, owner, vault, ip_allow, only_owner, revoked_at FROM pair_codes WHERE code_hash = $1', [hashCode(c)], env)
  const row = r.rows[0]
  if (!row) return { ok: false, error: '匹配码无效' }
  if (row.revoked_at) return { ok: false, error: '匹配码已吊销' }
  if (!ipAllowed(row.ip_allow, ip)) return { ok: false, error: '当前 IP 不在该匹配码的白名单内' }
  q('UPDATE pair_codes SET last_used_at = now() WHERE id = $1', [row.id], env).catch(() => {})
  return { ok: true, userId: row.user_id, owner: row.owner, vault: row.vault, onlyOwner: row.only_owner }
}
// ---- 审计 ----
export async function audit({ actor = '', action, target = '', detail = null, ip = '' }, env = process.env) {
  try {
    await q('INSERT INTO audit_log(actor, action, target, detail, ip) VALUES ($1,$2,$3,$4,$5)',
      [actor || null, String(action || 'unknown'), target || null, detail ? JSON.stringify(detail) : null, ip || null], env)
  } catch { /* 审计失败不影响主流程 */ }
}

export { dbStatus }