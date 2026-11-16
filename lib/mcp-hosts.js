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
  note: 'Codex CLI 配置（[mcp_servers.memory-eternal]）',
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
    // 注意：TOML 基本字符串里反斜杠要写成 \\，所以不能拿原始路径直接 includes，
    // 必须比对**生成的那一行**（否则 Windows 路径永远校验失败，被当成写入失败）
    const cmdLine = 'command = ' + JSON.stringify(String(canonical.command))
    const ok = back.includes(`[mcp_servers.${SERVER_NAME}]`) && back.split('\n').some((l) => l.trim() === cmdLine)
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

// ── OpenClaw：JSON5 配置（mcp.servers.<name>）────────────────────────────────
// 官方位置：用户目录下 .openclaw/openclaw.json，格式是 JSON5（允许注释/尾逗号）。
// 我们**写标准 JSON**（JSON5 的超集，OpenClaw 照样读）；但**不解析**带注释的现有文件：
// 解析失败就拒绝改写并提示手填 —— 宁可少做一步，也不能把用户的注释整段抹掉。
const openclawAdapter = {
  id: 'openclaw',
  label: 'OpenClaw',
  format: 'json5',
  note: '配置在用户目录下 .openclaw/openclaw.json 的 mcp.servers（只增删自己那条）',
  pathOf: (env) => String((env && env.MEMORY_HOST_OPENCLAW_PATH) || '').trim() || path.join(homedir(env), '.openclaw', 'openclaw.json'),
  detect(env) {
    const p = this.pathOf(env)
    return { installed: fs.existsSync(p), path: p }
  },
  read(env) {
    const p = this.pathOf(env)
    const t = readText(p)
    if (t === null) return null
    let j
    try { j = JSON.parse(t) } catch { return { entry: null, path: p, reason: 'JSON5 含注释或尾逗号，自动挂载不改写' } }
    const entry = j && j.mcp && j.mcp.servers && j.mcp.servers[SERVER_NAME]
    return { entry: entry || null, path: p }
  },
  write(canonical, env) {
    const p = this.pathOf(env)
    const t = readText(p)
    let j = {}
    if (t !== null && t.trim()) {
      try { j = JSON.parse(t) } catch {
        return { ok: false, path: p, error: '配置文件是 JSON5（含注释或尾逗号），自动挂载不改写；按 docs/INTEGRATIONS.md 手填这一条' }
      }
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) j = {}
    if (!j.mcp || typeof j.mcp !== 'object') j.mcp = {}
    if (!j.mcp.servers || typeof j.mcp.servers !== 'object') j.mcp.servers = {}
    j.mcp.servers[SERVER_NAME] = { command: canonical.command, args: [...(canonical.args || [])], env: { ...(canonical.env || {}) } }
    writeFileAtomic(p, JSON.stringify(j, null, 2) + '\n')
    const back = readJson(p)
    const ok = !!(back && back.mcp && back.mcp.servers && back.mcp.servers[SERVER_NAME] && back.mcp.servers[SERVER_NAME].command === canonical.command)
    return { ok, path: p, verified: ok }
  },
  remove(env) {
    const p = this.pathOf(env)
    const t = readText(p)
    if (t === null) return { ok: true, removed: false, path: p }
    let j
    try { j = JSON.parse(t) } catch { return { ok: false, removed: false, path: p, error: 'JSON5 含注释，请手动删掉 mcp.servers.memory-eternal' } }
    if (!j || !j.mcp || !j.mcp.servers || !j.mcp.servers[SERVER_NAME]) return { ok: true, removed: false, path: p }
    delete j.mcp.servers[SERVER_NAME]
    writeFileAtomic(p, JSON.stringify(j, null, 2) + '\n')
    const back = readJson(p)
    return { ok: !(back && back.mcp && back.mcp.servers && back.mcp.servers[SERVER_NAME]), removed: true, path: p }
  },
}

// ── Hermes Agent：YAML 配置（mcp_servers.<name>）─────────────────────────────
// 不引 YAML 依赖，只做**块级文本编辑**：定位顶层 mcp_servers: 段 → 插入/替换/删除自己的子块，
// 其它键、注释、缩进风格原样保留。字符串统一用单引号（YAML 单引号内不解析反斜杠，Windows 路径原样安全）。
const yq = (s) => "'" + String(s).replace(/'/g, "''") + "'"

function yamlServerLines(canonical) {
  const out = ['  ' + SERVER_NAME + ':', '    command: ' + yq(canonical.command), '    args:']
  for (const a of canonical.args || []) out.push('    - ' + yq(a))
  const envs = Object.entries(canonical.env || {})
  if (envs.length) {
    out.push('    env:')
    for (const [k, v] of envs) out.push('      ' + k + ': ' + yq(v))
  }
  return out
}

/** 顶层 <section>: 段的行号区间；end 指向下一个顶层键或文件尾。 */
function yamlSectionRange(lines, section) {
  const re = new RegExp('^' + section + '\\s*:\\s*(\\{\\s*\\})?\\s*$')
  const start = lines.findIndex((l) => re.test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z0-9_.-]+\s*:/.test(lines[i])) { end = i; break }
  }
  return { start, end }
}

