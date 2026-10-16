// 版本对齐检查（对「是不是插件迭代导致接口变更、旧记录还在」的正面解法）
//
// 为什么需要它 —— memory-eternal 升级只换**磁盘文件**，有两类「旧」不会自己消失：
//
//   ① **运行时**：DSH 宿主进程内存里注册的事件订阅（`agent/turn-stopping`、`agent/inbox/claimed`…）
//      来自它**启动时加载的那份代码**。升级插件不重启 DSH，宿主就一直在用旧接口 ——
//      那类「轮次收尾事件疑似失效」多半就是这么来的（旧判据 + 旧订阅）。
//   ② **持久接线**：插件写进 `~/.claude.json`、`~/.claude/settings.json`、`~/.codex/config.toml`、
//      `~/.cursor/mcp.json` 的 MCP 与 hooks 条目 —— 里面含**旧安装路径 / 旧 node 路径 / 旧事件键**，
//      升级后不会自动改写；旧路径一旦不存在，那个 hook 就永远不触发。
//
// 本模块把两类都查出来，并给**可执行**的对齐动作（重启 DSH / 重写接线 / 更新插件）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getSetupStatus, PACKAGE_ROOT } from './setup.js'
import { configFilePath } from './capture-run.js'
import { probeServedVersion } from './watchdog.js'

/**
 * 纯函数：把「版本现状 + 接线现状」翻译成结论清单（便于单测，无任何 IO）。
 * @returns {{ok:boolean, findings:Array<{id:string,level:'ok'|'warn'|'fix',title:string,detail:string,command:string}>, counts:{ok:number,warn:number,fix:number}}}
 */
