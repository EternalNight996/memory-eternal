// 记忆核心 · 一键自动挂载器。
//
// 安装/激活时自动检测本机已装的 MCP 宿主（Claude Code / Codex CLI / Cursor），
// 幂等写入各自 MCP 配置，指向本包 bin/dsh-memory.mjs —— 实现「装完即用」。
//
// 安全约定：
// - 幂等：目标配置已存在且内容一致 → 跳过；不一致 → 先备份（.memory-eternal-bak-<ts>）再覆盖
// - 透明：每一步动作输出到 stdout
// - 逃生：环境变量 MEMORY_ETERNAL_SKIP_AUTO=1 或 opts.enabled=false 时完全不动外部文件
// - 只碰自己的键（mcpServers.memory / hooks 里 id 标记的条目），不改其他内容

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PACKAGE_ROOT = path.join(__dirname, '..')
export const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'dsh-memory.mjs')

const home = os.homedir()
const appdataDir = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')

/** 从 MCP 客户端 JSON 配置里列出 server 名（兼容 mcpServers 与 VS Code 的 servers 两种键名）。 */
function listMcpServers(cfg, keys = ['mcpServers', 'servers']) {
  if (!cfg || typeof cfg !== 'object') return []
  for (const k of keys) {
    const v = cfg[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v)
  }
  return []
}

/** 从 codex config.toml 里列出所有 [mcp_servers.<name>] 的 name（跳过 .env 这类二级段）。 */
function listCodexMcpServers(text) {
  const names = []
  for (const m of String(text || '').matchAll(/^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/gm)) names.push(m[1])
  return [...new Set(names)]
}

/**
 * 只读兼容性探测清单：除可一键挂载的 claude-code / codex / cursor 之外，
 * 自动识别本机常见的 MCP 客户端（存在配置文件才列出），并列出它们已配置的 MCP server。
 * detectedOnly = 只展示，不提供安装/卸载按钮（不改不认识的配置格式）。
 */
