// Agent MCP 挂载：**默认不挂载**，必须人工选目标（避免多个 memory-eternal 实例沉淀串库）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { mount, unmount, getMount, ensureDefaultMount, SERVER_NAME, mcpFilePath } from '../lib/mcp-mount.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const homes = []
const newEnv = () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'me-mcpmount-'))
  homes.push(home)
  return { DSH_HOME: home }
}
test.after(() => { for (const h of homes) { try { rmSync(h, { recursive: true, force: true }) } catch { /* 忽略 */ } } })

const mkDir = (d) => { try { mkdirSync(d, { recursive: true }) } catch { /* 已存在 */ } }
const readServers = (env) => {
  const p = mcpFilePath(env)
  if (!existsSync(p)) return { mcpServers: {} }
  return JSON.parse(readFileSync(p, 'utf8'))
}

test('作为 DSH 插件：默认挂 dsh（且只挂 dsh），幂等', () => {
  const env = newEnv()
  // ① 全新环境：ensureDefaultMount 会把 dsh 挂上
  const r = ensureDefaultMount({ packageRoot: root, vault: '/tmp/v', env })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(getMount({ env, packageRoot: root }).mounted, true)
  const st = getMount({ env, packageRoot: root })
  assert.deepEqual(st.mountedIn, ['dsh'], '默认只挂 DSH，不碰其它宿主')
  assert.equal(st.target.vault, '/tmp/v')

  // ② 幂等：再调一次不再写
  const again = ensureDefaultMount({ packageRoot: root, vault: '/tmp/v', env })
  assert.equal(again.skipped, true)
  assert.equal(again.reason, 'already-mounted')

  // ③ 显式关闭：MEMORY_MCP_AUTOMOUNT=0
  const env2 = newEnv()
  const off = ensureDefaultMount({ packageRoot: root, env: { ...env2, MEMORY_MCP_AUTOMOUNT: '0' } })
  assert.equal(off.skipped, true)
  assert.equal(getMount({ env: env2, packageRoot: root }).mounted, false)
})

test('mount local：写入 server 条目 + MEMORY_VAULT_DIR，状态可读回', () => {
  const env = newEnv()
  const r = mount({ target: { kind: 'local', vault: 'C:/tmp/vault-a' }, packageRoot: root, env })
  assert.equal(r.ok, true)
  const servers = readServers(env)
  const entry = servers.mcpServers[SERVER_NAME]
  assert.ok(entry, 'must write entry')
  assert.equal(entry.env.MEMORY_VAULT_DIR, 'C:/tmp/vault-a')
  assert.ok(String(entry.args[1]) === 'mcp', 'args 必须是 mcp 子命令')
  const st = getMount({ env, packageRoot: root })
  assert.equal(st.mounted, true)
  assert.equal(st.target.kind, 'local')
})

test('mount peer：走 MEMORY_API（远端实例），拒绝非法地址', () => {
  const env = newEnv()
  const bad = mount({ target: { kind: 'peer', url: 'ftp://x' }, packageRoot: root, env })
  assert.equal(bad.ok, false)

  const r = mount({ target: { kind: 'peer', url: 'http://127.0.0.1:7989/', name: 'mem-purge' }, packageRoot: root, env })
  assert.equal(r.ok, true)
  const entry = readServers(env).mcpServers[SERVER_NAME]
  assert.equal(entry.env.MEMORY_API, 'http://127.0.0.1:7989', '结尾斜杠要去掉')
  assert.equal(getMount({ env, packageRoot: root }).target.name, 'mem-purge')
})

test('重复挂载只保留一个条目（同一时刻只能挂一个目标）', () => {
  const env = newEnv()
  mount({ target: { kind: 'local', vault: 'A' }, packageRoot: root, env })
  mount({ target: { kind: 'peer', url: 'http://127.0.0.1:7989' }, packageRoot: root, env })
  const servers = readServers(env)
  assert.equal(Object.keys(servers.mcpServers).length, 1)
  assert.equal(servers.mcpServers[SERVER_NAME].env.MEMORY_API, 'http://127.0.0.1:7989')
})

test('unmount 幂等：第一次移除，第二次 ok 且 removed=false', () => {
  const env = newEnv()
  mount({ target: { kind: 'local', vault: 'A' }, packageRoot: root, env })
  assert.equal(unmount({ env }).removed, true)
  const second = unmount({ env })
  assert.equal(second.ok, true)
  assert.equal(second.removed, false)
  assert.equal(getMount({ env, packageRoot: root }).mounted, false)
})