export function alignFindings({
  hostVersion = '', onDisk = '', residentServed = '', residentPort = 7999, replaceBlocked = null,
  latest = '', updateCommand = '', wiring = [], hookPaths = [], configMirror = null, knownKeys = null,
} = {}) {
  const findings = []
  const push = (id, level, title, detail, command) => findings.push({ id, level, title, detail: detail || '', command: command || '' })

  // ① 宿主进程（最容易被忽略、也是"旧接口"的主因）
  if (hostVersion && onDisk && hostVersion !== onDisk) {
    push('host-stale', 'fix', `服务面板的宿主进程加载的是 v${hostVersion}，磁盘已是 v${onDisk}`,
      'DSH 的事件订阅（agent/turn-stopping、agent/inbox/claimed 等）是宿主进程**内存里注册**的，来自它启动时加载的那份代码 —— 升级插件只换磁盘文件，不重启 DSH 就会一直用旧接口（「轮次收尾事件疑似失效」多半就是它）。',
      '完全退出并重开 DSH（不是「重启常驻实例」）')
  } else if (hostVersion && onDisk) {
    push('host-ok', 'ok', `宿主进程 v${hostVersion} = 磁盘 v${onDisk}`)
  }

  // ② 常驻实例（端口上那个进程）
  if (residentServed && onDisk && residentServed !== onDisk) {
    push('resident-stale', 'fix', `常驻实例服务的是 v${residentServed}，磁盘已是 v${onDisk}`,
      '端口上那个进程仍是旧代码；面板/独立页的部分路由会按它的版本行为。',
      `dsh-memory restart --port ${residentPort}`)
  } else if (residentServed && onDisk) {
    push('resident-ok', 'ok', `常驻实例 v${residentServed} = 磁盘 v${onDisk}`)
  }

  // ②b 「不可替换（环境限制）」：这类机器上常驻实例**永远追不平**，必须显式说明，
  //     而不是让用户以为它只是「暂时落后」（issue #30 第五轮复测的原话）。
  if (replaceBlocked && replaceBlocked.fresh) {
    push('resident-replace-blocked', 'warn', '常驻实例不可替换（环境限制：看门狗锁目录不可写）',
      '锁目录当前不可写（' + (replaceBlocked.error || '原因未知') + '；' + (replaceBlocked.lockPath || '') + '）→ 端口 ' + residentPort + ' 上会长期停在 v' + (replaceBlocked.served || replaceBlocked.version || '?') + '，自动替换被正确地拒绝（避免留下孤儿）。',
      '修复该目录权限后执行 dsh-memory restart --port ' + residentPort + '；或前台观察：dsh-memory watchdog --port ' + residentPort)
  }
  // ③ npm 上是否已有更新
  if (latest && onDisk && latest !== onDisk) {
    push('update-available', 'warn', `npm 上已有 v${latest}（本机 v${onDisk}）`,
      '当前运行的是本地/较早版本，装最新版后再重启 DSH 才能拿到全部修复。',
      updateCommand || 'dsh plugin --profile <你的 profile> add memory-eternal@latest')
  }

  // ④ MCP / hooks 接线（持久文件，跨版本残留）
  for (const a of wiring) {
    if (!a || !a.installed) continue
    if (!a.mcpConfigured) {
      push('wiring-mcp-' + a.name, 'fix', `${a.name}：MCP 未配置（或条目被删）`,
        'agent 侧回忆不到记忆核心；这条是持久文件里的记录，插件升级不会自动补。', 'dsh-memory setup')
      continue
    }
    if (a.mcpMatchesCurrentNode === false) {
      // 措辞必须准确：`mcpMatchesCurrentNode` 比较的是**整条 MCP 条目**（node 路径 + 脚本路径 + 参数），
      // 两条路径相同时也可能因为**脚本路径/参数是旧写法**而不一致（升级后最常见）。
      const sameNode = String(a.configuredNodePath || '') === String(a.currentNodePath || '')
      push('wiring-node-' + a.name, 'fix',
        sameNode ? `${a.name}：MCP 条目与当前版本写出的不一致（脚本路径 / 参数是旧写法）` : `${a.name}：MCP 记的 node 路径与当前不一致`,
        sameNode
          ? `node 路径一致（${a.currentNodePath || '(空)'}），但条目内容不同 —— 老版本写进去的参数 / 脚本路径还在，可能指向已不存在的文件。`
          : `配置里是 ${a.configuredNodePath || '(空)'}，当前是 ${a.currentNodePath || '(空)'} —— 旧路径可能已不存在，MCP 会起不来。`,
        'dsh-memory setup')
    } else {
      push('wiring-mcp-ok-' + a.name, 'ok', `${a.name}：MCP 接的是当前 node`)
    }
    if (a.hook === 'missing') {
      push('wiring-hook-' + a.name, 'fix', `${a.name}：会话结束 hook 未配置`,
        '没有 hook，会话结束就不会触发沉淀（收尾事件由 agent 侧 hook 触发）。', 'dsh-memory setup')
    } else if (a.hook === 'configured') {
      push('wiring-hook-ok-' + a.name, 'ok', `${a.name}：会话结束 hook 已配置`)
    }
  }

  // ⑤ hooks 里写死的脚本路径（升级换目录后最容易失效的东西）
  for (const h of hookPaths) {
    if (!h || !h.path) continue
    if (!h.exists) {
      push('hookpath-missing-' + h.agent, 'fix', `${h.agent}：hook 指向的脚本不存在`,
        `配置里写的是 ${h.path}（当前安装目录 ${PACKAGE_ROOT}）—— 典型是升级/换 profile 后没重写接线。`,
        'dsh-memory setup')
    } else if (h.underCurrent === false) {
      push('hookpath-other-' + h.agent, 'fix', `${h.agent}：hook 指向的是**另一个安装目录**`,
        `配置里写的是 ${h.path}，当前安装目录是 ${PACKAGE_ROOT} —— 触发的是旧那份代码。`,
        'dsh-memory setup')
    } else {
      push('hookpath-ok-' + h.agent, 'ok', `${h.agent}：hook 指回当前安装目录`)
    }
  }

  // ⑥ 共享配置镜像里的未知键（旧版本写进去、新版本已经不认识）
  if (configMirror && configMirror.exists) {
    const unknown = Array.isArray(configMirror.unknownKeys) ? configMirror.unknownKeys : []
    if (Array.isArray(knownKeys) && unknown.length) {
      push('config-unknown', 'warn', `共享配置里有当前版本不认识的键：${unknown.join('、')}`,
        '多半是旧版本写入后残留（或被降级写入）。无害，但会让"两处配置不一致"更难排查。',
        '在「记忆 → 配置」里保存一次（会用当前白名单重写），或手工删除这些键')
    } else if (unknown.length === 0) {
      push('config-ok', 'ok', '共享配置的键与当前版本一致')
    }
  }

  const counts = { ok: findings.filter((x) => x.level === 'ok').length, warn: findings.filter((x) => x.level === 'warn').length, fix: findings.filter((x) => x.level === 'fix').length }
  return { ok: counts.fix === 0, findings, counts }
}