const DETECT_ONLY_CLIENTS = [
  { name: 'gemini-cli', label: 'Gemini CLI', paths: () => [path.join(home, '.gemini', 'settings.json')] },
  { name: 'windsurf', label: 'Windsurf', paths: () => [path.join(home, '.codeium', 'windsurf', 'mcp_config.json')] },
  { name: 'cline', label: 'Cline', paths: () => [
    path.join(appdataDir, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    path.join(appdataDir, 'Cursor', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
  ] },
  { name: 'vscode', label: 'VS Code', paths: () => [path.join(appdataDir, 'Code', 'User', 'mcp.json')], keys: ['servers'] },
]

async function exists(p) {
  try { await fs.access(p); return true } catch { return false }
}

async function backupOnce(file) {
  const bak = `${file}.memory-eternal-bak-${Date.now()}`
  await fs.copyFile(file, bak)
  return bak
}

export function mcpCommand(nodePath = process.execPath) {
  return { command: nodePath, args: [BIN_PATH, 'mcp'] }
}

function sameMcpEntry(existing, want) {
  if (!existing || typeof existing !== 'object') return false
  if (existing.type === 'stdio' || existing.type === undefined) {
    return existing.command === want.command
      && JSON.stringify(existing.args ?? []) === JSON.stringify(want.args)
  }
  return false
}

// 是否已写入我们（capture.mjs）的会话结束 hook。
// marker 用于区分宿主：codex 走 hooks.json 的 Stop；cursor 走 hooks.json 的 stop/sessionEnd。
async function hookState(hooksJson, agent, cursorStyle = false) {
  try {
    const cfg = JSON.parse(await fs.readFile(hooksJson, 'utf8'))
    const hooks = cfg.hooks || {}
    // 遍历所有事件下命令里是否含 capture.mjs
    const all = Object.values(hooks)
    for (const arr of all) {
      if (!Array.isArray(arr)) continue
      for (const h of arr) {
        const cmd = typeof h === 'object' ? (h.command || h.hooks?.map((x) => x.command).join(' ')) : String(h)
        if (cmd && cmd.includes('capture.mjs')) return 'configured'
      }
    }
    return 'missing'
  } catch {
    return 'missing'
  }
}

// -- Claude Code：~/.claude.json 的 mcpServers + ~/.claude/settings.json 的 hooks --

export async function setupClaude({ nodePath, withHooks = true, dryRun = false, log = () => {} } = {}) {
  const results = []
  const claudeJson = path.join(home, '.claude.json')
  if (await exists(claudeJson)) {
    const want = mcpCommand(nodePath)
    let cfg
    try { cfg = JSON.parse(await fs.readFile(claudeJson, 'utf8')) } catch { cfg = null }
    if (cfg && typeof cfg === 'object') {
      cfg.mcpServers = cfg.mcpServers ?? {}
      if (sameMcpEntry(cfg.mcpServers.memory, want)) {
        log('✓ Claude Code MCP 已是最新，跳过')
      } else if (!dryRun) {
        if (cfg.mcpServers.memory) await backupOnce(claudeJson)
        cfg.mcpServers.memory = { type: 'stdio', ...want }
        await fs.writeFile(claudeJson, JSON.stringify(cfg, null, 2), 'utf8')
        log('✓ Claude Code MCP 已写入 ~/.claude.json')
      } else {
        log('[dry-run] 将写入 Claude Code MCP ~/.claude.json')
      }
      results.push({ agent: 'claude-code', ok: true })
    }
  } else {
    log('✗ 未检测到 Claude Code（~/.claude.json 不存在）')
    results.push({ agent: 'claude-code', ok: false, reason: 'not installed' })
  }

  if (withHooks) results.push(await setupClaudeHooks({ nodePath, dryRun, log }))
  return results
}

async function setupClaudeHooks({ nodePath, dryRun, log }) {
  const hookScript = path.join(PACKAGE_ROOT, 'hooks', 'capture.mjs')
  const guardScript = path.join(PACKAGE_ROOT, 'hooks', 'secret-guard.mjs')
  if (!(await exists(hookScript))) {
    log('✗ hooks/capture.mjs 缺失，跳过 hooks')
    return { agent: 'claude-hooks', ok: false, reason: 'hook script missing' }
  }
  const settingsJson = path.join(home, '.claude', 'settings.json')
  let cfg = {}
  if (await exists(settingsJson)) {
    try { cfg = JSON.parse(await fs.readFile(settingsJson, 'utf8')) } catch { cfg = {} }
  }
  cfg.hooks = cfg.hooks ?? {}
  const written = []
  let changed = false

  // ① SessionEnd：会话结束自动沉淀
  const want = {
    matcher: '',
    hooks: [{ type: 'command', command: `${JSON.stringify(nodePath)} ${JSON.stringify(hookScript)} claude` }],
  }
  const hookKey = 'SessionEnd'
  cfg.hooks[hookKey] = Array.isArray(cfg.hooks[hookKey]) ? cfg.hooks[hookKey] : []
  const existingCapture = cfg.hooks[hookKey].find((h) => h?.hooks?.some((c) => c?.command?.includes('capture.mjs')))
  if (existingCapture) {
    // 已存在也要核对**路径**：插件可能换了安装副本（web profile → desktop profile、
    // 或 npm 版本装到别处），旧实现只判「有没有 capture.mjs」就跳过，于是 hook 永远
    // 指着那个旧副本（本机实测：Claude Code 一直在跑 web profile 的 0.9.23）。
    // 与 Codex 分支同样的口径：只重写自己那条命令，其它 hook 一律不动。
    const wanted = `${JSON.stringify(nodePath)} ${JSON.stringify(hookScript)} claude`
    let rewrote = false
    for (const c of existingCapture.hooks ?? []) {
      if (typeof c?.command === 'string' && c.command.includes('capture.mjs') && c.command !== wanted) {
        c.command = wanted
        rewrote = true
      }
    }
    if (rewrote) {
      written.push(hookKey + '(path)')
      changed = true
      log('↻ Claude Code SessionEnd hook 路径已更新为当前副本')
    } else {
      log('✓ Claude Code SessionEnd hook 已存在，跳过')
    }
  } else {
    cfg.hooks[hookKey].push(want)
    written.push(hookKey)
    changed = true
  }

  // ② PreToolUse：凭据读取守卫（拒读 .credentials.yaml / .env / *-token，指路 secrets 加载器）。
  // 没装守卫脚本就跳过 —— 老版本插件目录里没有这个文件，不能凭空注册一个不存在的命令。
  if (await exists(guardScript)) {
    const guardKey = 'PreToolUse'
    cfg.hooks[guardKey] = Array.isArray(cfg.hooks[guardKey]) ? cfg.hooks[guardKey] : []
    if (cfg.hooks[guardKey].some((h) => h?.hooks?.some((c) => c?.command?.includes('secret-guard.mjs')))) {
      log('✓ Claude Code PreToolUse 凭据守卫已存在，跳过')
    } else {
      // 只追加一个独立条目，保留用户已有的 PreToolUse 配置
      cfg.hooks[guardKey].push({
        matcher: 'Read|Bash|Grep|Glob',
        hooks: [{ type: 'command', command: `${JSON.stringify(nodePath)} ${JSON.stringify(guardScript)}` }],
      })
      written.push(guardKey)
      changed = true
    }
  }

  if (!changed) return { agent: 'claude-hooks', ok: true }
  if (!dryRun) {
    if (Object.keys(cfg).length > 0) await backupOnce(settingsJson).catch(() => {})
    await fs.mkdir(path.dirname(settingsJson), { recursive: true })
    await fs.writeFile(settingsJson, JSON.stringify(cfg, null, 2), 'utf8')
    log('✓ Claude Code hooks 已写入 ~/.claude/settings.json：' + written.join(' / '))
  } else {
    log('[dry-run] 将写入 Claude Code hooks：' + written.join(' / '))
  }
  return { agent: 'claude-hooks', ok: true }
}

// -- Codex CLI：~/.codex/config.toml 的 [mcp_servers.memory] --

/**
 * 纯函数：从 codex 的 config.toml 里解析 `[mcp_servers.memory]` 段（issue #44）。
 *
 * 三个坑都在这一个函数里收口：
 *   ① 必须**按段**解析 —— 否则会抓到别的 server 的第一个 `command =`（本机真实踩到：读成了 MCP_DOCKER 的 docker.exe）；
 *   ② 单引号是合法 TOML（codex 自己写的就是 'C:\…'）；
 *   ③ 双引号串里的 \\ 是转义，读出来要反转义，否则与当前路径永远不相等。
 */
export function parseCodexMemoryEntry(text) {
  const src = String(text || '')
  const present = /^\s*\[mcp_servers\.memory\]\s*$/m.test(src)
  if (!present) return { present: false, command: '', args: [] }
  const lines = src.split(/\r?\n/)
  let inSec = false
  const sec = []
  for (const line of lines) {
    if (/^\s*\[/.test(line)) { inSec = /^\s*\[mcp_servers\.memory\]\s*$/.test(line.trim()); continue }
    if (inSec) sec.push(line)
  }
  const body = sec.join('\n')
  const unesc = (s) => String(s || '').replace(/\\\\/g, '\\')
  const cmd = /command\s*=\s*["']([^"']+)["']/.exec(body)
  let args = []
  const argsLine = /^\s*args\s*=\s*\[([^\]]*)\]\s*$/m.exec(body)
  if (argsLine) {
    for (const m of argsLine[1].matchAll(/["']([^"']+)["']/g)) args.push(unesc(m[1]))
  }
  return { present: true, command: cmd ? unesc(cmd[1]) : '', args }
}

/**
 * 纯函数：把 `[mcp_servers.memory]` 段对齐到 want（只动这一段的两行）。
 * @returns {{text:string, changed:boolean}}
 */
export function alignCodexMemorySection(text, want) {
  const lines = String(text || '').split(/\r?\n/)
  let inSec = false
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { inSec = /^\s*\[mcp_servers\.memory\]\s*$/.test(lines[i].trim()); continue }
    if (!inSec) continue
    // 只在**真的不同**时才算改动（幂等：已经是目标形态就不该报 changed，否则每次 setup 都像改过）
    const wantCmd = 'command = ' + JSON.stringify(want.command)
    const wantArgs = 'args = ' + JSON.stringify(want.args)
    if (/^\s*command\s*=/.test(lines[i])) { if (lines[i] !== wantCmd) { lines[i] = wantCmd; changed = true } }
    else if (/^\s*args\s*=/.test(lines[i])) { if (lines[i] !== wantArgs) { lines[i] = wantArgs; changed = true } }
  }
  return { text: changed ? lines.join('\n') : String(text || ''), changed }
}

export async function setupCodex({ nodePath, dryRun = false, log = () => {} } = {}) {
  const codexToml = path.join(home, '.codex', 'config.toml')
  if (!(await exists(codexToml))) {
    log('✗ 未检测到 Codex CLI（~/.codex/config.toml 不存在）')
    return [{ agent: 'codex', ok: false, reason: 'not installed' }]
  }
  const want = mcpCommand(nodePath)
  const text = await fs.readFile(codexToml, 'utf8')
  const sectionRe = /^\[mcp_servers\.memory\]$/m
  if (sectionRe.test(text)) {
    // 已存在：把这一节**整块**对齐到当前版本写出的形态。
    // issue #44 现场的教训：TOML 里可能是**单引号**（`command = 'C:\…'`），老代码只认双引号 →
    // 既读不到（status 报「配置里是 (空)」）也改不掉（`replace` 不命中），**却照样打印「已更新」**。
    // 所以：① 读写都认两种引号；② 改完必须**校验文本真的变了**，没变就如实报失败。
    const curCmd = /command\s*=\s*["']([^"']*)["']/.exec(text)?.[1] || ''
    const curArgs = /^args\s*=\s*\[([^\]]*)\]\s*$/m.exec(text)?.[1] || ''
    const argsOk = want.args.every((a) => curArgs.includes(JSON.stringify(a)) || curArgs.includes("'" + a + "'"))
    if (curCmd === want.command && argsOk) {
      log('✓ Codex MCP 已是最新，跳过')
      return [{ agent: 'codex', ok: true, reason: 'section exists' }]
    }
    // 只改 `[mcp_servers.memory]` 这一段（按行扫描，避免误伤别的 server 的同名字段）
    const { text: newText, changed } = alignCodexMemorySection(text, want)
    if (changed && !dryRun) {
      await backupOnce(codexToml)
      await fs.writeFile(codexToml, newText, 'utf8')
      log(`✓ Codex MCP 已对齐到当前 node / 脚本：${want.command} ${want.args.join(' ')}`)
    } else if (dryRun) {
      log('[dry-run] 将更新 Codex MCP 的 command/args')
    }
    if (!changed) {
      log('✗ Codex MCP 条目存在但没找到可改写的 command/args 行 —— 请手工检查 ~/.codex/config.toml')
      return [{ agent: 'codex', ok: false, reason: 'section unparseable' }]
    }
    return [{ agent: 'codex', ok: true, reason: changed ? 'aligned' : 'section exists' }]
  }
  const block = [
    '',
    '# memory-eternal（自动写入；移除可运行 dsh-memory setup --codex-only --remove）',
    '[mcp_servers.memory]',
    `command = ${JSON.stringify(want.command)}`,
    `args = ${JSON.stringify(want.args)}`,
    '',
  ].join('\n')
  if (!dryRun) {
    await backupOnce(codexToml)
    await fs.writeFile(codexToml, text.replace(/\s*$/, '\n') + block, 'utf8')
    log('✓ Codex MCP 已写入 ~/.codex/config.toml')
  } else {
    log('[dry-run] 将写入 Codex MCP ~/.codex/config.toml')
  }
  return [{ agent: 'codex', ok: true }]
}

