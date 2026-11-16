// 统一挂载标准：多宿主 adapter（claude / project / cursor / windsurf / codex + dsh）的实测。
// 关键约束：只增删自己那一条、写后回读校验、幂等、TOML 首页/替换都正确。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { HOSTS, hostMatrix, parseHosts, writeHosts, removeHosts } from '../lib/mcp-hosts.js'
import { mount, unmount, getMount } from '../lib/mcp-mount.js'

const dirs = []
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'me-hosts-')); dirs.push(d); return d }
test.after(() => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 忽略 */ } } })

const canonical = { serverName: 'memory-eternal', transport: 'stdio', command: '/usr/bin/node', args: ['/opt/me/bin/dsh-memory.mjs', 'mcp'], env: { MEMORY_VAULT_DIR: '/data/vault' } }

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
    assert.equal(j.mcpServers['memory-eternal'].command, '/usr/bin/node')
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
  assert.match(t, /command = "\/usr\/bin\/node"/)
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