test('宿主里别的 MCP 不能被我们踩掉', () => {
  const env = newEnv()
  writeFileSync(mcpFilePath(env), JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }, null, 2))
  mount({ target: { kind: 'local' }, packageRoot: root, env })
  const servers = readServers(env)
  assert.ok(servers.mcpServers.other, '别人的条目要保留')
  unmount({ env })
  const after = readServers(env)
  assert.equal(Object.keys(after.mcpServers).join(','), 'other')
})

test('源码守卫：激活时只走 ensureDefaultMount（幂等、可关），不写其它宿主', () => {
  const index = readFileSync(path.join(root, 'index.js'), 'utf8')
  assert.match(index, /ensureDefaultMount\(\{ packageRoot: PACKAGE_ROOT/, '激活时要调 ensureDefaultMount')
  assert.match(index, /mcpAutoMount === false\) return/, 'mcpAutoMount=false 必须能关掉')
  assert.match(index, /mcpAutoMount: z\.boolean\(\)\.default\(true\)/, '插件场景默认开（默认挂 DSH）')
  assert.ok(!/hosts: 'all'/.test(index), '激活路径不许把挂载扩散到所有宿主')

  const bin = readFileSync(path.join(root, 'bin/dsh-memory.mjs'), 'utf8')
  assert.match(bin, /runMcpMountCli/, 'CLI 要有 mcp status|mount|unmount')
  const api = readFileSync(path.join(root, 'lib/api.js'), 'utf8')
  assert.match(api, /handleMcpMount\(\{/, '面板要靠 /mcp/* 管理挂载')
  const mcp = readFileSync(path.join(root, 'lib/mcp.js'), 'utf8')
  assert.match(mcp, /const REMOTE_API/, '远端模式（MEMORY_API）要能走对端实例')
})

test('MCP 挂载是实验性页的独立区块（不再塞在配对卡里）', () => {
  const ui = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')
  // ① 页面映射：sec-mcp → experimental
  assert.match(ui, /'sec-mcp': 'experimental'/, 'sec-mcp 必须归到「实验性」页')
  // ② 独立区块 + 独立组件
  assert.match(ui, /id="sec-mcp" icon="🔌"/, '要有独立的 🔌 区块')
  assert.match(ui, /function AgentMcpMountCard\(/, '要有独立组件')
  // ③ 配对卡里不许再出现挂载相关的 state / 函数 / JSX
  const peerStart = ui.indexOf('function PeerPairCard(')
  assert.ok(peerStart > 0, '找不到 PeerPairCard')
  // 取 PeerPairCard 到下一个顶层函数声明之间的代码块（不依赖两个组件的先后顺序）
  const nextFn = ui.indexOf('\nfunction ', peerStart + 10)
  const peerBlock = ui.slice(peerStart, nextFn > 0 ? nextFn : ui.length)
  for (const bad of ['setMcp(', 'const loadMcp', 'mountMcp', '/mcp/mount', 'mcpMountTitle']) {
    assert.equal(peerBlock.includes(bad), false, '配对卡里不该再有 MCP 挂载实现：' + bad)
  }
  // ④ 中英文案成对（每个 key 至少 2 次）
  for (const k of ['mcpSection', 'mcpSectionSub', 'mcpRefresh', 'mcpMountDone', 'mcpMountFail', 'mcpUnmountDone', 'mcpNoPeers', 'mcpFile', 'mcpOtherServers', 'mcpEntry', 'mcpRestartHint']) {
    const hits = ui.split(k + ':').length - 1
    assert.ok(hits >= 2, k + ' 需要中英两份（实际 ' + hits + '）')
  }
})

test('列表式点击挂载：库列表 + 宿主列表，点行即挂/摘', () => {
  const ui = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')
  const start = ui.indexOf('function AgentMcpMountCard(')
  const next = ui.indexOf('\nfunction ', start + 10)
  const block = ui.slice(start, next > 0 ? next : ui.length)

  // ① 列表渲染：目标库（本机 + 已配对节点）与宿主，各自可点
  assert.match(block, /mcpPickTarget/, '要有「选择要挂的库」列表标题')
  assert.match(block, /mcpPickHost/, '要有「选择宿主」列表标题')
  assert.match(block, /onClick=\{\(\) => setTarget\(item\.id\)\}/, '库列表每行（含本机默认库）都能点选')
  assert.match(block, /peers\.map\(\(pr\) => \(\{ id: pr\.id/, '已配对节点要并进同一个列表')
  assert.match(block, /onClick=\{\(\) => toggleHost\(h\)\}/, '每个宿主一行，点行挂/摘')

  // ② 点行行为：已挂 → unmount(hosts:id)；未挂 → mount(hosts:id, 目标)
  assert.match(block, /j\('\/mcp\/unmount', \{ hosts: host\.id \}\)/, '点击已挂宿主应卸载该宿主')
  assert.match(block, /j\('\/mcp\/mount', \{ \.\.\.targetPayload\(\), hosts: host\.id \}\)/, '点击未挂宿主应挂上当前目标')
  assert.match(block, /未安装|!h\.installed/, '未安装宿主不该能点')
  assert.match(block, /mcpUnmountAll/, '保留全部卸载')
})

test('Windows 兼容：脚本不存在时拒绝写入（不留死条目）', () => {
  const env = newEnv()
  const r = mount({
    target: { kind: 'local' },
    packageRoot: path.join(root, '__not_installed__'),   // 这个目录下没有 bin/dsh-memory.mjs
    env,
    hosts: 'dsh',
  })
  assert.equal(r.ok, false, '脚本不存在必须报错')
  assert.match(String(r.error || ''), /插件脚本不存在/)
  assert.equal(getMount({ env, packageRoot: root }).mounted, false, '不该留下半截条目')
})

test('Windows 兼容：命令不存在时报漂移（提示重新挂载）', () => {
  const env = newEnv()
  const dshHome = env.DSH_HOME
  mkDir(dshHome)
  writeFileSync(path.join(dshHome, 'mcp-servers.json'), JSON.stringify({
    mcpServers: {
      'memory-eternal': { command: 'C:\\NoSuchDir\\node.exe', args: [path.join(root, 'bin/dsh-memory.mjs'), 'mcp'], env: {} },
    },
  }, null, 2))
  const st = getMount({ env, packageRoot: root })
  assert.equal(st.mounted, true)
  assert.ok(st.drift, '命令不存在必须报漂移')
  assert.equal(st.drift.field, 'command')
})

test('Windows 兼容：node 解析不走 Electron 的 execPath（源码守卫）', () => {
  const mountSrc = readFileSync(path.join(root, 'lib/mcp-mount.js'), 'utf8')
  assert.match(mountSrc, /nodeBinary\(\)/, '必须用 lib/node-bin.js 的 nodeBinary() 解析 node')
  assert.ok(!/command: process\.execPath/.test(mountSrc), '不能直接拿 process.execPath 当 node（Electron 宿主里它是宿主程序）')
  const hostsSrc = readFileSync(path.join(root, 'lib/mcp-hosts.js'), 'utf8')
  assert.match(hostsSrc, /function normPath/, 'Windows 路径要归一为反斜杠')
  assert.match(hostsSrc, /插件脚本不存在/, '写盘前要校验脚本存在')
  const httpSrc = readFileSync(path.join(root, 'lib/mcp-mount-http.js'), 'utf8')
  assert.match(httpSrc, /runSelfTest/, '要有自检端点')
  assert.ok(httpSrc.includes("'/mcp/selftest'"), '要有自检端点路由')
})

test('宿主列表超过 3 个折叠：默认只渲染 3 行 + 「展开其余 N 个」', () => {
  const ui = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')
  const start = ui.indexOf('function AgentMcpMountCard(')
  const next = ui.indexOf('\nfunction ', start + 10)
  const block = ui.slice(start, next > 0 ? next : ui.length)
  assert.match(block, /hosts\.slice\(0, 3\)/, '默认只显示前 3 个宿主')
  assert.match(block, /const visible = more \? hosts :/, '展开后显示全部')
  assert.match(block, /mcpShowMore/, '要有「展开其余 N 个」入口')
  assert.match(block, /mcpShowLess/, '展开后要能收起')
  assert.match(block, /hidden = Math\.max\(0, hosts\.length - 3\)/, '隐藏数量按总数-3 算')
})

test('自动挂载用自制 switch（不是原生大勾选框），文案中英不串位', () => {
  const ui = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')
  const start = ui.indexOf('function AgentMcpMountCard(')
  const next = ui.indexOf('\nfunction ', start + 10)
  const block = ui.slice(start, next > 0 ? next : ui.length)
  assert.match(block, /role="switch"/, '要做成开关而不是 checkbox')
  assert.ok(!/type="checkbox"/.test(block), '不该再用原生 checkbox')

  // 中文字典里这几条不该是英文长句（之前 zh/en 被写串过）
  const zhKeys = ['mcpSectionSub', 'mcpMountHint', 'mcpAutoMountLabel', 'mcpHostAbsent', 'mcpMountAll']
  for (const k of zhKeys) {
    const m = new RegExp('^\\s*' + k + ":\\s*'([^']*)'", 'm').exec(ui)
    assert.ok(m, k + ' 缺失')
    const val = m[1]
    const asciiWords = (val.match(/[A-Za-z]{4,}/g) || []).filter((w) => !/^(DSH|Claude|Code|Codex|Cursor|Windsurf|Agent|MCP)$/.test(w))
    assert.equal(asciiWords.length, 0, k + ' 的中文值里不该夹英文长句：' + val.slice(0, 60))
  }
})