// -- Cursor：~/.cursor/mcp.json --

export async function setupCursor({ nodePath, dryRun = false, log = () => {} } = {}) {
  const cursorJson = path.join(home, '.cursor', 'mcp.json')
  let cfg = { mcpServers: {} }
  if (await exists(cursorJson)) {
    try { cfg = JSON.parse(await fs.readFile(cursorJson, 'utf8')) } catch {
      log('✗ ~/.cursor/mcp.json 解析失败，跳过')
      return [{ agent: 'cursor', ok: false, reason: 'parse error' }]
    }
  } else {
    // Cursor 目录不存在 = 未安装（保守判断：只报提示，不写文件）
    const cursorDir = path.join(home, '.cursor')
    if (!(await exists(cursorDir))) {
      log('✗ 未检测到 Cursor（~/.cursor 不存在）')
      return [{ agent: 'cursor', ok: false, reason: 'not installed' }]
    }
  }
  const want = mcpCommand(nodePath)
  cfg.mcpServers = cfg.mcpServers ?? {}
  if (sameMcpEntry(cfg.mcpServers.memory, want)) {
    log('✓ Cursor MCP 已是最新，跳过')
    return [{ agent: 'cursor', ok: true }]
  }
  if (!dryRun) {
    if (await exists(cursorJson)) await backupOnce(cursorJson)
    cfg.mcpServers.memory = want
    await fs.mkdir(path.dirname(cursorJson), { recursive: true })
    await fs.writeFile(cursorJson, JSON.stringify(cfg, null, 2), 'utf8')
    log('✓ Cursor MCP 已写入 ~/.cursor/mcp.json')
  } else {
    log('[dry-run] 将写入 Cursor MCP ~/.cursor/mcp.json')
  }
  return [{ agent: 'cursor', ok: true }]
}

