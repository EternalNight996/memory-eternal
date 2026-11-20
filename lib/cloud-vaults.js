// 云端多库：一个租户名下的多个记忆库。
//
// 目录布局（**默认库原位不动，零迁移**）：
//   cloud-vaults/<owner>/memory-eternal.db            ← 默认库（老用户的库就是它）
//   cloud-vaults/<owner>/vaults/<slug>/memory-eternal.db   ← 新建的命名库
//
// 为什么新库放 vaults/ 子目录而不是平铺：
//   租户目录下已经有 memory-eternal.db / -wal / -shm / news/ / graph-cache 等文件，
//   平铺命名库会和它们混在一起，"哪个是库"变得不可读，也不好做清理与备份。
//
// slug 只允许 [a-z0-9_-]，长度 1-32：挡路径穿越（../）、挡 Windows 保留名、挡大小写歧义。
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DB = 'memory-eternal.db'
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
// Windows 保留设备名（即便在 Linux 上也拒绝，保证跨平台一致）
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/

/** 校验 slug；不合法返回 null。 */
export function normalizeVaultSlug(raw) {
  const s = String(raw || '').trim().toLowerCase()
  if (!s) return null
  if (!SLUG_RE.test(s)) return null
  if (RESERVED.test(s)) return null
  return s
}

/** 租户根下的默认库路径。 */
export function defaultVaultRoot(ownerRoot) {
  return path.resolve(String(ownerRoot || ''))
}

/** 命名库的根目录（尚未创建时也返回路径）。 */
export function namedVaultRoot(ownerRoot, slug) {
  const s = normalizeVaultSlug(slug)
  if (!s) return ''
  return path.join(path.resolve(String(ownerRoot || '')), 'vaults', s)
}

/** 某个库根是否真的是库（有 .db 文件）。 */
export function isVaultRoot(root) {
  try { return fs.existsSync(path.join(String(root || ''), DB)) } catch { return false }
}

/**
 * 建库（幂等：已存在就直接返回）。
 * @returns {{ok:boolean, root?:string, name?:string, created?:boolean, error?:string}}
 */
export function createNamedVault(ownerRoot, slug) {
  const s = normalizeVaultSlug(slug)
  if (!s) return { ok: false, error: '库名只能用 a-z 0-9 _ -，1-32 位，且不能是 con/prn 等保留名' }
  const root = namedVaultRoot(ownerRoot, s)
  if (!root) return { ok: false, error: '库名不合法' }
  try {
    // 幂等按「目录存在」判断：建库只建目录，schema 由首次访问时的 ensureVault 建
    if (fs.existsSync(root)) return { ok: true, root, name: s, created: false }
    fs.mkdirSync(root, { recursive: true })
    return { ok: true, root, name: s, created: true }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 列出某租户名下的所有库（默认库在前，命名库按名字排序）。
 * @returns {Array<{ name:string, root:string, kind:'default'|'named', slug:string }>}
 */
export function listOwnerVaults(ownerRoot) {
  const base = path.resolve(String(ownerRoot || ''))
  const out = []
  if (isVaultRoot(base)) out.push({ name: 'default', root: base, kind: 'default', slug: '' })
  try {
    const dir = path.join(base, 'vaults')
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const s = normalizeVaultSlug(d.name)
      if (!s) continue
      const root = path.join(dir, s)
      // 只要求目录存在：刚建的库还没有 .db，首次访问时由 ensureVault 建 schema
      if (fs.existsSync(root)) out.push({ name: s, root, kind: 'named', slug: s })
    }
  } catch { /* 没有 vaults/ 目录 = 只有默认库 */ }
  out.sort((a, b) => (a.kind === 'default' ? -1 : b.kind === 'default' ? 1 : a.name.localeCompare(b.name)))
  // 补 cards / sizeMB：以前这里只返回 name/root/kind/slug，
  // 所有调用方（/cloud/connect、控制台、管理端）拿到的 v.cards 都是 undefined，
  // 界面上就显示成"空"。统计失败给 null，不抛。
  for (const v of out) {
    v.cards = null
    v.sizeMB = null
    try {
      const dbFile = path.join(v.root, DB)
      const st = fs.statSync(dbFile)
      v.sizeMB = Math.round((st.size / (1024 * 1024)) * 10) / 10
    } catch { /* 还没建库 */ }
    try {
      // **不要用 readOnly**：库通常是 WAL 模式，未 checkpoint 的数据在 -wal 文件里，
      // 只读连接读不到，COUNT(*) 会返回 0 或残缺值 ——
      // 实测把 9888 张读成 8 张，看起来像"云端数据丢了"。
      const db = new DatabaseSync(path.join(v.root, DB))
      try {
        v.cards = Number(db.prepare('SELECT COUNT(*) n FROM cards').get().n) || 0
      } catch {
        // 空库（0 字节）还没建表 —— 那就是 0 张，不是"未知"
        v.cards = 0
      } finally { db.close() }
    } catch {
      // 文件都打不开（不存在 / 被锁）：确实未知
      v.cards = null
    }
  }
  return out
}
