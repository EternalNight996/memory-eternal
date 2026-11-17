// 统一挂载标准：多宿主 adapter（claude / project / cursor / windsurf / codex + dsh）的实测。
// 关键约束：只增删自己那一条、写后回读校验、幂等、TOML 首页/替换都正确。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { HOSTS, hostMatrix, parseHosts, writeHosts, removeHosts } from '../lib/mcp-hosts.js'
import { mount, unmount, getMount } from '../lib/mcp-mount.js'

const root = path.resolve(process.cwd())
const dirs = []
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'me-hosts-')); dirs.push(d); return d }
test.after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ } } })

// 用**真实存在**的 node 与脚本（writeHosts 会校验，防止写出死条目）
const REAL_NODE = process.execPath
const REAL_SCRIPT = path.resolve('bin/dsh-memory.mjs')
const canonical = { serverName: 'memory-eternal', transport: 'stdio', command: REAL_NODE, args: [REAL_SCRIPT, 'mcp'], env: { MEMORY_VAULT_DIR: '/data/vault' } }

test('parseHosts：默认只 dsh，all 展开全部，别名可用，未知宿主报错', () => {
  assert.deepEqual(parseHosts(''), ['dsh'])
  assert.equal(parseHosts('all').length, Object.keys(HOSTS).length)
  assert.deepEqual(parseHosts('claude-code,cursor'), ['claude', 'cursor'])
  assert.throws(() => parseHosts('vscode'), /不认识的宿主/)
})

test('JSON 宿主（claude / cursor / windsurf / project）：写入 → 回读 → 只删自己那条', () => {
  for (const id of ['claude', 'cursor', 'windsurf', 'project']) {
    const dir = tmp()
    const file = path.join(dir, 'mcp.json')
    // 预置别人的条目 + 我们的一条旧值
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }, null, 2))
    const env = { [`MEMORY_HOST_${id.toUpperCase()}_PATH`]: file }
    const w = writeHosts(canonical, [id], env)
    assert.equal(w[0].ok, true, id + ' 写入失败：' + JSON.stringify(w[0]))
    const j = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(j.mcpServers['memory-eternal'].command, REAL_NODE)
    assert.deepEqual(j.mcpServers['memory-eternal'].args, canonical.args)
    assert.ok(j.mcpServers.other, id + ' 把别人的条目踩掉了')

    const r = removeHosts([id], env)
    assert.equal(r[0].removed, true)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(after.mcpServers['memory-eternal'], undefined)
    assert.ok(after.mcpServers.other)
  }
})

test('Codex TOML：新建文件 / 追加 / 替换 / 删除 都不破坏其它段', () => {
  const dir = tmp()
  const file = path.join(dir, '.codex', 'config.toml')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, 'model = "gpt-5"\n\n[profiles.fast]\nmodel = "gpt-5-mini"\n')

  const env = { MEMORY_HOST_CODEX_PATH: file }
  const w = writeHosts(canonical, ['codex'], env)
  assert.equal(w[0].ok, true, JSON.stringify(w[0]))
  let t = readFileSync(file, 'utf8')
  assert.match(t, /\[mcp_servers\.memory-eternal\]/)
  assert.ok(t.includes('command = ' + JSON.stringify(REAL_NODE)), 'TOML 里的 command 要与真实 node 一致（转义后）')
  assert.match(t, /MEMORY_VAULT_DIR = "\/data\/vault"/)
  assert.match(t, /\[profiles\.fast\]/, 'TOML 里别的段要保留')

  // 幂等替换：再写一次不应出现两个块
  writeHosts(canonical, ['codex'], env)
  t = readFileSync(file, 'utf8')
  assert.equal((t.match(/\[mcp_servers\.memory-eternal\]/g) || []).length, 1)

  const r = removeHosts(['codex'], env)
  assert.equal(r[0].removed, true)
  t = readFileSync(file, 'utf8')
  assert.equal(t.includes('[mcp_servers.memory-eternal]'), false)
  assert.match(t, /\[profiles\.fast\]/)
})

