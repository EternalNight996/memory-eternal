// 方案 A 的回归守卫（2026-10-08 实测）：独立页保存 → **请宿主在 HTTP 请求上下文里应用** pending。
//
// 背景（本机实测，见 commit 记录）：同一个 settings.update，
//   · 从插件**回调**里调（setInterval / fs.watch）→ 抛「HMR transactions cannot be nested」，
//     而且**一个字节都没提交**（与 patch 内容无关：只含宿主认识的键、值真的变了，同样失败）；
//   · 从插件**HTTP 请求处理器**里调 → 真的提交（130→132→130，revision 4→6）。
// 所以修法不是换 API，而是换**调用上下文**：独立端保存后主动叫醒宿主那条路由。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DRAIN_TOKEN_HEADER, drainRequestError, isLoopbackAddress, triggerHostDrain } from '../lib/config-sync.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

test('守卫①：只认本机来源（IPv4 / IPv6 / IPv4-mapped），其它一律拒', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.9'), false)
  assert.equal(isLoopbackAddress('::ffff:192.168.1.9'), false)
  assert.equal(isLoopbackAddress(''), false)
})

test('守卫②：方法 / 来源 / 令牌三件都要满足，缺哪件就说清哪件', () => {
  const ok = { method: 'POST', headers: { [DRAIN_TOKEN_HEADER]: 'tok' }, remoteAddress: '127.0.0.1' }
  assert.equal(drainRequestError(ok, 'tok'), '')
  assert.match(drainRequestError({ ...ok, method: 'GET' }, 'tok'), /POST/)
  assert.match(drainRequestError({ ...ok, remoteAddress: '10.0.0.5' }, 'tok'), /本机/)
  assert.match(drainRequestError({ ...ok, headers: {} }, 'tok'), /令牌/)
  assert.match(drainRequestError(ok, 'other'), /令牌/)
  assert.match(drainRequestError(ok, ''), /令牌|未准备/)
})

test('端到端：独立端叫醒宿主 → 宿主侧应用 → 结果如实回报（含被拒路径）', async () => {
  const applied = []
  const server = http.createServer((req, res) => {
    const deny = drainRequestError({ method: req.method, headers: req.headers, remoteAddress: req.socket.remoteAddress }, 'tok-1')
    if (deny) {
      res.writeHead(deny === '需 POST' ? 405 : 403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: deny }))
      return
    }
    applied.push('recallSummaryLen')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, applied: ['recallSummaryLen'], ignored: [], error: '', dropped: false }))
  })
  const port = await listen(server)
  try {
    const good = await triggerHostDrain({ port, token: 'tok-1' })
    assert.equal(good.ok, true, '令牌正确 → 应成功')
    assert.deepEqual(good.body.applied, ['recallSummaryLen'])
    assert.equal(applied.length, 1, '宿主侧真的执行了一次应用')

    const bad = await triggerHostDrain({ port, token: 'nope' })
    assert.equal(bad.ok, false)
    assert.equal(bad.status, 403, '令牌不对 → 403，且不能应用')
    assert.equal(applied.length, 1, '被拒的请求不能触发应用')

    const missing = await triggerHostDrain({ port, token: '' })
    assert.equal(missing.ok, false)
    assert.equal(missing.status, 0, '令牌未知（旧宿主 / 心跳没刷新）→ 不发请求，调用方回落到等待路径')
  } finally { server.close() }
})

test('宿主侧应用失败：回 ok:false + 原因（独立端不得报成功）', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, applied: [], ignored: [], error: 'HMR transactions cannot be nested', dropped: false }))
  })
  const port = await listen(server)
  try {
    const out = await triggerHostDrain({ port, token: 'tok' })
    assert.equal(out.ok, false)
    assert.match(out.error, /HMR transactions/)
  } finally { server.close() }
})

test('旧宿主没有这条路由：404 → 调用方按「回落」处理（不是失败）', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: '未知接口' }))
  })
  const port = await listen(server)
  try {
    const out = await triggerHostDrain({ port, token: 'tok' })
    assert.equal(out.status, 404)
    assert.equal(out.ok, false)
  } finally { server.close() }
})

test('源码守卫：宿主注册 drain 路由并把端口/令牌写进心跳；独立端保存时先叫醒宿主、失败才回落', () => {
  const index = read('index.js')
  assert.match(index, /API_PREFIX \+ '\/drain-pending'/, '宿主要有 drain 路由')
  assert.match(index, /drainRequestError\(\s*\{ method: req\.method/, '路由必须过守卫')
  assert.match(index, /writeHostMarker\(process\.env, \{ version: versionRef, port: hostDrainPort, token: hostDrainToken \}\)/, '心跳要带端口与令牌')
  assert.match(index, /hostDrainPort = Number\(webServer\.port\) \|\| 0/, 'webServer 就绪时要记录监听端口')
  const api = read('lib/api.js')
  assert.match(api, /triggerHostDrain\(\{ port: aliveHost\.port, token: aliveHost\.token/, '独立端要先叫醒宿主')
  assert.match(api, /if \(outcome === 'queued'\) outcome = await waitPendingOutcome/, '叫醒失败要回落到等待路径')
  const hb = read('lib/host-heartbeat.js')
  assert.match(hb, /port: Number\(data\.port\) \|\| 0/, '心跳读侧要带出端口')
  assert.match(hb, /token: String\(data\.token \|\| ''\)/, '心跳读侧要带出令牌')
})
