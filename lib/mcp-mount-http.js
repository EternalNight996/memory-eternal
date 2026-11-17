// /mcp/* 路由 + `dsh-memory mcp status|mount|unmount` 命令（同一份实现，面板与 CLI 共用）。
//
// 用户要求：Agent 的 MCP **不再自动挂载**，必须由人在 UI 里手动选择"挂到哪个 memory-eternal"
// 再点挂载 —— 否则本机跑着多个实例（7999 运营库 / 7989 mem-purge / 云端）时，
// 沉淀与召回会串到别的库里去。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getMount, mount, unmount, SERVER_NAME, HOSTS } from './mcp-mount.js'
import { spawn } from 'node:child_process'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')


/**
 * 自检：按宿主配置里那条，真的拉起一个 MCP 进程并把 initialize 发过去。
 * Windows 上"agent 路径不对"最常见的三种表现都能一次看清：
 *   · 命令不存在 → spawn 直接 error（ENOENT）
 *   · 脚本不存在 → node 报 Cannot find module
 *   · 能起但握手失败 → stderr 里会写原因
 * @returns {Promise<{ok:boolean, ms:number, command?:string, error?:string, stdout?:string, stderr?:string}>}
 */
function runSelfTest({ timeoutMs = 6000 } = {}) {
  const st = getMount({ packageRoot: PACKAGE_ROOT })
  const entry = st && st.entry
  if (!entry) return Promise.resolve({ ok: false, ms: 0, error: '当前没有挂载（先选库再点宿主挂载）' })
  const init = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'memory-eternal-selftest', version: '1' } },
  }) + '\n'
  const t0 = Date.now()
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    const done = (r) => { if (!settled) { settled = true; resolve({ ...r, ms: Date.now() - t0, command: String(entry.command || '') }) } }
    let child
    try {
      child = spawn(String(entry.command), Array.isArray(entry.args) ? entry.args : [], {
        env: { ...process.env, ...(entry.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      return done({ ok: false, error: 'spawn 失败：' + String((e && e.message) || e) })
    }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 忽略 */ } ; done({ ok: false, error: '超时 ' + timeoutMs + 'ms 没握手成功', stdout: out.slice(0, 400), stderr: err.slice(0, 400) }) }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, error: (e && e.code ? e.code + '：' : '') + String((e && e.message) || e), stderr: err.slice(0, 400) }) })
    child.on('close', () => {
      clearTimeout(timer)
      const ok = /"serverInfo"|"protocolVersion"/.test(out)
      done({ ok, stdout: out.slice(0, 400), stderr: err.slice(0, 400), error: ok ? undefined : '进程退出但没有返回 initialize 结果' })
    })
    try { child.stdin.write(init); child.stdin.end() } catch (e) { /* close/error 会兜住 */ }
  })
}

/**
 * @returns {Promise<boolean>} true=已处理
 */
export async function handleMcpMount({ req, res, route, json, readRaw, broadcast, logActivity, clientIpOf, vaultRoot }) {
  if (!route.startsWith('/mcp/')) return false
  const method = req.method

  if (route === '/mcp/status' && method === 'GET') {
    json(res, 200, { ...getMount({ packageRoot: PACKAGE_ROOT }), hint: '默认不挂载；请在面板选择目标后手动挂载' })
    return true
  }

  if (route === '/mcp/selftest' && (method === 'POST' || method === 'GET')) {
    const r = await runSelfTest()
    json(res, 200, { ...r, at: new Date().toISOString() })
    return true
  }

  if (route === '/mcp/mount' && method === 'POST') {
    const raw = await readRaw(req, res)
    if (raw === null) return true
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { body = {} }
    // 允许 {kind:'local', vault} 或 {kind:'peer', url, name}；也接受 {peerId} 由面板自己换成 url
    const target = {
      kind: body.kind === 'peer' ? 'peer' : 'local',
      vault: String(body.vault || ''),
      url: String(body.url || ''),
      name: String(body.name || ''),
    }
    const out = mount({ target, packageRoot: PACKAGE_ROOT, hosts: String(body.hosts || 'dsh') })
    if (out.ok) {
      try { logActivity(vaultRoot, { ip: clientIpOf(req), agent: 'mcp-mount', action: 'mount-mcp', title: SERVER_NAME, target: target.kind === 'peer' ? target.url : (target.vault || 'default') }) } catch { /* 旁路 */ }
      try { broadcast('mcp', { event: 'mounted', target: out.target }) } catch { /* 忽略 */ }
    }
    json(res, out.ok ? 200 : 400, out)
    return true
  }

  if (route === '/mcp/unmount' && method === 'POST') {
    let body = {}
    try { const raw = await readRaw(req, res); body = raw ? JSON.parse(raw || '{}') : {} } catch { body = {} }
    const out = unmount({ hosts: String((body && body.hosts) || '') })
    try { logActivity(vaultRoot, { ip: clientIpOf(req), agent: 'mcp-mount', action: 'unmount-mcp', title: SERVER_NAME }) } catch { /* 旁路 */ }
    try { broadcast('mcp', { event: 'unmounted' }) } catch { /* 忽略 */ }
    json(res, 200, out)
    return true
  }

  json(res, 404, { ok: false, error: '未知的 /mcp 路由：' + route })
  return true
}