test('hostMatrix：未安装的宿主标 installed=false，已挂载的标 mounted=true', () => {
  const dir = tmp()
  const dshHome = path.join(dir, '.dsh')
  const env = { DSH_HOME: dshHome, MEMORY_HOST_CLAUDE_PATH: path.join(dir, 'nope', '.claude.json') }
  const before = hostMatrix(env)
  assert.equal(before.find((h) => h.id === 'dsh').installed, false)
  assert.equal(before.find((h) => h.id === 'claude').installed, false)

  const m = mount({ target: { kind: 'local', vault: '/v' }, packageRoot: path.resolve('.'), env, hosts: 'dsh' })
  assert.equal(m.ok, true)
  const after = hostMatrix(env)
  assert.equal(after.find((h) => h.id === 'dsh').mounted, true)
  assert.equal(after.find((h) => h.id === 'dsh').installed, true)
  assert.equal(after.find((h) => h.id === 'claude').mounted, false)
})

test('一次投影多个宿主：mount --host dsh,claude 两边都写，unmount 全摘', () => {
  const dir = tmp()
  const env = {
    DSH_HOME: path.join(dir, '.dsh'),
    MEMORY_HOST_CLAUDE_PATH: path.join(dir, 'claude', '.claude.json'),
  }
  const m = mount({ target: { kind: 'peer', url: 'http://127.0.0.1:7989/', name: 'mem-purge' }, packageRoot: path.resolve('.'), env, hosts: 'dsh,claude' })
  assert.equal(m.ok, true, JSON.stringify(m))
  assert.deepEqual(m.hosts.map((h) => h.id).sort(), ['claude', 'dsh'])
  const st = getMount({ env, packageRoot: path.resolve('.') })
  assert.equal(st.mounted, true)
  assert.deepEqual(st.mountedIn.sort(), ['claude', 'dsh'])
  assert.equal(st.target.kind, 'peer')

  const u = unmount({ env })
  assert.equal(u.ok, true)
  assert.equal(getMount({ env, packageRoot: path.resolve('.') }).mounted, false)
})

test('getMount 报漂移：宿主里那条指向旧包路径', () => {
  const dir = tmp()
  const env = { DSH_HOME: path.join(dir, '.dsh') }
  const pkg = path.join(dir, 'repo-a')
  mkdirSync(path.join(env.DSH_HOME), { recursive: true })
  // 手工写一条指向"旧路径"的
  writeFileSync(path.join(env.DSH_HOME, 'mcp-servers.json'), JSON.stringify({
    mcpServers: { 'memory-eternal': { command: 'node', args: ['/old/place/bin/dsh-memory.mjs', 'mcp'], env: {} } },
  }, null, 2))
  const st = getMount({ env, packageRoot: pkg })
  assert.equal(st.mounted, true)
  assert.ok(st.drift, '应检测出走的是旧路径')
  assert.match(st.drift.now, /repo-a/)
})

