// 当前记忆库的「共享偏好」—— 让 DSH 插件端与独立 web 服务读到同一个库。
//
// 为什么需要它：当前库原来是**启动参数**（--vault）定死的，进程跑起来就改不了。
// 用户在 web 端切了库，DSH 那边不知道；反之亦然。两边各跑一份数据，很容易写错地方。
//
// 做法：把「用户选的库」写进 $DSH_HOME 下的一个小 JSON，两边启动时都读它。
//   · 优先级：显式 --vault > 这个文件 > 默认路径
//     （显式参数永远赢，否则脚本化调用会被历史选择干扰）
//   · 切换时不重启进程：只写文件 + 告诉调用方「需要重启才生效」。
//     自动重启服务是危险动作（可能正在写卡），交给用户决定。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const FILE = 'memory-eternal-active-vault.json'

/** 偏好文件路径（$DSH_HOME 或 ~/.dsh）。 */
export function vaultPrefPath(env = process.env) {
  const home = String(env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
  return path.join(home, FILE)
}

/** 读当前选择的库路径（没有或非法就返回空串）。 */
export function readActiveVault(env = process.env) {
  try {
    const p = vaultPrefPath(env)
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    const v = String((raw && raw.path) || '').trim()
    if (!v) return ''
    // 只在库确实存在时采信 —— 用户可能把库删了/挪了，这时应该回落到默认而不是报错
    if (!fs.existsSync(path.join(v, 'memory-eternal.db'))) return ''
    return path.resolve(v)
  } catch {
    return ''
  }
}

/** 写当前选择的库（返回写入结果，供 API 转述）。 */
export function writeActiveVault(root, env = process.env) {
  const target = path.resolve(String(root || ''))
  if (!target) return { ok: false, error: '路径为空' }
  if (!fs.existsSync(path.join(target, 'memory-eternal.db'))) {
    return { ok: false, error: '该目录下没有 memory-eternal.db：' + target }
  }
  try {
    const p = vaultPrefPath(env)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const payload = {
      path: target,
      updatedAt: new Date().toISOString(),
      by: String(env.MEMORY_VAULT_PREF_BY || 'api'),
    }
    fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, path: target, file: p, payload }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 解析「本次进程应该用哪个库」。
 * @param {{ explicit?: string, fallback: string, env?: object }} args
 *   explicit: 命令行显式给的（--vault），优先级最高
 *   fallback: 默认路径
 */
export function resolveVaultRoot({ explicit = '', fallback = '', env = process.env } = {}) {
  const ex = String(explicit || '').trim()
  if (ex) return { root: path.resolve(ex), source: 'explicit' }
  const pref = readActiveVault(env)
  if (pref) return { root: pref, source: 'pref' }
  return { root: path.resolve(String(fallback || '')), source: 'default' }
}
