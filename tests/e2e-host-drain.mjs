// 方案 A 的**真端到端**验收（真起进程，不是打桩）：
//   独立 web（lib/web.js，真进程、独立 DSH_HOME）
//     → 保存 → 读心跳拿到「宿主端口 + 令牌」→ 叫醒宿主 drain 路由
//     → 宿主在**请求处理器**里应用 pending（这里用真 drainPendingConfig + 真守卫）
//     → 独立端把「已应用」如实回报给调用方。
//
// 与 tests/host-drain.test.mjs 的分工：那边测协议单元；这边测「两端真起来以后能不能跑通」，
// 因为本机实测的结论（回调里写配置必被守卫拒、请求里能提交）正是靠这种端到端才说得清。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { drainRequestError, drainPendingConfig, pendingConfigPath, readPendingConfig } from '../lib/config-sync.js'
import { hostMarkerPath } from '../lib/host-heartbeat.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.on('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const waitFor = async (fn, { timeoutMs = 8000, stepMs = 120 } = {}) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { const v = await fn(); if (v) return v } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

test('端到端：独立 web（真进程）保存 → 叫醒宿主 drain 路由 → 宿主在请求上下文应用 → 回报「已应用」', { timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-e2e-drain-'))
  const env = { ...process.env, DSH_HOME: home }
  const token = 'e2e-token-42'
  const applied = []
  // 假宿主：真守卫 + 真 drainPendingConfig，apply 只把 patch 记下来（真宿主这一步是 settings.update）
  const host = http.createServer(async (req, res) => {
    const deny = drainRequestError({ method: req.method, headers: req.headers, remoteAddress: req.socket.remoteAddress }, token)
    if (deny || !req.url.startsWith('/memory-eternal/api/drain-pending')) {
      res.writeHead(deny ? 403 : 404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: deny || '未知接口' }))
      return
    }
    const out = await drainPendingConfig(env, async (patch) => { applied.push(patch) })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, applied: Object.keys(out || {}), ignored: [], error: '', dropped: false }))
  })
  const hostPort = await new Promise((resolve) => host.listen(0, '127.0.0.1', () => resolve(host.address().port)))
  const webPort = await freePort()
  const child = spawn(process.execPath, [path.join(root, 'lib', 'web.js'), '--port', String(webPort)], {
    env: { ...env, MEMORY_WEB_PORT: String(webPort) },
    stdio: 'ignore',
    windowsHide: true,
  })
  try {
    await waitFor(async () => {
      const r = await fetch('http://127.0.0.1:' + webPort + '/memory-eternal/api/config', { signal: AbortSignal.timeout(1500) })
      return r.ok
    })
    // 心跳：宿主端口 + 令牌（真实宿主由 index.js 的 beatHostMarker 写）
    fs.writeFileSync(hostMarkerPath(env), JSON.stringify({ pid: process.pid, at: Date.now(), version: '0.10.8', port: hostPort, token }, null, 2))
    const res = await fetch('http://127.0.0.1:' + webPort + '/memory-eternal/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { recallSummaryLen: 137 }, expectedRevision: 0 }),
      signal: AbortSignal.timeout(8000),
    })
    const body = await res.json()
    assert.equal(body.pendingOutcome, 'applied', '应回报「宿主已应用」而不是 queued：' + JSON.stringify(body))
    assert.equal(body.pending.length, 0, '已应用 → 不该再报「仍待应用」')
    assert.equal(applied.length, 1, '宿主侧应收到一次 drain 调用')
    assert.equal(applied[0].recallSummaryLen, 137, '宿主收到的正是用户保存的值')
    assert.equal(readPendingConfig(env), null, '应用成功后 pending 文件应被消费掉')
  } finally {
    child.kill()
    host.close()
    await new Promise((r) => setTimeout(r, 200))
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 清理失败无妨 */ }
  }
})

test('端到端（回落）：心跳里没有端口/令牌（旧宿主）→ 独立端不硬闯，退回「排队等待」语义', { timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-e2e-drain-old-'))
  const env = { ...process.env, DSH_HOME: home }
  const webPort = await freePort()
  const child = spawn(process.execPath, [path.join(root, 'lib', 'web.js'), '--port', String(webPort)], {
    env: { ...env, MEMORY_WEB_PORT: String(webPort) },
    stdio: 'ignore',
    windowsHide: true,
  })
  try {
    await waitFor(async () => {
      const r = await fetch('http://127.0.0.1:' + webPort + '/memory-eternal/api/config', { signal: AbortSignal.timeout(1500) })
      return r.ok
    })
    // 旧版宿主的心跳：只有 pid/at/version（没有 port/token）
    fs.writeFileSync(hostMarkerPath(env), JSON.stringify({ pid: process.pid, at: Date.now(), version: '0.10.6' }, null, 2))
    const res = await fetch('http://127.0.0.1:' + webPort + '/memory-eternal/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch: { recallSummaryLen: 138 }, expectedRevision: 0 }),
      signal: AbortSignal.timeout(8000),
    })
    const body = await res.json()
    assert.equal(body.pendingOutcome, 'queued', '旧宿主上不能报「已应用」：' + JSON.stringify(body))
    assert.equal(body.pending.length, 1, '改动要留在 pending 里等宿主（旧路径）')
    assert.notEqual(readPendingConfig(env), null, 'pending 文件要保留')
  } finally {
    child.kill()
    await new Promise((r) => setTimeout(r, 200))
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 清理失败无妨 */ }
  }
})