// -- 总入口 -------------------------------------------------------------------

export async function runSetup(opts = {}) {
  const {
    only = [],          // ['claude','codex','cursor']；空 = 全部
    withHooks = true,
    dryRun = false,
    log = (m) => console.log(m),
    enabled = process.env.MEMORY_ETERNAL_SKIP_AUTO !== '1',
  } = opts
  if (!enabled) {
    log('⏭ MEMORY_ETERNAL_SKIP_AUTO=1，跳过自动挂载')
    return { ok: true, results: [] }
  }
  const all = []
  const want = (name) => only.length === 0 || only.includes(name)
  if (want('claude')) all.push(...await setupClaude({ nodePath: process.execPath, withHooks, dryRun, log }))
  if (want('codex')) all.push(...await setupCodex({ nodePath: process.execPath, dryRun, log }))
  if (want('cursor')) all.push(...await setupCursor({ nodePath: process.execPath, dryRun, log }))
  return { ok: true, results: all }
}

/**
 * 只读查询各 agent 的 MCP 配置状态。不修改任何文件。
 * @returns {Promise<{ok:true, agents: Array, lastCheckedAt: number}>}
 */
export async function getSetupStatus({ nodePath = process.execPath } = {}) {
  const agents = []
  const want = mcpCommand(nodePath)
  // claude-code
  const claudeJson = path.join(home, '.claude.json')
  if (!(await exists(claudeJson))) {
    agents.push({ name: 'claude-code', label: 'Claude Code', compat: 'managed', installed: false, mcpConfigured: false, hook: 'unknown', servers: [] })
  } else {
    let cfg = null
    try { cfg = JSON.parse(await fs.readFile(claudeJson, 'utf8')) } catch {}
    const entry = cfg?.mcpServers?.memory
    const mcpExists = !!entry
    agents.push({
      name: 'claude-code',
      label: 'Claude Code',
      compat: 'managed',
      servers: listMcpServers(cfg),
      installed: true,
      mcpConfigured: mcpExists,
      mcpMatchesCurrentNode: mcpExists && sameMcpEntry(entry, want),
      currentNodePath: nodePath,
      configuredNodePath: entry?.command || '',
      mcpPath: claudeJson,
    })
    // hook
    const settingsJson = path.join(home, '.claude', 'settings.json')
    if (await exists(settingsJson)) {
      try {
        const scfg = JSON.parse(await fs.readFile(settingsJson, 'utf8'))
        const list = scfg?.hooks?.SessionEnd || []
        const has = list.some((h) => h?.hooks?.some((c) => c?.command?.includes('capture.mjs')))
        agents[agents.length - 1].hook = has ? 'configured' : 'missing'
      } catch { agents[agents.length - 1].hook = 'unknown' }
    } else {
      agents[agents.length - 1].hook = 'missing'
    }
  }
  // codex
  const codexToml = path.join(home, '.codex', 'config.toml')
  if (!(await exists(codexToml))) {
    agents.push({ name: 'codex', label: 'Codex CLI / Desktop', compat: 'managed', installed: false, mcpConfigured: false, servers: [] })
  } else {
    const text = await fs.readFile(codexToml, 'utf8')
    const has = /^\[mcp_servers\.memory\]$/m.test(text)
    let configuredNodePath = ''
    // 必须**先切出 [mcp_servers.memory] 这一段**再读 command —— 否则会抓到别的 server 的
    // 第一个 `command =`（本机真实踩到：读成了 MCP_DOCKER 的 docker.exe）。
    // 另外：单引号也是合法 TOML（codex 自己写的就是 'C:\…'）；双引号串里的 \\ 是转义，读出来要反转义。
    if (has) configuredNodePath = parseCodexMemoryEntry(text).command
    agents.push({
      name: 'codex',
      label: 'Codex CLI / Desktop',
      compat: 'managed',
      servers: listCodexMcpServers(text),
      installed: true,
      mcpConfigured: has,
      mcpMatchesCurrentNode: has && configuredNodePath === nodePath,
      currentNodePath: nodePath,
      configuredNodePath,
      mcpPath: codexToml,
      hook: await hookState(path.join(home, '.codex', 'hooks.json'), 'codex'),
    })
  }
  // cursor
  const cursorJson = path.join(home, '.cursor', 'mcp.json')
  const cursorDir = path.join(home, '.cursor')
  if (!(await exists(cursorDir))) {
    agents.push({ name: 'cursor', label: 'Cursor', compat: 'managed', installed: false, mcpConfigured: false, servers: [], reason: '~/.cursor 不存在' })
  } else if (!(await exists(cursorJson))) {
    agents.push({ name: 'cursor', label: 'Cursor', compat: 'managed', installed: true, mcpConfigured: false, servers: [], mcpPath: cursorJson })
  } else {
    try {
      const cfg = JSON.parse(await fs.readFile(cursorJson, 'utf8'))
      const entry = cfg?.mcpServers?.memory
      const mcpExists = !!entry
      agents.push({
        name: 'cursor',
        label: 'Cursor',
        compat: 'managed',
        servers: listMcpServers(cfg),
        installed: true,
        mcpConfigured: mcpExists,
        mcpMatchesCurrentNode: mcpExists && sameMcpEntry(entry, want),
        currentNodePath: nodePath,
        configuredNodePath: entry?.command || '',
        mcpPath: cursorJson,
        hook: await hookState(path.join(home, '.cursor', 'hooks.json'), 'cursor', true),
      })
    } catch { agents.push({ name: 'cursor', installed: true, mcpConfigured: false, mcpPath: cursorJson, reason: 'JSON 解析失败' }) }
  }
  // 兼容性探测：只列出「本机确实存在配置文件」的其它 MCP 客户端（只读，不提供挂载按钮）
  for (const spec of DETECT_ONLY_CLIENTS) {
    let mcpPath = ''
    for (const p of spec.paths()) { if (await exists(p)) { mcpPath = p; break } }
    if (!mcpPath) continue
    let servers = []
    let reason = ''
    try { servers = listMcpServers(JSON.parse(await fs.readFile(mcpPath, 'utf8')), spec.keys) } catch { reason = 'JSON 解析失败' }
    agents.push({
      name: spec.name, label: spec.label, installed: true, detectedOnly: true, compat: 'detected',
      mcpConfigured: servers.includes('memory'), servers, mcpPath, reason,
    })
  }
  const allServers = [...new Set(agents.flatMap((a) => a.servers || []))]
  const summary = {
    detectedAgents: agents.filter((a) => a.installed).length,
    mountedAgents: agents.filter((a) => a.mcpConfigured).length,
    totalServers: allServers.length,
    allServers,
  }
  return { ok: true, agents, summary, lastCheckedAt: Date.now(), want: { command: nodePath, args: want.args } }
}