test('note 里不许出现 ~/ 这类 Linux 风格路径（Windows 上会被当成"地址不对"）', () => {
  const src = readFileSync(path.join(root, 'lib/mcp-hosts.js'), 'utf8')
  const notes = [...src.matchAll(/note:\s*'([^']*)'/g)].map((m) => m[1])
  assert.ok(notes.length >= 4, '应当有多个宿主 note')
  for (const n of notes) {
    assert.equal(/~\//.test(n), false, 'note 不该写死 Linux 风格路径：' + n)
  }
})

test('project 宿主：cwd 不像项目目录时标未安装（不再给出假的 .mcp.json 路径）', () => {
  const dir = tmp()
  const env = { MEMORY_HOST_PROJECT_PATH: '' }
  // 直接把 process.cwd 之外的目录当"项目目录"来验证判定逻辑：通过显式路径控制
  const fakeProject = path.join(dir, 'repo')
  mkdirSync(fakeProject, { recursive: true })
  writeFileSync(path.join(fakeProject, 'package.json'), '{"name":"x"}')
  const p1 = path.join(fakeProject, '.mcp.json')
  // 显式路径存在 → installed
  writeFileSync(p1, '{"mcpServers":{}}')
  const withFile = hostMatrix({ ...env, MEMORY_HOST_PROJECT_PATH: p1 }).find((h) => h.id === 'project')
  assert.equal(withFile.installed, true, '显式路径存在时应视为已安装')

  // 显式路径不存在 → 未安装
  const notExists = hostMatrix({ ...env, MEMORY_HOST_PROJECT_PATH: path.join(dir, 'nope', '.mcp.json') }).find((h) => h.id === 'project')
  assert.equal(notExists.installed, false, '路径不存在时不该冒充已安装')
})

test('OpenClaw：mcp.servers 写入/回读/幂等/只删自己；含注释的 JSON5 拒绝改写', () => {
  const dir = tmp()
  const file = path.join(dir, 'openclaw.json')
  writeFileSync(file, JSON.stringify({ mcp: { servers: { other: { command: 'uvx', args: ['x'] } } }, theme: 'dark' }, null, 2))
  const env = { MEMORY_HOST_OPENCLAW_PATH: file }
  const w = writeHosts(canonical, ['openclaw'], env)
  assert.equal(w[0].ok, true, JSON.stringify(w[0]))
  const j = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(j.mcp.servers['memory-eternal'].command, REAL_NODE)
  assert.deepEqual(j.mcp.servers['memory-eternal'].args, canonical.args)
  assert.ok(j.mcp.servers.other, '把别人的 server 踩掉了')
  assert.equal(j.theme, 'dark', '把其它顶层键踩掉了')

  writeHosts(canonical, ['openclaw'], env)
  const again = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(Object.keys(again.mcp.servers).length, 2, '重复写入不该产生第二条')

  const r = removeHosts(['openclaw'], env)
  assert.equal(r[0].removed, true)
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.mcp.servers['memory-eternal'], undefined)
  assert.ok(after.mcp.servers.other)

  const json5 = path.join(dir, 'openclaw5.json')
  const orig = '{\n  // 注释\n  mcp: { servers: {} },\n}\n'
  writeFileSync(json5, orig)
  const bad = writeHosts(canonical, ['openclaw'], { MEMORY_HOST_OPENCLAW_PATH: json5 })
  assert.equal(bad[0].ok, false)
  assert.match(bad[0].error, /JSON5/)
  assert.equal(readFileSync(json5, 'utf8'), orig, '拒绝时不能动文件')
})

test('Hermes：YAML mcp_servers 块级插入/替换/删除，其它键与注释保留', () => {
  const dir = tmp()
  const file = path.join(dir, '.hermes', 'config.yaml')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '# 顶部注释\nmodel: hermes-4\ntools:\n  include: ["*"]\n')
  const env = { MEMORY_HOST_HERMES_PATH: file }

  const w = writeHosts(canonical, ['hermes'], env)
  assert.equal(w[0].ok, true, JSON.stringify(w[0]))
  let t = readFileSync(file, 'utf8')
  assert.match(t, /mcp_servers:/)
  assert.match(t, /^ {2}memory-eternal:/m)
  assert.ok(t.includes("command: '" + REAL_NODE + "'"), 'command 要用引号包住真实 node')
  assert.match(t, /# 顶部注释/, '注释要保留')
  assert.match(t, /model: hermes-4/, '其它顶层键要保留')
  assert.match(t, /tools:/)

  writeHosts(canonical, ['hermes'], env)
  t = readFileSync(file, 'utf8')
  assert.equal((t.match(/memory-eternal:/g) || []).length, 1, '重复写入不该出现两份')

  writeFileSync(file, 'mcp_servers:\n  other_fs:\n    command: npx\n')
  writeHosts(canonical, ['hermes'], env)
  t = readFileSync(file, 'utf8')
  assert.match(t, /other_fs:/, '不能踩掉别人已配的 server')
  assert.equal((t.match(/memory-eternal:/g) || []).length, 1)

  const r = removeHosts(['hermes'], env)
  assert.equal(r[0].removed, true)
  t = readFileSync(file, 'utf8')
  assert.equal(t.includes('memory-eternal'), false)
  assert.match(t, /other_fs:/)
})

