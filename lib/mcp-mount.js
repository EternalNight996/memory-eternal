// Agent MCP 挂载状态（默认**不挂载**）+ 统一标准：一处声明 → 多宿主渲染。
//
// 为什么默认不挂：本机常同时跑多个 memory-eternal（7999 运营库 / 7989 mem-purge / 云端实例），
// 一旦自动挂载，Agent 的沉淀与召回就会串到别的库里去。用户必须显式选一个目标再挂。
//
// 统一标准（细节见 lib/mcp-hosts.js 文件头）：
//   · 单一事实源：目标/命令/环境只在这里声明一次；
//   · 名字固定 memory-eternal，同一时刻只挂一个目标；
//   · stdio + 绝对路径 + env 传参；幂等、不越界、写后回读校验；
//   · 默认 dsh 一个宿主，可 --host dsh,claude,codex,cursor,windsurf,all 一次投影多处。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SERVER_NAME, parseHosts, hostMatrix, writeHosts, removeHosts, HOSTS } from './mcp-hosts.js'

export { SERVER_NAME, HOSTS, parseHosts }
export const STATE_FILE = 'memory-eternal-mcp-mount.json'
export const MCP_FILE = 'mcp-servers.json'

const home = (env = process.env) => String((env && env.DSH_HOME) || '').trim() || path.join(os.homedir(), '.dsh')
export const mcpFilePath = (env) => path.join(home(env), MCP_FILE)
export const statePath = (env) => path.join(home(env), STATE_FILE)

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback } }
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, p)
  return obj
}

export function mcpEntryPath(packageRoot) {
  return path.join(packageRoot, 'bin', 'dsh-memory.mjs')
}

/** canonical 条目：所有宿主都渲染这一份。 */
export function canonicalEntry({ target, packageRoot }) {
  const t = target || {}
  const kind = t.kind === 'peer' ? 'peer' : 'local'
  const envs = {}
  if (kind === 'peer') {
    const url = String(t.url || '').trim().replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(url)) throw new Error('peer 目标需要一个 http(s) 地址')
    envs.MEMORY_API = url
  } else if (String(t.vault || '').trim()) {
    envs.MEMORY_VAULT_DIR = String(t.vault).trim()
  }
  return {
    serverName: SERVER_NAME,
    transport: 'stdio',
    command: process.execPath || 'node',
    args: [mcpEntryPath(packageRoot), 'mcp'],
    env: envs,
    target: { kind, vault: String(t.vault || ''), url: String(t.url || ''), name: String(t.name || '') },
    at: new Date().toISOString(),
  }
}

/**
 * 当前挂载状态。
 * 返回里既有**兼容字段**（mounted/entry/target/mcpFile/otherServers），也有新宿主矩阵 `hosts`。
 */
export function getMount({ env = process.env, packageRoot = '' } = {}) {
  const state = readJson(statePath(env), null)
  const matrix = hostMatrix(env)
  const dsh = matrix.find((h) => h.id === 'dsh') || null
  const mountedHosts = matrix.filter((h) => h.mounted)
  const entry = (dsh && dsh.entry) || null
  const servers = readJson(mcpFilePath(env), { mcpServers: {} }) || { mcpServers: {} }
  const others = Object.keys(servers.mcpServers || {}).filter((k) => k !== SERVER_NAME)

  // 漂移：宿主里那条的 command/args 与当前包路径不一致（升级/搬目录后会出现）
  let drift = null
  if (entry && packageRoot) {
    const want = mcpEntryPath(packageRoot)
    const got = Array.isArray(entry.args) ? String(entry.args[0] || '') : ''
    if (got && path.resolve(got) !== path.resolve(want)) drift = { field: 'args[0]', host: got, now: want }
  }

  return {
    ok: true,
    mounted: mountedHosts.length > 0,
    mountedIn: mountedHosts.map((h) => h.id),
    serverName: SERVER_NAME,
    entry,
    target: mountedHosts.length > 0 ? ((state && state.target) || null) : null,
    stateFile: state || null,
    hosts: matrix,
    drift,
    mcpFile: mcpFilePath(env),
    entryExists: packageRoot ? fs.existsSync(mcpEntryPath(packageRoot)) : null,
    otherServers: others,
  }
}

