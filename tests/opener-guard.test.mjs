// 回归：「打开浏览器」类端点的来源闸门与频率限制。
//
// 背景（用户提出）：/open-web 与 /open-external 都是无鉴权端点。
// 浏览器跨域 fetch 会被 CORS 拦，但 <form> 提交不受 CORS 限制 ——
// 恶意页面可以循环自动提交把用户机器上的浏览器窗口刷爆。
// 所以两道闸：Origin 校验 + 3 秒限流。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApi, guardOpenerCall } from '../lib/api.js'

/** 起一个最小 API 服务（临时库），返回 { base, close }。 */
async function boot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-guard-'))
  const h = createApi({
    vaultDir: () => tmp,
    vaultRoots: () => [{ name: '', root: tmp }],
    getSettings: () => ({}),
    getCaptureLog: () => null,
  })
  const srv = http.createServer((q, r) => h(q, r))
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return {
    base: `http://127.0.0.1:${srv.address().port}/memory-eternal/api`,
    close() {
      srv.close()
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }
    },
  }
}

const post = async (base, p, origin, host) => {
  const headers = { 'Content-Type': 'application/json' }
  if (origin) headers.Origin = origin
  // Host 可覆盖：用于构造「Origin 与 Host 同源」的真实本机 UI 场景。
  // 不覆盖时 Node 会写自己的 Host（不同端口的测试服务器），Origin 一变就成跨源。
  if (host) headers.Host = host
  const r = await fetch(base + p, { method: 'POST', headers })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('无 Origin（本机/服务端调用）放行', async () => {
  const { base, close } = await boot()
  try {
    const r = await post(base, '/open-web')
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, true)
  } finally { close() }
})

test('恶意站点 Origin 被拒（防 <form> 循环提交）', async () => {
  const { base, close } = await boot()
  try {
    const r = await post(base, '/open-web', 'https://evil.example.com')
    assert.ok(r.status === 403 || r.status === 429, '恶意来源必须被拒，实际 ' + r.status)
    assert.equal(r.body.ok, false)
  } finally { close() }
})

test('Origin: null（file:// 或沙箱 iframe）被拒', async () => {
  const { base, close } = await boot()
  try {
    const r = await post(base, '/open-web', 'null')
    assert.notEqual(r.status, 200)
    assert.equal(r.body.ok, false)
  } finally { close() }
})

/** 造一个最小的 mock request 给 guardOpenerCall 用。 */
const mockReq = (origin, addr = '127.0.0.1', port = 1) => ({
  headers: origin === undefined ? {} : { origin },
  socket: { remoteAddress: addr, localPort: port },
})

test('本机 Origin（127.0.0.1 / localhost / ::1）放行', () => {
  // 用不同的 localPort 让三次调用各自独立计数
  for (const [i, origin] of ['http://127.0.0.1:7999', 'http://localhost:7999', 'http://[::1]:7999'].entries()) {
    const r = guardOpenerCall(mockReq(origin, '127.0.0.1', 100 + i), 'unit')
    assert.equal(r.ok, true, origin + ' 应放行：' + JSON.stringify(r))
  }
})

test('公网 Origin 被拒（这是防 <form> 循环提交的关键）', () => {
  const r = guardOpenerCall(mockReq('https://evil.example.com', '127.0.0.1', 200), 'unit')
  assert.equal(r.ok, false)
  assert.match(String(r.code || ''), /origin_denied/)
})

test('Origin: null 被拒（file:// 与沙箱 iframe）', () => {
  const r = guardOpenerCall(mockReq('null', '127.0.0.1', 300), 'unit')
  assert.equal(r.ok, false)
  assert.match(String(r.code || ''), /origin_denied/)
})

test('频率限制：3 秒内第二次被挡，等一下又能用', async () => {
  const { base, close } = await boot()
  try {
    const a = await post(base, '/open-web')
    assert.equal(a.status, 200, '第一次应放行')
    const b = await post(base, '/open-web')
    assert.equal(b.status, 429, '紧接着的第二次必须被限流')
    assert.equal(b.body.code, 'too_frequent')
    await sleep(3200)
    const c = await post(base, '/open-web')
    assert.equal(c.status, 200, '过了窗口应恢复')
  } finally { close() }
})

test('两个端点各自独立计数（不会互相拖累）', async () => {
  const { base, close } = await boot()
  try {
    const a = await post(base, '/open-web')
    assert.equal(a.status, 200)
    // 紧接着打 open-external，应按它自己的窗口放行
    const b = await post(base, '/open-external?url=https://github.com/EternalNight996/memory-eternal')
    assert.equal(b.status, 200, '不同端点不该共享限流窗口')
  } finally { close() }
})

test('open-external 白名单：GitHub 仓库放行', async () => {
  const { base, close } = await boot()
  try {
    const r = await post(base, '/open-external?url=' + encodeURIComponent('https://github.com/EternalNight996/memory-eternal'))
    assert.equal(r.body.ok, true)
  } finally { close() }
})

test('open-external 白名单：非白名单域名被拒', async () => {
  const { base, close } = await boot()
  try {
    const r = await post(base, '/open-external?url=' + encodeURIComponent('https://evil.example.com/payload'))
    assert.equal(r.body.ok, false)
    assert.match(String(r.body.error || ''), /not allowed/)
  } finally { close() }
})