// -- 会话结束自动沉淀 hook（connect <agent>，agentmemory 的 `connect --with-hooks` 兜底路径）--
// 不依赖 plugin（Codex Desktop 也适用），只写「用户级 hooks.json + 绝对路径指向 capture.mjs」，
// 幂等 + 备份，只碰 capture.mjs 标记的条目，绝不动其它用户条目。

/** capture.mjs 的完整调用（绝对路径，避免升级后路径内嵌版本号而失效）。 */
function captureCmd(agent) {
  const node = process.execPath
  const script = path.join(PACKAGE_ROOT, 'hooks', 'capture.mjs')
  return `${JSON.stringify(node)} ${JSON.stringify(script)} ${agent}`
}

/** 写一个幂等 hooks.json：events → [{command}]（cursor 风格）或 {hooks:[{type,command}]}（codex 风格）。
 * 幂等 + 路径迁移：已有 capture.mjs 条目但路径不同 → 就地改为当前包路径；没有 → 追加；正确 → 跳过。 */
async function writeHooksJson(hooksJson, evEntries, { dryRun = false, log = () => {} } = {}) {
  let cfg = { version: 1, hooks: {} }
  if (await exists(hooksJson)) {
    try { cfg = JSON.parse(await fs.readFile(hooksJson, 'utf8')) } catch {
      log(`✗ ${hooksJson} 解析失败，跳过`)
      return { ok: false, reason: 'parse error' }
    }
  }
  cfg.hooks = cfg.hooks ?? {}
  let changed = false
  for (const ev of evEntries) {
    const arr = cfg.hooks[ev.event] = Array.isArray(cfg.hooks[ev.event]) ? cfg.hooks[ev.event] : []
    const wantCmd = ev.cmd
    // 找已存在的 capture.mjs 条目（可能是本脚本旧路径，或其它包的同脚本名）
    const idx = arr.findIndex((h) => JSON.stringify(h).includes('capture.mjs'))
    if (idx >= 0) {
      const entry = ev.codexStyle ? (arr[idx].hooks || []).find((x) => x.command && x.command.includes('capture.mjs')) : arr[idx]
      if (entry && entry.command === wantCmd) continue // 已正确
      if (entry) { entry.command = wantCmd; changed = true } // 路径迁移
      else { arr[idx] = ev.codexStyle ? { hooks: [{ type: 'command', command: wantCmd, timeout: 60, statusMessage: 'memory: save session' }] } : { command: wantCmd }; changed = true }
    } else {
      arr.push(ev.codexStyle ? { hooks: [{ type: 'command', command: wantCmd, timeout: 60, statusMessage: 'memory: save session' }] } : { command: wantCmd })
      changed = true
    }
  }
  if (!changed) { log(`✓ ${hooksJson} 已是最新，跳过`); return { ok: true, skipped: true } }
  if (dryRun) { log(`[dry-run] 将写入 ${hooksJson}`); return { ok: true, dry: true } }
  if (await exists(hooksJson)) await backupOnce(hooksJson)
  await fs.mkdir(path.dirname(hooksJson), { recursive: true })
  await fs.writeFile(hooksJson, JSON.stringify(cfg, null, 2), 'utf8')
  log(`✓ 会话结束 hook 已写入 ${hooksJson}`)
  return { ok: true }
}