/**
 * 挂载（覆盖式：同一时刻只允许一个 memory-eternal 目标）。
 * @param {{target:object, packageRoot:string, env?:object, hosts?:string|string[]}} opts
 */
export function mount({ target, packageRoot, env = process.env, hosts = 'dsh' } = {}) {
  let list
  try { list = parseHosts(Array.isArray(hosts) ? hosts.join(',') : hosts) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
  let canonical
  try { canonical = canonicalEntry({ target, packageRoot }) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }

  const results = writeHosts(canonical, list, env)
  const failed = results.filter((r) => !r.ok)
  const state = {
    mounted: failed.length < results.length,
    target: canonical.target,
    hosts: results.map((r) => ({ id: r.id, ok: r.ok, path: r.path || '', error: r.error || '' })),
    entry: { command: canonical.command, args: canonical.args, env: canonical.env },
    updatedAt: new Date().toISOString(),
  }
  writeJson(statePath(env), state)
  return {
    ok: failed.length === 0,
    mounted: state.mounted,
    partial: failed.length > 0 && failed.length < results.length,
    target: canonical.target,
    hosts: state.hosts,
    entry: list.includes('dsh') ? (readJson(mcpFilePath(env), {}) || {}).mcpServers?.[SERVER_NAME] || null : null,
    error: failed.length ? failed.map((f) => f.id + ': ' + (f.error || '写入校验失败')).join('; ') : undefined,
  }
}

/**
 * 插件激活时的默认挂载：**只挂 dsh**，且已挂就不再动（幂等）。
 *
 * 为什么只挂 dsh：插件就是装在 DSH 里的，主宿主默认能用才符合直觉；
 * 而 Claude Code / Codex / Cursor / Windsurf 属于"用户自己另开的宿主"，
 * 它们的挂载必须由人显式决定（多库并存时最容易在这里串味）。
 *
 * @returns {{ok:boolean, skipped?:boolean, reason?:string, hosts?:object[], target?:object}}
 */
export function ensureDefaultMount({ packageRoot, vault = '', env = process.env } = {}) {
  try {
    if (String((env && env.MEMORY_MCP_AUTOMOUNT) || '') === '0') return { ok: true, skipped: true, reason: 'MEMORY_MCP_AUTOMOUNT=0' }
    const cur = getMount({ env, packageRoot })
    const dsh = (cur.hosts || []).find((h) => h.id === 'dsh')
    // 已挂且不漂移 → 什么都不做
    if (dsh && dsh.mounted && !cur.drift) return { ok: true, skipped: true, reason: 'already-mounted' }
    const out = mount({ target: { kind: 'local', vault: vault || '' }, packageRoot, env, hosts: 'dsh' })
    return out
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/** 卸载（幂等）。hosts 省略 = 从所有已挂载的宿主里摘掉。 */
export function unmount({ env = process.env, hosts = '' } = {}) {
  let list
  if (hosts) {
    try { list = parseHosts(Array.isArray(hosts) ? hosts.join(',') : hosts) } catch (e) { return { ok: false, error: String((e && e.message) || e) } }
  } else {
    list = hostMatrix(env).filter((h) => h.mounted).map((h) => h.id)
    if (!list.length) list = ['dsh']
  }
  const results = removeHosts(list, env)
  const removedAny = results.some((r) => r.removed)
  writeJson(statePath(env), { mounted: false, target: null, hosts: results.map((r) => ({ id: r.id, ok: r.ok, path: r.path || '' })), updatedAt: new Date().toISOString() })
  return { ok: results.every((r) => r.ok), mounted: false, removed: removedAny, hosts: results }
}
