// issue #44（macOS/Homebrew 升级 node 后静默失效）暴露的 codex 接线缺陷：
//   ① 解析没有限定 [mcp_servers.memory] 段 —— 会抓到别的 server 的第一个 command（本机真实踩到：
//      读成了 MCP_DOCKER 的 docker.exe，于是 align 永远报「node 路径与当前不一致」）；
//   ② 只认双引号 —— 而 codex 自己写出来的 TOML 是单引号，于是既读不到也改不掉；
//   ③ 改完不校验 —— 没改成功也照样打印「已更新」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCodexMemoryEntry, alignCodexMemorySection } from '../lib/setup.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')

const TOML = [
  'model = "gpt-5"',
  '',
  '[mcp_servers.MCP_DOCKER]',
  "command = 'docker.exe'",
  "args = ['mcp', 'gateway', 'run']",
  '',
  '[mcp_servers.memory]',
  "args = ['C:\\\\old\\\\memory-eternal\\\\bin\\\\dsh-memory.mjs', 'mcp']",
  "command = 'C:\\\\old\\\\nodejs\\\\node.exe'",
  '',
  '[mcp_servers.node_repl]',
  "command = 'C:\\\\other\\\\node_repl.exe'",
  '',
].join('\n')

test('按段解析：只读 [mcp_servers.memory]，不被前面的 docker.exe / 后面的 node_repl 干扰', () => {
  const e = parseCodexMemoryEntry(TOML)
  assert.equal(e.present, true)
  assert.equal(e.command, 'C:\\old\\nodejs\\node.exe', '单引号 + 双反斜杠都要正确解出')
  assert.deepEqual(e.args, ['C:\\old\\memory-eternal\\bin\\dsh-memory.mjs', 'mcp'])
  assert.deepEqual(parseCodexMemoryEntry('model = "x"\n'), { present: false, command: '', args: [] })
})

test('对齐：只改 memory 段的两行，别的 server 一个字都不动；并如实返回 changed', () => {
  const want = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['F:\\app\\bin\\dsh-memory.mjs', 'mcp'] }
  const r = alignCodexMemorySection(TOML, want)
  assert.equal(r.changed, true)
  const after = r.text
  // 用 JSON.stringify 生成期望行，避免手写转义（TOML 里就是带转义的形态）
  assert.ok(after.split('\n').includes('command = ' + JSON.stringify(want.command)), 'memory 段的 command 已对齐')
  assert.match(after, /\[mcp_servers\.MCP_DOCKER\]\ncommand = 'docker\.exe'/, 'docker 段没被动')
  assert.match(after, /\[mcp_servers\.node_repl\]\ncommand = 'C:\\\\other\\\\node_repl\.exe'/, 'node_repl 段没被动')
  const again = alignCodexMemorySection(after, want)
  assert.equal(again.changed, false, '幂等：已经是目标形态就不算改动')
})

test('接线守卫：setup 必须校验「真的改了」，不许谎报已更新', () => {
  const src = read('lib/setup.js')
  assert.match(src, /parseCodexMemoryEntry\(/, 'status 要用按段解析')
  assert.match(src, /alignCodexMemorySection\(/, 'writer 要用同一个对齐函数')
  assert.match(src, /if \(!changed\)/, '没改成功要如实报失败')
  assert.match(src, /section unparseable/, '要给出「条目存在但改不了」的明确原因')
  const align = read('lib/align.js')
  assert.match(align, /export async function staleWiringCheck/, '要有启动期只读检查')
  assert.match(read('index.js'), /staleWiringCheck\(\)/, '宿主启动时要调用它并记日志')
})