/** Codex：用户级 ~/.codex/hooks.json 的 Stop 事件（CLI 与 Desktop 都可用）。 */
export async function connectCodexHooks(opts = {}) {
  return writeHooksJson(path.join(home, '.codex', 'hooks.json'), [{ event: 'Stop', codexStyle: true, cmd: captureCmd('codex') }], opts)
}

/** Cursor：~/.cursor/hooks.json 的 stop / sessionEnd 事件。 */
export async function connectCursorHooks(opts = {}) {
  return writeHooksJson(path.join(home, '.cursor', 'hooks.json'), [{ event: 'stop', cmd: captureCmd('cursor') }, { event: 'sessionEnd', cmd: captureCmd('cursor') }], opts)
}

/** 统一入口：claude 复用 setupClaude 的 SessionEnd（capture.mjs）；codex/cursor 写 capture.mjs hooks。 */
export async function connectAgentHooks(agent, opts = {}) {
  if (agent === 'claude' || agent === 'claude-code') {
    const results = await setupClaude({ nodePath: process.execPath, withHooks: true, log: opts.log })
    return { ok: results.every((r) => r.ok), results }
  }
  if (agent === 'codex') return connectCodexHooks(opts)
  if (agent === 'cursor') return connectCursorHooks(opts)
  return { ok: false, error: `未知 agent: ${agent}` }
}