/** 找 <section> 段里的子键 <name>，返回其行区间（含缩进更深的续行）。 */
function findYamlChild(text, section, name) {
  const lines = String(text).split('\n')
  const r = yamlSectionRange(lines, section)
  if (!r) return null
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const child = new RegExp('^\\s+' + safe + '\\s*:')
  for (let i = r.start + 1; i < r.end; i++) {
    if (!child.test(lines[i])) continue
    const indent = (lines[i].match(/^\s*/) || [''])[0].length
    let j = i + 1
    while (j < r.end && (lines[j].trim() === '' || ((lines[j].match(/^\s*/) || [''])[0].length > indent))) j++
    return { lines, start: i, end: j, text: lines.slice(i, j).join('\n'), section: r }
  }
  return null
}

function upsertYamlServer(text, section, name, blockLines) {
  const lines = String(text).split('\n')
  const found = findYamlChild(text, section, name)
  if (found) return [...lines.slice(0, found.start), ...blockLines, ...lines.slice(found.end)].join('\n')
  const r = yamlSectionRange(lines, section)
  if (r) {
    // 段写成 mcp_servers: {} 时先把花括号换成真正的块头
    if (/\{/.test(lines[r.start])) lines[r.start] = section + ':'
    return [...lines.slice(0, r.end), ...blockLines, ...lines.slice(r.end)].join('\n')
  }
  const head = lines.join('\n').trimEnd()
  return (head ? head + '\n' : '') + section + ':\n' + blockLines.join('\n') + '\n'
}

function deleteYamlServer(text, section, name) {
  const found = findYamlChild(text, section, name)
  if (!found) return null
  const merged = [...found.lines.slice(0, found.start), ...found.lines.slice(found.end)]
  const r = yamlSectionRange(merged, section)
  if (r && r.end === r.start + 1) merged.splice(r.start, 1)   // 段里没别的子键了 → 连段头一起删
  return merged.join('\n')
}

const hermesAdapter = {
  id: 'hermes',
  label: 'Hermes Agent',
  format: 'yaml',
  note: '配置在用户目录下 .hermes/config.yaml 的 mcp_servers（块级编辑，注释与其它键不动）',
  pathOf: (env) => String((env && env.MEMORY_HOST_HERMES_PATH) || '').trim() || path.join(homedir(env), '.hermes', 'config.yaml'),
  detect(env) {
    const p = this.pathOf(env)
    return { installed: fs.existsSync(p), path: p }
  },
  read(env) {
    const p = this.pathOf(env)
    const t = readText(p)
    if (t === null) return null
    const m = findYamlChild(t, 'mcp_servers', SERVER_NAME)
    return { entry: m ? { raw: m.text.trim() } : null, path: p }
  },
  write(canonical, env) {
    const p = this.pathOf(env)
    const out = upsertYamlServer(readText(p) || '', 'mcp_servers', SERVER_NAME, yamlServerLines(canonical))
    writeFileAtomic(p, out)
    const back = readText(p) || ''
    const ok = Boolean(findYamlChild(back, 'mcp_servers', SERVER_NAME))
    return { ok, path: p, verified: ok }
  },
  remove(env) {
    const p = this.pathOf(env)
    const t = readText(p)
    if (t === null) return { ok: true, removed: false, path: p }
    const out = deleteYamlServer(t, 'mcp_servers', SERVER_NAME)
    if (out === null) return { ok: true, removed: false, path: p }
    writeFileAtomic(p, out)
    return { ok: !findYamlChild(readText(p) || '', 'mcp_servers', SERVER_NAME), removed: true, path: p }
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
    note: 'Claude Code 用户级配置（mcpServers）',
  }),
  project: (() => {
    const base = jsonAdapter({
      id: 'project',
      label: 'Claude 项目级 .mcp.json',
      file: (env) => String((env && env.MEMORY_HOST_PROJECT_PATH) || '').trim() || path.join(process.cwd(), '.mcp.json'),
      note: '仓库根的 .mcp.json（随项目走，团队共享时慎用）',
    })
    // 独立 web / 常驻进程的 cwd 往往是 ~/.dsh/profiles/web 这类目录 ——
    // 它没有 package.json / .git，却会被当成"仓库根"，于是面板上显示一个假的 .mcp.json 路径。
    // 只有真的像项目目录时才认为这个宿主可用。
    const looksLikeProject = (dir) => {
      for (const marker of ['package.json', '.git', '.mcp.json']) {
        try { if (fs.existsSync(path.join(dir, marker))) return true } catch { /* 忽略 */ }
      }
      return false
    }
    return {
      ...base,
      detect(env) {
        const p = base.pathOf(env)
        const dir = path.dirname(p)
        const explicit = String((env && env.MEMORY_HOST_PROJECT_PATH) || '').trim()
        const installed = explicit ? fs.existsSync(p) : looksLikeProject(dir)
        return { installed, path: p }
      },
    }
  })(),
  cursor: jsonAdapter({
    id: 'cursor',
    label: 'Cursor',
    file: (env) => String((env && env.MEMORY_HOST_CURSOR_PATH) || '').trim() || path.join(homedir(env), '.cursor', 'mcp.json'),
    note: 'Cursor 用户级 MCP 配置',
  }),
  windsurf: jsonAdapter({
    id: 'windsurf',
    label: 'Windsurf',
    file: (env) => String((env && env.MEMORY_HOST_WINDSURF_PATH) || '').trim() || path.join(homedir(env), '.codeium', 'windsurf', 'mcp_config.json'),
    note: 'Windsurf 用户级 MCP 配置',
  }),
  codex: codexAdapter,
  openclaw: openclawAdapter,
  hermes: hermesAdapter,
  // MengBot 的 MCP 主路径在应用内「设置 → MCP 服务器」，没有可安全改写的用户级 JSON；
  // 次路径是机器人项目里的 .mcp.json（Claude/Codex 引擎都吃）。设 MEMORY_HOST_MENGBOT_PROJECT
  // 指向 bot 项目根即可自动挂载；没设就视为未安装（不虚构一个不存在的路径）。
  mengbot: (() => {
    const base = jsonAdapter({
      id: 'mengbot',
      label: 'MengBot（机器人项目）',
      file: (env) => {
        const proj = String((env && env.MEMORY_HOST_MENGBOT_PROJECT) || '').trim()
        return proj ? path.join(proj, '.mcp.json') : path.join(homedir(env), '.mengbot', 'project', '.mcp.json')
      },
      note: 'MengBot 挂在应用内「设置 → MCP 服务器」或机器人项目 .mcp.json（设项目根后自动挂载写后者）',
    })
    return {
      ...base,
      detect(env) {
        const proj = String((env && env.MEMORY_HOST_MENGBOT_PROJECT) || '').trim()
        const p = base.pathOf(env)
        return { installed: Boolean(proj) || fs.existsSync(p), path: p }
      },
    }
  })(),
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

/** Windows 上把路径统一成反斜杠绝对路径（不同宿主对正斜杠的容忍度不一致）。 */
function normPath(p, env) {
  const v = String(p || '')
  if (!v || process.platform !== 'win32' || v === 'node') return v
  if (!/^([a-zA-Z]:[\/]|\\|\/)/.test(v)) return v   // 相对路径/裸名原样
  return v.replace(/\//g, '\\')
}

/** 条目写盘前做一次收敛：command/args 归一 + 记录是否可执行。 */
export function normalizeEntry(canonical, env = process.env) {
  const out = { ...canonical }
  out.command = normPath(canonical.command, env)
  out.args = (canonical.args || []).map((a, i) => (i === 0 ? normPath(a, env) : a))
  const cmdOk = out.command === 'node' ? true : (() => { try { return fs.statSync(out.command).isFile() } catch { return false } })()
  const scriptOk = (() => { try { return fs.statSync(out.args[0]).isFile() } catch { return false } })()
  return { entry: out, cmdOk, scriptOk }
}

/** 把 canonical 条目写进指定宿主。 */
export function writeHosts(canonical, hosts = ['dsh'], env = process.env) {
  const { entry: canon, cmdOk, scriptOk } = normalizeEntry(canonical, env)
  const results = []
  if (!scriptOk) {
    // 脚本都不在，写进去也是死条目（Windows 上就表现为"无法识别"）——直接拒绝，别留坑
    return hosts.map((id) => ({ id, ok: false, error: '插件脚本不存在：' + String(canonical.args && canonical.args[0]) + '（重新安装插件后再挂载）' }))
  }
  for (const id of hosts) {
    const h = HOSTS[id]
    if (!h) { results.push({ id, ok: false, error: '未知宿主' }); continue }
    try {
      const r = h.write(canon, env)
      results.push({ id, ...r, cmdOk, scriptOk })
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
