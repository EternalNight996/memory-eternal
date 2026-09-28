// 记忆核心 · vault 目录解析（宿主与所有独立进程共用同一套优先级）
//
// 为什么单独成模块：以前宿主 index.js 认 activeVault，而 CLI / MCP / hooks /
// 独立 web / sweep 只认 MEMORY_VAULT_DIR 与默认库 —— 用户切库后终端与 hooks 仍写
// 默认库，同一台机器上的记忆被劈成两份（dsh-memory-eternal#5）。解析逻辑必须只有一份。
//
// 优先级：
//   1. MEMORY_VAULT_DIR              （临时切库 / 宿主 spawn 子进程时显式传入）
//   2. activeVault 命中 vaultProfiles[].name
//   3. vaultProfiles[].match.workspace 命中当前 workspace（最长前缀优先，opt-in）
//   4. vaultDir（单库配置）
//   5. 默认 ~/.dsh/memory-vault

import path from 'node:path'
import os from 'node:os'

/** 取当前 workspace（用于 match.workspace 的按项目选库）：MEMORY_WORKSPACE 优先，其次进程 cwd。 */
export function currentWorkspace(env = process.env) {
  const explicit = String((env && env.MEMORY_WORKSPACE) || '').trim()
  if (explicit) return explicit
  try { return process.cwd() } catch { return '' }
}

/** 默认库目录。 */
export function defaultVaultRoot(env = process.env) {
  const home = (env && env.DSH_HOME) || path.join(os.homedir(), '.dsh')
  return path.join(home, 'memory-vault')
}

/** 归一化：反斜杠转正斜杠、去尾斜杠、统一小写（Windows 路径大小写不敏感）。 */
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * 找出 match.workspace 命中当前 workspace 的 profile。
 * 双向前缀匹配（workspace 落在规则目录下，或规则目录落在 workspace 下），最长规则优先。
 * @returns {object|null}
 */
export function matchWorkspaceProfile(profiles, workspace) {
  const ws = norm(workspace)
  if (!ws) return null
  let best = null
  let bestLen = -1
  for (const p of Array.isArray(profiles) ? profiles : []) {
    const rule = p && p.match && p.match.workspace
    const target = norm(rule)
    if (!target) continue
    // 规则没配可用目录 → 不能作为记忆库，直接跳过（与 resolveVaultDir 的判定保持一致）
    if (!p.path || !String(p.path).trim()) continue
    if (!(ws === target || ws.startsWith(target + '/') || target.startsWith(ws + '/'))) continue
    if (target.length > bestLen) { best = p; bestLen = target.length }
  }
  return best
}

/**
 * 解析当前 vault 目录。
 * @param {object} input
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {Array<{name?:string,path?:string,match?:{workspace?:string}}>} [input.profiles]
 * @param {string} [input.activeVault]
 * @param {string} [input.configured] vaultDir 单库配置
 * @param {string} [input.workspace] 显式指定 workspace（默认 currentWorkspace）
 * @returns {{root:string, source:'env'|'profile'|'workspace'|'vaultDir'|'default', name:string, workspace:string}}
 */
export function resolveVaultDir({ env = process.env, profiles = [], activeVault = '', configured = '', workspace } = {}) {
  const ws = workspace === undefined ? currentWorkspace(env) : String(workspace || '')
  const envDir = String((env && env.MEMORY_VAULT_DIR) || '').trim()
  if (envDir) return { root: path.resolve(envDir), source: 'env', name: '', workspace: ws }

  const list = Array.isArray(profiles) ? profiles : []
  const active = String(activeVault || '').trim()
  if (active) {
    const hit = list.find((p) => p && String(p.name || '') === active && p.path && String(p.path).trim())
    if (hit) return { root: path.resolve(String(hit.path).trim()), source: 'profile', name: active, workspace: ws }
  }
  const byWs = matchWorkspaceProfile(list, ws)
  if (byWs && byWs.path && String(byWs.path).trim()) {
    return { root: path.resolve(String(byWs.path).trim()), source: 'workspace', name: String(byWs.name || ''), workspace: ws }
  }
  if (configured && String(configured).trim()) {
    return { root: path.resolve(String(configured).trim()), source: 'vaultDir', name: '', workspace: ws }
  }
  return { root: defaultVaultRoot(env), source: 'default', name: '', workspace: ws }
}