// -- 单智能体 MCP 安装 / 卸载 ----------------------------------------------------

/** 卸载 Claude Code 的 memory MCP + SessionEnd hook。 */
export async function removeClaudeMcp({ dryRun = false, log = () => {} } = {}) {
  const claudeJson = path.join(home, '.claude.json')
  let removed = false
  if (await exists(claudeJson)) {
    try {
      const cfg = JSON.parse(await fs.readFile(claudeJson, 'utf8'))
      if (cfg.mcpServers && cfg.mcpServers.memory) {
        if (!dryRun) { await backupOnce(claudeJson); delete cfg.mcpServers.memory; await fs.writeFile(claudeJson, JSON.stringify(cfg, null, 2), 'utf8') }
        removed = true
      }
    } catch {}
  }
  // 移除 SessionEnd hook
  const settingsJson = path.join(home, '.claude', 'settings.json')
  if (await exists(settingsJson)) {
    try {
      const scfg = JSON.parse(await fs.readFile(settingsJson, 'utf8'))
      if (scfg.hooks?.SessionEnd) {
        const kept = scfg.hooks.SessionEnd.filter((h) => !(h.hooks || []).some((c) => c?.command?.includes('capture.mjs')))
        if (kept.length !== scfg.hooks.SessionEnd.length) {
          if (!dryRun) { await backupOnce(settingsJson); scfg.hooks.SessionEnd = kept; await fs.writeFile(settingsJson, JSON.stringify(scfg, null, 2), 'utf8') }
          removed = true
        }
      }
    } catch {}
  }
  log(removed ? (dryRun ? '[dry-run] 将卸载 Claude Code MCP' : '✓ 已卸载 Claude Code MCP') : '✓ Claude Code MCP 未配置')
  return { agent: 'claude-code', ok: true, removed }
}