test('MengBot：项目 .mcp.json（需告知项目根，否则不算已安装）', () => {
  const dir = tmp()
  const proj = path.join(dir, 'bot-project')
  mkdirSync(proj, { recursive: true })
  const env = { MEMORY_HOST_MENGBOT_PROJECT: proj }
  const before = hostMatrix({ MEMORY_HOST_MENGBOT_PROJECT: undefined }).find((h) => h.id === 'mengbot')
  assert.equal(before.installed, false, '没给项目根时不该冒充已安装')

  const w = writeHosts(canonical, ['mengbot'], env)
  assert.equal(w[0].ok, true, JSON.stringify(w[0]))
  const j = JSON.parse(readFileSync(path.join(proj, '.mcp.json'), 'utf8'))
  assert.equal(j.mcpServers['memory-eternal'].command, REAL_NODE)
  assert.equal(hostMatrix(env).find((h) => h.id === 'mengbot').mounted, true)
  const r = removeHosts(['mengbot'], env)
  assert.equal(r[0].removed, true)
})

test('Gemini CLI：settings.json 的 mcpServers 写入/回读/只删自己，其它键原样保留', () => {
  const dir = tmp()
  const file = path.join(dir, '.gemini', 'settings.json')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ theme: 'GitHub', mcp: { allowed: ['other'] }, mcpServers: { other: { command: 'uvx', args: ['x'] } } }, null, 2))
  const env = { MEMORY_HOST_GEMINI_PATH: file }

  const w = writeHosts(canonical, ['gemini'], env)
  assert.equal(w[0].ok, true, JSON.stringify(w[0]))
  const j = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(j.mcpServers['memory-eternal'].command, REAL_NODE)
  assert.deepEqual(j.mcpServers['memory-eternal'].args, canonical.args)
  assert.ok(j.mcpServers.other, '把别的 MCP server 踩掉了')
  assert.equal(j.theme, 'GitHub', '把其它顶层键踩掉了')
  assert.deepEqual(j.mcp.allowed, ['other'], 'mcp 全局设置要保留')

  writeHosts(canonical, ['gemini'], env)
  assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers).length, 2, '重复写入不该出现两条')

  const r = removeHosts(['gemini'], env)
  assert.equal(r[0].removed, true)
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.mcpServers['memory-eternal'], undefined)
  assert.ok(after.mcpServers.other)
})

test('Antigravity：默认写到 .gemini/config/mcp_config.json 的 mcpServers', () => {
  const dir = tmp()
  const file = path.join(dir, 'mcp_config.json')
  writeFileSync(file, JSON.stringify({ mcpServers: { remote: { url: 'https://x/mcp' } } }, null, 2))
  const env = { MEMORY_HOST_ANTIGRAVITY_PATH: file }
  const w = writeHosts(canonical, ['antigravity'], env)
  assert.equal(w[0].ok, true, JSON.stringify(w[0]))
  const j = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(j.mcpServers['memory-eternal'].command, REAL_NODE)
  assert.ok(j.mcpServers.remote, '把别人的远端 server 踩掉了')
  const r = removeHosts(['antigravity'], env)
  assert.equal(r[0].removed, true)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers['memory-eternal'], undefined)
})

