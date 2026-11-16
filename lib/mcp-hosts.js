// 统一 MCP 挂载标准：一处声明（canonical 条目）→ 多个宿主 adapter 各自渲染。
//
// 为什么要这层：每个 Agent 宿主的 MCP 配置格式与位置都不一样 ——
//   DSH          ~/.dsh/mcp-servers.json          { mcpServers: { name: { command, args, env } } }
//   Claude Code  ~/.claude.json（顶层）            { mcpServers: { name: {...} } }
//   Claude 项目   <repo>/.mcp.json                { mcpServers: { name: {...} } }
//   Cursor       ~/.cursor/mcp.json               { mcpServers: { name: {...} } }
//   Windsurf     ~/.codeium/windsurf/mcp_config.json  { mcpServers: { name: {...} } }
//   Codex        ~/.codex/config.toml             [mcp_servers.<name>] command/args/env
//
// 统一口径（本文件即标准）：
//   1) **单一事实源**：目标/命令/环境只在我们自己的挂载状态里声明一次，宿主配置只是投影；
//   2) **名字固定** `memory-eternal`，同一时刻只允许一个目标（多库并存时串味的根源）；
//   3) **只用 stdio**（command + args），命令与脚本一律**绝对路径**，参数走 env，不依赖宿主的 cwd/shell；
//   4) **幂等 + 不越界**：只增删自己这一条，别人的条目原样保留；
//   5) **写前备份、写后回读校验**，失败就还原；
//   6) **默认不挂载**：必须人在面板/CLI 里显式执行（见 lib/mcp-mount.js）；
//   7) **漂移检测**：记录写入时的 args/版本，status 里能看出"宿主里那条是不是过期的"。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const SERVER_NAME = 'memory-eternal'

const homedir = (env) => String((env && (env.MEMORY_HOST_HOME || env.HOME || env.USERPROFILE)) || '').trim() || os.homedir()
const readText = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } }
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

function writeFileAtomic(p, text, { backup = true } = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  if (backup && fs.existsSync(p)) {
    try { fs.copyFileSync(p, p + '.bak-mem') } catch { /* 备份失败不阻断 */ }
  }
  const tmp = p + '.tmp-' + process.pid
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, p)
}

// ── adapter 基类（JSON 形态的宿主共用一套实现）──────────────────────────────
function jsonAdapter({ id, label, file, nested = false, note = '' }) {
  return {
    id,
    label,
    note,
    format: 'json',
    pathOf: (env) => file(env),
    detect(env) {
      const p = this.pathOf(env)
      return { installed: fs.existsSync(p), path: p }
    },
    read(env) {
      const p = this.pathOf(env)
      const j = readJson(p)
      if (!j) return null
      const bag = nested ? (j.projects ? null : j) : j
      const entry = bag && bag.mcpServers && bag.mcpServers[SERVER_NAME]
      return entry ? { entry, path: p } : { entry: null, path: p }
    },
    write(canonical, env) {
      const p = this.pathOf(env)
      const j = readJson(p) || (nested ? {} : {})
      if (!j.mcpServers || typeof j.mcpServers !== 'object') j.mcpServers = {}
      j.mcpServers[SERVER_NAME] = {
        command: canonical.command,
        args: [...canonical.args],
        env: { ...(canonical.env || {}) },
      }
      writeFileAtomic(p, JSON.stringify(j, null, 2) + '\n')
      const back = readJson(p)
      const ok = !!(back && back.mcpServers && back.mcpServers[SERVER_NAME] && back.mcpServers[SERVER_NAME].command === canonical.command)
      return { ok, path: p, verified: ok }
    },
    remove(env) {
      const p = this.pathOf(env)
      const j = readJson(p)
      if (!j || !j.mcpServers || !j.mcpServers[SERVER_NAME]) return { ok: true, removed: false, path: p }
      delete j.mcpServers[SERVER_NAME]
      writeFileAtomic(p, JSON.stringify(j, null, 2) + '\n')
      const back = readJson(p)
      const gone = !(back && back.mcpServers && back.mcpServers[SERVER_NAME])
      return { ok: gone, removed: true, path: p }
    },
  }
}

// ── Codex：TOML 的最小文本写入（不引第三方库）───────────────────────────────

/**
 * 找 [mcp_servers.memory-eternal] 这一段的 [start, end)。
 * 不能用 /\Z/：那是 PCRE 语法，JS 里会被当成字面量 Z，导致块在文件末尾时匹配不到
 * （踩过：第一次写成功、第二次变成追加，最后文件里出现两个同名块）。
 */
function findBlock(text) {
  const header = '[mcp_servers.memory-eternal]'
  const start = text.indexOf(header)
  if (start < 0) return null
  const nextSection = text.indexOf('\n[', start + header.length)
  const end = nextSection < 0 ? text.length : nextSection + 1
  return { start, end }
}

function tomlBlock(canonical) {
  const q = (s) => JSON.stringify(String(s))
  const args = (canonical.args || []).map((a) => q(a)).join(', ')
  const envs = Object.entries(canonical.env || {}).map(([k, v]) => `${k} = ${q(v)}`).join(', ')
  return `[mcp_servers.${SERVER_NAME}]\ncommand = ${q(canonical.command)}\nargs = [${args}]\n` +
    (envs ? `env = { ${envs} }\n` : '')
}