/** 卸载 Codex 的 memory MCP 段。 */
export async function removeCodexMcp({ dryRun = false, log = () => {} } = {}) {
  const codexToml = path.join(home, '.codex', 'config.toml')
  if (!(await exists(codexToml))) return { agent: 'codex', ok: false, reason: 'not installed' }
  const text = await fs.readFile(codexToml, 'utf8')
  const sectionRe = /^\s*\[mcp_servers\.memory\]\s*$/m
  if (!sectionRe.test(text)) { log('✓ Codex MCP 未配置'); return { agent: 'codex', ok: true, removed: false } }
  if (!dryRun) {
    const newText = text.replace(/^\s*# memory-eternal.*\n?/m, '').replace(/^\s*\[mcp_servers\.memory\]\s*\n(?:command\s*=.*\n|args\s*=.*\n)+\s*/m, '')
    await backupOnce(codexToml)
    await fs.writeFile(codexToml, newText.replace(/\n{3,}/g, '\n\n'), 'utf8')
  }
  log(dryRun ? '[dry-run] 将卸载 Codex MCP' : '✓ 已卸载 Codex MCP')
  return { agent: 'codex', ok: true, removed: true }
}

/** 卸载 Cursor 的 memory MCP。 */
export async function removeCursorMcp({ dryRun = false, log = () => {} } = {}) {
  const cursorJson = path.join(home, '.cursor', 'mcp.json')
  if (!(await exists(cursorJson))) return { agent: 'cursor', ok: false, reason: 'not installed' }
  try {
    const cfg = JSON.parse(await fs.readFile(cursorJson, 'utf8'))
    if (cfg.mcpServers && cfg.mcpServers.memory) {
      if (!dryRun) { await backupOnce(cursorJson); delete cfg.mcpServers.memory; await fs.writeFile(cursorJson, JSON.stringify(cfg, null, 2), 'utf8') }
      log(dryRun ? '[dry-run] 将卸载 Cursor MCP' : '✓ 已卸载 Cursor MCP')
      return { agent: 'cursor', ok: true, removed: true }
    }
  } catch {}
  log('✓ Cursor MCP 未配置')
  return { agent: 'cursor', ok: true, removed: false }
}

/** 对单个智能体执行安装/卸载 MCP。action: 'install' | 'uninstall'。agent: 'claude-code'|'codex'|'cursor' */
export async function mcpAgentAction(agent, action, { dryRun = false, log = () => {} } = {}) {
  if (action === 'install') {
    const nodePath = process.execPath
    if (agent === 'claude-code') return { ok: true, results: await setupClaude({ nodePath, dryRun, log }) }
    if (agent === 'codex') return { ok: true, results: await setupCodex({ nodePath, dryRun, log }) }
    if (agent === 'cursor') return { ok: true, results: await setupCursor({ nodePath, dryRun, log }) }
  } else if (action === 'uninstall') {
    if (agent === 'claude-code') return { ok: true, results: [await removeClaudeMcp({ dryRun, log })] }
    if (agent === 'codex') return { ok: true, results: [await removeCodexMcp({ dryRun, log })] }
    if (agent === 'cursor') return { ok: true, results: [await removeCursorMcp({ dryRun, log })] }
  }
  return { ok: false, error: `未知 agent/action: ${agent}/${action}` }
}