/** 读一个持久 hooks 配置，抽出它写死的 capture.mjs / secret-guard.mjs 路径。 */
async function hookPathsFrom(file, agent, pick) {
  try {
    const cfg = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    const cmds = pick(cfg)
    for (const c of cmds) {
      const m = /("[^"]+"|'[^']+'|\S+)[\s\S]*?((?:[A-Za-z]:[\\\\/]|\/)[^"'\s]*hooks[\\\\/](?:capture|secret-guard)\.mjs)/.exec(String(c || ''))
      const p = m ? m[2] : (/hooks[\\\\/](?:capture|secret-guard)\.mjs/.exec(String(c || '')) || [])[0]
      if (!p) continue
      const abs = path.isAbsolute(p) ? p : ''
      if (!abs) continue
      return { agent, path: abs, exists: fs.existsSync(abs), underCurrent: abs.startsWith(PACKAGE_ROOT) }
    }
    return null
  } catch { return null }
}

/**
 * 实际检查（IO 版）：运行时版本 + 持久接线。宿主调用时把 hostVersion / latest / knownKeys 传进来。
 * @param {{hostVersion?:string, residentPort?:number, latest?:string, updateCommand?:string, knownKeys?:string[]|null}} opts
 */
export async function inspectAlignment({ hostVersion = '', residentPort = 7999, latest = '', updateCommand = '', knownKeys = null } = {}) {
  let onDisk = ''
  try { onDisk = String(JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version || '') } catch { onDisk = '' }
  let residentServed = ''
  try { residentServed = String((await probeServedVersion(residentPort)) || '') } catch { residentServed = '' }
  let wiring = []
  try { wiring = (await getSetupStatus()).agents || [] } catch { wiring = [] }
  const hookPaths = []
  const home = os.homedir()
  const claudeHooks = await hookPathsFrom(path.join(home, '.claude', 'settings.json'), 'claude-code', (cfg) => {
    const out = []
    for (const list of Object.values(cfg?.hooks || {})) for (const h of (Array.isArray(list) ? list : [])) for (const c of (h?.hooks || [])) out.push(c?.command)
    return out
  })
  if (claudeHooks) hookPaths.push(claudeHooks)
  const codexHooks = await hookPathsFrom(path.join(home, '.codex', 'hooks.json'), 'codex', (cfg) => {
    const out = []
    for (const list of Object.values(cfg?.hooks || {})) for (const h of (Array.isArray(list) ? list : [])) out.push(typeof h === 'object' ? (h.command || (h.hooks || []).map((x) => x.command).join(' ')) : h)
    return out
  })
  if (codexHooks) hookPaths.push(codexHooks)
  const cursorHooks = await hookPathsFrom(path.join(home, '.cursor', 'hooks.json'), 'cursor', (cfg) => {
    const out = []
    for (const list of Object.values(cfg?.hooks || {})) for (const h of (Array.isArray(list) ? list : [])) out.push(typeof h === 'object' ? (h.command || (h.hooks || []).map((x) => x.command).join(' ')) : h)
    return out
  })
  if (cursorHooks) hookPaths.push(cursorHooks)

  let configMirror = null
  try {
    const file = configFilePath()
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      const keys = Object.keys(data || {}).filter((k) => !k.startsWith('_'))
      const known = Array.isArray(knownKeys) ? new Set(knownKeys) : null
      configMirror = { exists: true, path: file, keys, unknownKeys: known ? keys.filter((k) => !known.has(k)) : [] }
    } else {
      configMirror = { exists: false, path: configFilePath(), keys: [], unknownKeys: [] }
    }
  } catch { configMirror = { exists: false, path: '', keys: [], unknownKeys: [] } }

  let replaceBlocked = null
  try { const st = await import('./resident-state.js'); replaceBlocked = st.replaceBlockedInfo(process.env) } catch { replaceBlocked = null }
  const report = alignFindings({ hostVersion, onDisk, residentServed, residentPort, replaceBlocked, latest, updateCommand, wiring, hookPaths, configMirror, knownKeys })
  return { ...report, onDisk, hostVersion, residentServed, latest, wiring, hookPaths, configMirror }
}