test('Cline：优先 CLINE_MCP_SETTINGS_PATH，缺省走 ~/.cline/data/settings，IDE 那份存在也能识别', () => {
  const dir = tmp()
  const explicit = path.join(dir, 'cline_mcp_settings.json')
  writeFileSync(explicit, JSON.stringify({ mcpServers: {} }, null, 2))
  const w = writeHosts(canonical, ['cline'], { CLINE_MCP_SETTINGS_PATH: explicit })
  assert.equal(w[0].ok, true, JSON.stringify(w[0]))
  assert.equal(JSON.parse(readFileSync(explicit, 'utf8')).mcpServers['memory-eternal'].command, REAL_NODE)
  removeHosts(['cline'], { CLINE_MCP_SETTINGS_PATH: explicit })

  // IDE（VS Code globalStorage）那份存在时，未显式指路径也要认出来
  const appData = path.join(dir, 'AppData', 'Roaming')
  const ide = path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
  mkdirSync(path.dirname(ide), { recursive: true })
  writeFileSync(ide, JSON.stringify({ mcpServers: {} }, null, 2))
  const env = { APPDATA: appData, MEMORY_HOST_CLINE_PATH: '' }
  const m = hostMatrix(env).find((h) => h.id === 'cline')
  assert.equal(m.installed, true, 'IDE 那份存在时应视为已安装')
  assert.equal(m.path, ide, '应指向 IDE 实际在用的那份')
  const w2 = writeHosts(canonical, ['cline'], env)
  assert.equal(w2[0].ok, true, JSON.stringify(w2[0]))
  assert.equal(JSON.parse(readFileSync(ide, 'utf8')).mcpServers['memory-eternal'].command, REAL_NODE)
})

test('Qwen Code / Kimi CLI / GrokBot：三家 JSON 宿主写入→回读→只删自己', () => {
  const cases = [
    { id: 'qwen', env: 'MEMORY_HOST_QWEN_PATH', name: 'settings.json' },
    { id: 'kimi', env: 'MEMORY_HOST_KIMI_PATH', name: 'mcp.json' },
    { id: 'grokbot', env: 'MEMORY_HOST_GROKBOT_PATH', name: 'mcp.json' },
  ]
  for (const c of cases) {
    const dir = tmp()
    const file = path.join(dir, c.name)
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'uvx', args: ['x'] } }, theme: 'dark' }, null, 2))
    const env = { [c.env]: file }
    const w = writeHosts(canonical, [c.id], env)
    assert.equal(w[0].ok, true, c.id + ' 写入失败：' + JSON.stringify(w[0]))
    const j = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(j.mcpServers['memory-eternal'].command, REAL_NODE)
    assert.ok(j.mcpServers.other, c.id + ' 把别人的 server 踩掉了')
    assert.equal(j.theme, 'dark', c.id + ' 把其它顶层键踩掉了')

    writeHosts(canonical, [c.id], env)
    assert.equal(Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers).length, 2, c.id + ' 重复写入出现两条')

    const r = removeHosts([c.id], env)
    assert.equal(r[0].removed, true)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(after.mcpServers['memory-eternal'], undefined)
    assert.ok(after.mcpServers.other)
  }
})

test('GrokBot：没有点目录那份时，认 %APPDATA%\\GrokBot\\mcp.json', () => {
  const dir = tmp()
  const appData = path.join(dir, 'AppData', 'Roaming')
  const file = path.join(appData, 'GrokBot', 'mcp.json')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ mcpServers: {} }, null, 2))
  const env = { APPDATA: appData, MEMORY_HOST_GROKBOT_PATH: '' }
  const m = hostMatrix(env).find((h) => h.id === 'grokbot')
  assert.equal(m.installed, true)
  assert.equal(m.path, file, '应指向 APPDATA 那份')
  const w = writeHosts(canonical, ['grokbot'], env)
  assert.equal(w[0].ok, true, JSON.stringify(w[0]))
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).mcpServers['memory-eternal'].command, REAL_NODE)
})
