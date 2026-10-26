// issue #53：写外部配置不能再用 process.execPath（Electron 宿主会拉起 GUI），
// 应使用 nodeBinary()；只有只能退回 Electron 二进制时才补 ELECTRON_RUN_AS_NODE。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mcpCommand, hookCommand, isLegacyElectronCommand, alignCodexMemorySection, codexEnvLine, repairLegacySetup } from '../lib/setup.js'

test('普通 node 路径写外部配置时不加 env，且不硬编码 process.execPath', () => {
  const want = mcpCommand('/opt/node/bin/node')
  assert.equal(want.command, '/opt/node/bin/node')
  assert.equal(want.env, undefined)
  const cmd = hookCommand('/opt/node/bin/node', '/pkg/hooks/capture.mjs', 'claude')
  assert.equal(cmd, '"/opt/node/bin/node" "/pkg/hooks/capture.mjs" claude')
})

test('setup.js 不再把 process.execPath 当 nodePath', () => {
  const src = readFileSync(new URL('../lib/setup.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /nodePath\s*=\s*process\.execPath/)
  assert.doesNotMatch(src, /setupClaude\(\{\s*nodePath:\s*process\.execPath/)
  assert.doesNotMatch(src, /const node = process\.execPath/)
  assert.match(src, /import \{ nodeBinary, usesElectronBinary \} from '\.\/node-bin\.js'/)
})

test('legacy Electron 命令识别：普通 node 进程不误判', () => {
  // 当前测试进程是 node，不是 Electron；所有命令都不该被判为 legacy。
  assert.equal(isLegacyElectronCommand('"C:\\Program Files\\nodejs\\node.exe" "x.mjs"'), false)
})

test('Codex env 写入：出现 ELECTRON_RUN_AS_NODE 且幂等', () => {
  const base = ['[mcp_servers.memory]', "command = 'C:\\old\\node.exe'", "args = ['x.mjs', 'mcp']", ''].join('\n')
  const want = { command: 'C:\\new\\node.exe', args: ['x.mjs', 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1' } }
  const r = alignCodexMemorySection(base, want)
  assert.equal(r.changed, true)
  assert.ok(r.text.includes(codexEnvLine(want.env)))
  assert.equal(alignCodexMemorySection(r.text, want).changed, false)
})

test('自动迁移只改旧 Electron 条目，并写入真实 node', async () => {
  const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'me-repair-'))
  fsSync.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fsSync.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fsSync.mkdirSync(path.join(home, '.cursor'), { recursive: true })
  const old = 'C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe'
  fsSync.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { memory: { type: 'stdio', command: old, args: ['x.mjs', 'mcp'] } },
  }), 'utf8')
  fsSync.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      SessionEnd: [{ hooks: [{ type: 'command', command: `"${old}" "x/capture.mjs" claude` }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: `"${old}" "x/secret-guard.mjs"` }] }],
    },
  }), 'utf8')
  fsSync.writeFileSync(path.join(home, '.codex', 'config.toml'), [
    '[mcp_servers.memory]',
    'command = ' + JSON.stringify(old),
    'args = ["x.mjs", "mcp"]',
    '',
  ].join('\n'), 'utf8')
  fsSync.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: { memory: { command: old, args: ['x.mjs', 'mcp'] } },
  }), 'utf8')
  const legacyCheck = (cmd) => String(cmd || '').includes('DeepSeek Harness.exe')
  const r = await repairLegacySetup({ homeDir: home, legacyCheck })
  assert.equal(r.changed > 0, true, '应检测到并迁移旧配置')
  const claude = JSON.parse(fsSync.readFileSync(path.join(home, '.claude.json'), 'utf8'))
  assert.doesNotMatch(claude.mcpServers.memory.command, /DeepSeek Harness\.exe/i)
  const settings = fsSync.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')
  assert.doesNotMatch(settings, /DeepSeek Harness\.exe/i)
  assert.match(settings, /capture\.mjs/)
  assert.match(settings, /secret-guard\.mjs/)
  const cursor = JSON.parse(fsSync.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8'))
  assert.doesNotMatch(cursor.mcpServers.memory.command, /DeepSeek Harness\.exe/i)
})