const codexAdapter = {
  id: 'codex',
  label: 'Codex CLI',
  format: 'toml',
  note: '~/.codex/config.toml 里的 [mcp_servers.memory-eternal]',
  pathOf: (env) => String((env && env.MEMORY_HOST_CODEX_PATH) || '').trim() || path.join(homedir(env), '.codex', 'config.toml'),
  detect(env) {
    const p = this.pathOf(env)
    return { installed: fs.existsSync(p) || fs.existsSync(path.dirname(p)), path: p }
  },
  read(env) {
    const p = this.pathOf(env)
    const t = readText(p)
    if (t === null) return null
    const b = findBlock(t)
    return { entry: b ? { raw: t.slice(b.start, b.end).trim() } : null, path: p }
  },
  write(canonical, env) {
    const p = this.pathOf(env)
    const t = readText(p) || ''
    const block = tomlBlock(canonical)
    const b = findBlock(t)
    const out = b
      ? t.slice(0, b.start) + block + t.slice(b.end)
      : (t.trimEnd() ? t.trimEnd() + '\n\n' + block : block)
    writeFileAtomic(p, out)
    const back = readText(p) || ''
    const ok = back.includes(`[mcp_servers.${SERVER_NAME}]`) && back.includes(canonical.command)
    return { ok, path: p, verified: ok }
  },
  remove(env) {
    const p = this.pathOf(env)
    const t = readText(p)
    const b = t === null ? null : findBlock(t)
    if (!b) return { ok: true, removed: false, path: p }
    const out = (t.slice(0, b.start) + t.slice(b.end)).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
    writeFileAtomic(p, out)
    const back = readText(p) || ''
    return { ok: !back.includes(`[mcp_servers.${SERVER_NAME}]`), removed: true, path: p }
  },
}

// ── 注册表 ────────────────────────────────────────────────────────────────
export const HOSTS = {
  dsh: jsonAdapter({
    id: 'dsh',
    label: 'DeepSeek Harness (DSH)',
    file: (env) => String((env && env.DSH_HOME) || '').trim() && path.join(String(env.DSH_HOME).trim(), 'mcp-servers.json') || path.join(os.homedir(), '.dsh', 'mcp-servers.json'),
    note: 'DSH 面板里"Agent 能不能看见记忆"就看这里',
  }),
  claude: jsonAdapter({
    id: 'claude',
    label: 'Claude Code',
    file: (env) => String((env && env.MEMORY_HOST_CLAUDE_PATH) || '').trim() || path.join(homedir(env), '.claude.json'),
    note: '~/.claude.json 顶层 mcpServers',
  }),
  project: jsonAdapter({
    id: 'project',
    label: 'Claude 项目级 .mcp.json',
    file: (env) => String((env && env.MEMORY_HOST_PROJECT_PATH) || '').trim() || path.join(process.cwd(), '.mcp.json'),
    note: '仓库根 .mcp.json（随项目走，团队共享时慎用）',
  }),
  cursor: jsonAdapter({
    id: 'cursor',
    label: 'Cursor',
    file: (env) => String((env && env.MEMORY_HOST_CURSOR_PATH) || '').trim() || path.join(homedir(env), '.cursor', 'mcp.json'),
    note: '~/.cursor/mcp.json',
  }),
  windsurf: jsonAdapter({
    id: 'windsurf',
    label: 'Windsurf',
    file: (env) => String((env && env.MEMORY_HOST_WINDSURF_PATH) || '').trim() || path.join(homedir(env), '.codeium', 'windsurf', 'mcp_config.json'),
    note: '~/.codeium/windsurf/mcp_config.json',
  }),
  codex: codexAdapter,
}

/** 支持的宿主 id（含别名）。 */
export function parseHosts(input) {
  const raw = String(input || '').trim().toLowerCase()
  if (!raw || raw === 'dsh') return ['dsh']
  if (raw === 'all') return Object.keys(HOSTS)
  const list = raw.split(/[,\s]+/).filter(Boolean)
  const out = []
  for (const id of list) {
    const key = id === 'claude-code' ? 'claude' : id === 'claude-project' ? 'project' : id
    if (!HOSTS[key]) throw new Error('不认识的宿主：' + id + '（可选 ' + Object.keys(HOSTS).join(' / ') + ' / all）')
    if (!out.includes(key)) out.push(key)
  }
  return out
}

/** 每个宿主的挂载现状（矩阵）。 */
export function hostMatrix(env = process.env) {
  const out = []
  for (const h of Object.values(HOSTS)) {
    const det = h.detect(env)
    let entry = null
    if (det.installed) {
      const r = h.read(env)
      entry = r ? r.entry : null
    }
    out.push({ id: h.id, label: h.label, note: h.note, format: h.format, path: det.path, installed: det.installed, mounted: !!entry, entry })
  }
  return out
}

/** 把 canonical 条目写进指定宿主。 */
export function writeHosts(canonical, hosts = ['dsh'], env = process.env) {
  const results = []
  for (const id of hosts) {
    const h = HOSTS[id]
    if (!h) { results.push({ id, ok: false, error: '未知宿主' }); continue }
    try {
      const r = h.write(canonical, env)
      results.push({ id, ...r })
    } catch (e) {
      results.push({ id, ok: false, error: String((e && e.message) || e) })
    }
  }
  return results
}

/** 从指定宿主移除（幂等）。 */
export function removeHosts(hosts = ['dsh'], env = process.env) {
  const results = []
  for (const id of hosts) {
    const h = HOSTS[id]
    if (!h) { results.push({ id, ok: false, error: '未知宿主' }); continue }
    try { results.push({ id, ...h.remove(env) }) } catch (e) { results.push({ id, ok: false, error: String((e && e.message) || e) }) }
  }
  return results
}
