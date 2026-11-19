// 控制面数据库（PostgreSQL）：账号 / 身份 / 会话 / 密钥 / 套餐 / 审计。
//
// 为什么控制面用 PG、而租户记忆库仍是 SQLite：
//   · 控制面数据量小但要求**并发、事务、关联查询**（谁绑了哪些身份、哪些会话过期）——PG 合适；
//   · 记忆库是产品本体，SQLite 单文件带来「可 git、可拷走、离线全功能」——换 PG 等于换产品。
//
// 连接串来自 DATABASE_URL；没配时本模块一律返回不可用，**不抛错**（让服务端保持纯 SQLite 模式可启动）。
import crypto from 'node:crypto'

let pool = null
let ready = false
let initError = ''

/** 懒加载 pg：没装包或没配 DATABASE_URL 时，服务端照常跑（只是没有账号体系）。 */
export async function getPool(env = process.env) {
  if (pool) return pool
  const url = String(env.DATABASE_URL || '').trim()
  if (!url) { initError = 'DATABASE_URL 未配置'; return null }
  try {
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: url, max: 8, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 })
    pool.on('error', (e) => { console.error('[pg] pool error:', String(e && e.message).slice(0, 120)) })
    return pool
  } catch (e) {
    initError = 'pg 驱动不可用：' + String((e && e.message) || e)
    return null
  }
}

export function dbStatus() { return { ready, error: initError, configured: !!pool } }

/** 参数化查询。调用方必须用 $1/$2 占位，绝不拼字符串。 */
export async function q(sql, params = [], env = process.env) {
  const p = await getPool(env)
  if (!p) throw new Error(initError || '数据库不可用')
  const r = await p.query(sql, params)
  return r
}

export async function tx(fn, env = process.env) {
  const p = await getPool(env)
  if (!p) throw new Error(initError || '数据库不可用')
  const c = await p.connect()
  try {
    await c.query('BEGIN')
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (e) {
    try { await c.query('ROLLBACK') } catch { /* 忽略 */ }
    throw e
  } finally { c.release() }
}

const SCHEMA = [
  'CREATE EXTENSION IF NOT EXISTS citext',
  'CREATE EXTENSION IF NOT EXISTS pgcrypto',
  `CREATE TABLE IF NOT EXISTS users (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     email CITEXT NOT NULL UNIQUE,
     display_name TEXT,
     password_hash TEXT,
     status TEXT NOT NULL DEFAULT 'active',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS identities (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     provider TEXT NOT NULL,
     external_id TEXT NOT NULL,
     email CITEXT,
     email_verified BOOLEAN NOT NULL DEFAULT false,
     meta JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (provider, external_id)
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY,
     user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     via TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at TIMESTAMPTZ NOT NULL,
     last_seen TIMESTAMPTZ,
     ip TEXT,
     ua TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)',
  'CREATE INDEX IF NOT EXISTS sessions_exp_idx ON sessions(expires_at)',
  `CREATE TABLE IF NOT EXISTS api_keys (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id UUID REFERENCES users(id) ON DELETE SET NULL,
     owner CITEXT NOT NULL,
     note TEXT,
     hash TEXT NOT NULL UNIQUE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_used_at TIMESTAMPTZ,
     revoked_at TIMESTAMPTZ
   )`,
  'CREATE INDEX IF NOT EXISTS api_keys_owner_idx ON api_keys(owner)',
  `CREATE TABLE IF NOT EXISTS entitlements (
     owner CITEXT PRIMARY KEY,
     plan TEXT, status TEXT, expires_at TIMESTAMPTZ,
     caps JSONB, source TEXT, fetched_at TIMESTAMPTZ
   )`,
  `CREATE TABLE IF NOT EXISTS vaults (
     owner CITEXT NOT NULL, name TEXT NOT NULL, root TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (owner, name)
   )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id BIGSERIAL PRIMARY KEY,
     at TIMESTAMPTZ NOT NULL DEFAULT now(),
     actor TEXT, action TEXT NOT NULL, target TEXT, detail JSONB, ip TEXT
   )`,
  'CREATE INDEX IF NOT EXISTS audit_at_idx ON audit_log(at DESC)',
  // 角色：user / admin。**只在数据库里改**（首次管理员按方案就是手工 SQL 提权）。
  "ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'",
  // 库连接匹配码：客户端粘贴它来连某个具体库；可限本人 + 限 IP，可吊销。
  `CREATE TABLE IF NOT EXISTS pair_codes (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id UUID REFERENCES users(id) ON DELETE CASCADE,
     owner CITEXT NOT NULL,
     vault TEXT NOT NULL,
     code_hash TEXT NOT NULL UNIQUE,
     label TEXT,
     ip_allow TEXT,
     only_owner BOOLEAN NOT NULL DEFAULT true,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_used_at TIMESTAMPTZ,
     revoked_at TIMESTAMPTZ
   )`,
  'CREATE INDEX IF NOT EXISTS pair_codes_user_idx ON pair_codes(user_id)',
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
]

/** 建表（幂等）。返回 { ok, error? }，绝不抛错。 */
export async function ensureSchema(env = process.env) {
  try {
    for (const sql of SCHEMA) await q(sql, [], env)
    await q('INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [1], env)
    ready = true; initError = ''
    return { ok: true }
  } catch (e) {
    initError = String((e && e.message) || e).slice(0, 200)
    ready = false
    return { ok: false, error: initError }
  }
}

export { SCHEMA }