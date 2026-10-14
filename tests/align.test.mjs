// issue #36 之外的「用户提问」落地：**插件迭代后，旧接口/旧接线不会自己消失**。
//   ① 运行时：DSH 宿主内存里的事件订阅来自它启动时加载的代码 → 不重启 DSH 就一直是旧接口；
//   ② 持久接线：MCP / hooks 写在 ~/.claude.json、~/.codex/config.toml 等文件里，含旧路径/旧参数。
// 这里守住「结论正确 + 每条都有可执行动作」，避免把用户引向错误方向。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { alignFindings } from '../lib/align.js'

const level = (r, id) => (r.findings.find((x) => x.id === id) || {}).level
const cmd = (r, id) => (r.findings.find((x) => x.id === id) || {}).command || ''

test('① 宿主进程落后 → 明确指向「重启 DSH」并解释事件订阅在内存里（用户提问的正面回答）', () => {
  const r = alignFindings({ hostVersion: '0.10.8', onDisk: '0.10.27' })
  assert.equal(level(r, 'host-stale'), 'fix')
  assert.match(cmd(r, 'host-stale'), /退出并重开 DSH/)
  assert.match(r.findings.find((x) => x.id === 'host-stale').detail, /内存里注册/)
  assert.equal(r.ok, false)
  // 一致时不该报警
  const ok = alignFindings({ hostVersion: '0.10.27', onDisk: '0.10.27' })
  assert.equal(level(ok, 'host-ok'), 'ok')
  assert.equal(ok.ok, true)
})

test('② 常驻实例落后 / npm 有新版 → 各自给出对应命令', () => {
  const r = alignFindings({ hostVersion: '0.10.27', onDisk: '0.10.27', residentServed: '0.10.20', residentPort: 7999, latest: '0.10.28', updateCommand: 'UP' })
  assert.equal(level(r, 'resident-stale'), 'fix')
  assert.equal(cmd(r, 'resident-stale'), 'dsh-memory restart --port 7999')
  assert.equal(level(r, 'update-available'), 'warn')
  assert.equal(cmd(r, 'update-available'), 'UP')
})

test('③ MCP / hooks 接线：区分「node 路径不同」与「同一 node 但条目是旧写法」', () => {
  const other = alignFindings({ wiring: [{ name: 'claude-code', installed: true, mcpConfigured: true, mcpMatchesCurrentNode: false, configuredNodePath: 'C:/old/node.exe', currentNodePath: 'C:/new/node.exe', hook: 'missing' }] })
  const f1 = other.findings.find((x) => x.id === 'wiring-node-claude-code')
  assert.match(f1.title, /node 路径与当前不一致/)
  assert.equal(level(other, 'wiring-hook-claude-code'), 'fix')

  const sameNode = alignFindings({ wiring: [{ name: 'codex', installed: true, mcpConfigured: true, mcpMatchesCurrentNode: false, configuredNodePath: 'C:/node.exe', currentNodePath: 'C:/node.exe', hook: 'configured' }] })
  const f2 = sameNode.findings.find((x) => x.id === 'wiring-node-codex')
  assert.match(f2.title, /脚本路径 \/ 参数是旧写法/, '同一 node 时必须说清差异在哪，不能误导成 node 路径问题')
  assert.equal(level(sameNode, 'wiring-hook-ok-codex'), 'ok')

  const mcpMissing = alignFindings({ wiring: [{ name: 'cursor', installed: true, mcpConfigured: false, hook: 'unknown' }] })
  assert.equal(level(mcpMissing, 'wiring-mcp-cursor'), 'fix')

  // 没装的 agent 不参与（不制造噪音）
  const notInstalled = alignFindings({ wiring: [{ name: 'cursor', installed: false }] })
  assert.equal(notInstalled.findings.length, 0)
})

test('④ hooks 里写死的脚本路径：不存在 / 指向别的安装目录 → 都是 fix', () => {
  const r = alignFindings({ hookPaths: [
    { agent: 'claude-code', path: 'D:/old/hooks/capture.mjs', exists: false, underCurrent: false },
    { agent: 'codex', path: 'F:/MyApp/eternal/memory-eternal/hooks/capture.mjs', exists: true, underCurrent: true },
  ] })
  assert.equal(level(r, 'hookpath-missing-claude-code'), 'fix')
  assert.equal(level(r, 'hookpath-ok-codex'), 'ok')
  const other = alignFindings({ hookPaths: [{ agent: 'cursor', path: 'D:/other/hooks/capture.mjs', exists: true, underCurrent: false }] })
  assert.equal(level(other, 'hookpath-other-cursor'), 'fix')
  assert.match(cmd(other, 'hookpath-other-cursor'), /setup/)
})

test('⑤ 共享配置里的旧键：给了 schema 才判（否则不猜）', () => {
  const withSchema = alignFindings({ knownKeys: ['recallLimit', 'autoCapture'], configMirror: { exists: true, unknownKeys: ['legacyThing'] } })
  assert.equal(level(withSchema, 'config-unknown'), 'warn')
  assert.match(withSchema.findings.find((x) => x.id === 'config-unknown').title, /legacyThing/)
  const noSchema = alignFindings({ configMirror: { exists: true, unknownKeys: [] } })
  assert.equal(level(noSchema, 'config-ok'), 'ok')
  assert.equal(noSchema.findings.some((x) => x.id === 'config-unknown'), false)
})

test('⑥ 汇总：ok 只看有没有 fix（warn 不算失败）', () => {
  const r = alignFindings({ hostVersion: '0.10.27', onDisk: '0.10.27', latest: '0.10.28', knownKeys: [], configMirror: { exists: true, unknownKeys: [] } })
  assert.equal(r.counts.fix, 0)
  assert.equal(r.ok, true, 'warn 不该把整体判成失败')
  assert.ok(r.counts.warn >= 1)
})
