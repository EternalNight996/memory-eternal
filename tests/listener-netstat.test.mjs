// issue #45 后续（AkiMei0721 的实测）：`Get-NetTCPConnection` 在该机要 4.1–61.4s，而 takeover 只给 2.5s
// → 超时 → 空输出 → null → 「端口已空出」→ 新看门狗绑不上 7999 → 漂到 8001，旧 web（0.10.36）永远活着。
// 修法：① Windows 先走 netstat -ano（1.8s 且给 pid）；② portFree 三态（free/occupied/unknown），超时算 unknown 并**中止**；
//       ③ status 区分「超时」与「没有服务」；④ 探测路径不再漏 socket。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseNetstatListener, findPortListener, clearResidentForTakeover, probeServedVersionDetailed } from '../lib/watchdog.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    127.0.0.1:7999         0.0.0.0:0              LISTENING       10924',
  '  TCP    127.0.0.1:8001         0.0.0.0:0              LISTENING       39552',
  '  TCP    127.0.0.1:7999         127.0.0.1:15000        TIME_WAIT       0',
  '  TCP    [::1]:7999             [::]:0                 LISTENING       10924',
  '',
].join('\r\n')

test('parseNetstatListener：只认 LISTENING 行，IPv4/IPv6 都能取到 pid，不把 TIME_WAIT 当监听', () => {
  assert.equal(parseNetstatListener(NETSTAT, 7999), 10924)
  assert.equal(parseNetstatListener(NETSTAT, 8001), 39552)
  assert.equal(parseNetstatListener(NETSTAT, 7000), 0, '没有该端口返回 0')
  const onlyTw = '  TCP    127.0.0.1:7999    127.0.0.1:15000    TIME_WAIT    0\r\n'
  assert.equal(parseNetstatListener(onlyTw, 7999), 0, 'TIME_WAIT 不是监听')
  const ipv6 = '  TCP    [::1]:7999             [::]:0                 LISTENING       4242\r\n'
  assert.equal(parseNetstatListener(ipv6, 7999), 4242)
  assert.equal(parseNetstatListener('', 7999), 0)
  assert.equal(parseNetstatListener(NETSTAT, 0), 0)
})

test('findPortListener(win32)：netstat 命中就拿 pid；netstat 超时一律报 unknown（不是空闲）', async () => {
  const calls = []
  const okExec = async (cmd, args) => { calls.push(cmd); if (cmd === 'netstat') return NETSTAT; if (cmd === 'powershell') return 'node F:/x/memory-eternal/lib/web.js --port 7999'; return '' }
  const hit = await findPortListener(7999, { platform: 'win32', exec: okExec })
  assert.equal(hit.pid, 10924)
  assert.match(String(hit.command), /memory-eternal/, '命令行用于判定「是不是自家 web」')
  assert.equal(calls[0], 'netstat', 'Windows 上必须**先**走 netstat（PowerShell 在该机要 4–61s）')

  const timeoutExec = async () => { throw new Error('ETIMEDOUT') }
  const unk = await findPortListener(7999, { platform: 'win32', exec: timeoutExec })
  assert.equal(unk.unknown, true, '枚举超时 = 未知，绝不能返回 null（那会被当成端口空闲）')

  const emptyExec = async (cmd) => (cmd === 'netstat' ? '' : '')
  const unk2 = await findPortListener(7999, { platform: 'win32', exec: emptyExec })
  assert.equal(unk2.unknown, true, '空输出同样不可信')

  // netstat 明确没有该端口 + PowerShell 也没 pid → 真的没人听 → null
  const noListen = '  TCP    127.0.0.1:9999         0.0.0.0:0              LISTENING       7\r\n'
  const idExec = async (cmd) => (cmd === 'netstat' ? noListen : '')
  assert.equal(await findPortListener(7999, { platform: 'win32', exec: idExec }), null)
})

test('clearResidentForTakeover：占用者无法判定 → portState=unknown 且 portFree=false（中止，不漂移）', async () => {
  const out = await clearResidentForTakeover({
    port: 7999,
    timeoutMs: 100,
    deps: {
      stop: async () => ({ stopped: [], webStopped: [], portStopped: [], warnings: [], failed: [] }),
      findListener: async () => ({ pid: 0, command: '', unknown: true }),
      sleep: async () => {},
      probeTcp: async () => false,
      kill: () => true,
    },
  })
  assert.equal(out.portState, 'unknown')
  assert.equal(out.portFree, false, '未知也必须按「不空」处理')
  assert.match(out.warnings.join(' '), /无法判定|未知/)
})

test('probeServedVersionDetailed：能区分「超时」与「没人应答」', async () => {
  const http = await import('node:http')
  // 一个只接受连接、永不回应的服务
  const srv = http.createServer((req, res) => { void req; void res })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    const d = await probeServedVersionDetailed(port, 120, { tries: 1 })
    assert.equal(d.version, '')
    assert.equal(d.timedOut, true, '120ms 内没回应 → 超时（不是「没有服务」）')
  } finally { srv.closeAllConnections?.(); srv.close() }
})

test('接线守卫：探测不漏 socket、status 用详细探测', () => {
  const wd = read('lib/watchdog.js')
  assert.match(wd, /res\.resume\(\); res\.destroy\(\)/, '非 200 也要销毁 socket')
  assert.match(wd, /export function parseNetstatListener/, '要有 netstat 解析')
  assert.match(wd, /unknown: true/, '要能表达「未知」')
  const cli = read('bin/dsh-memory.mjs')
  assert.match(cli, /probeServedVersionDetailed\(probePort\)/, 'status 用详细探测')
  assert.match(cli, /响应超时/, 'status 要把超时与没有服务分开报')
})