/** CLI：dsh-memory mcp status|mount|unmount */
export async function runMcpMountCli(argv, api = 'http://127.0.0.1:7999') {
  const sub = String(argv[0] || 'status')
  const json = argv.includes('--json')
  const flag = (name) => {
    const i = argv.indexOf('--' + name)
    return i >= 0 ? String(argv[i + 1] || '') : ''
  }
  const base = api.replace(/\/+$/, '') + '/memory-eternal/api'
  const call = async (p, init) => {
    const r = await fetch(base + p, { ...init, headers: { 'content-type': 'application/json', ...(init && init.headers) } }).catch((e) => ({ _err: String(e && e.message) }))
    if (r._err) return { ok: false, error: '连不上 ' + base + '：' + r._err }
    return r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }))
  }

  if (sub === 'status') {
    const d = await call('/mcp/status')
    if (json) { console.log(JSON.stringify(d, null, 2)); return d.ok ? 0 : 1 }
    if (!d.ok) { console.error('✗ ' + (d.error || '读取失败')); return 1 }
    console.log(d.mounted
      ? `已挂载：${SERVER_NAME} → ${d.target && d.target.kind === 'peer' ? d.target.url : (d.target && d.target.vault) || '默认库'}`
      : '未挂载（默认不挂载：请在面板「🔗 互相配对」里选择目标后手动挂载）')
    if (d.otherServers && d.otherServers.length) console.log('宿主里其它 MCP：' + d.otherServers.join(', '))
    if (Array.isArray(d.hosts)) {
      console.log('宿主矩阵：')
      for (const h of d.hosts) {
        const state = !h.installed ? '未安装' : h.mounted ? '已挂载' : '未挂载'
        console.log('  · ' + h.id.padEnd(9) + state.padEnd(7) + h.path)
      }
    }
    if (d.drift) console.log('⚠ 漂移：宿主里那条指向 ' + d.drift.host + '，当前包在 ' + d.drift.now + '（重新挂载即可修正）')
    return 0
  }

  if (sub === 'mount') {
    const url = flag('url')
    const kind = url ? 'peer' : 'local'
    const d = await call('/mcp/mount', { method: 'POST', body: JSON.stringify({ kind, url, vault: flag('vault'), name: flag('name'), hosts: flag('host') || 'dsh' }) })
    if (json) { console.log(JSON.stringify(d, null, 2)); return d.ok ? 0 : 1 }
    if (!d.ok) { console.error('✗ ' + (d.error || '挂载失败')); return 1 }
    console.log(`✓ 已挂载 ${SERVER_NAME} → ${kind === 'peer' ? url : (flag('vault') || '默认库')}`)
    if (Array.isArray(d.hosts)) for (const h of d.hosts) console.log('   · ' + h.id.padEnd(9) + (h.ok ? 'ok  ' : '失败 ') + (h.path || h.error || ''))
    console.log('  重启一次宿主（DSH / Claude Code / Codex）后生效；同一时刻只挂一个目标。')
    return 0
  }

  if (sub === 'unmount' || sub === 'off') {
    const d = await call('/mcp/unmount', { method: 'POST', body: JSON.stringify({ hosts: flag('host') || '' }) })
    if (json) { console.log(JSON.stringify(d, null, 2)); return d.ok ? 0 : 1 }
    console.log(d.ok ? '✓ 已卸载（MCP 条目已从 mcp-servers.json 移除）' : '✗ ' + (d.error || '卸载失败'))
    return d.ok ? 0 : 1
  }

  // 宿主清单从 HOSTS 现算：新增宿主不用再回来改这行用法说明（以前写死过，加了 Gemini/Cline 就过期了）
  console.error('用法：dsh-memory mcp [status|mount --vault <库>|--url http://host:port|unmount] [--host ' + Object.keys(HOSTS).join(',') + ',all] [--json]')
  console.error('  mengbot 走机器人项目 .mcp.json：先设 MEMORY_HOST_MENGBOT_PROJECT=<项目根>')
  console.error('  openclaw 写 .openclaw/openclaw.json 的 mcp.servers；hermes 写 .hermes/config.yaml 的 mcp_servers')
  return 1
}
