// Host 白名单（审计 H1）：DNS rebinding 防护。
//
// 旧闸门只比 `Origin === Host`，而 DNS rebinding 的攻击前提正是**两者相等**：
// 攻击者让 `evil.com` 先解析到自己的服务器，TTL 到期后改解析到 `127.0.0.1`；
// 浏览器认为请求同源，于是 `Origin: http://evil.com:7999` 与 `Host: evil.com:7999` 必然相同，
// 闸门放行、响应对页面可读 —— 任意网页就能打 `/factory-reset`、`/backup/import`、`/config`
// 这些**本来就无鉴权**的写接口。
//
// 放行集：IP 字面量 / localhost / 显式配置的公开域名（MEMORY_PUBLIC_HOST、
// MEMORY_CLOUD_PUBLIC_URL、MEMORY_PUBLIC_URL、MEMORY_TRUSTED_HOSTS）。**DNS 名 + 没配置 = 拒绝**。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApi, crossOriginError, hostAllowed, API_PREFIX } from '../lib/api.js'
import { ensureVault } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'

const ENV_KEYS = ['MEMORY_PUBLIC_HOST', 'MEMORY_CLOUD_PUBLIC_URL', 'MEMORY_PUBLIC_URL', 'MEMORY_TRUSTED_HOSTS']
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k] }
clearEnv()
after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const post = (origin, host) => ({ method: 'POST', headers: { origin, host } })

test('H1：Origin==Host 但 Host 是**未配置的域名** → 拒绝（DNS rebinding 的主场景）', () => {
  clearEnv()
  for (const h of ['evil.com:7999', 'evil.com', 'rebind.example:19387', 'attacker.test']) {
    const msg = crossOriginError(post('http://' + h, h))
    assert.match(msg, /Host 不在允许列表（DNS rebinding 防护）/, h + ' 必须被拒')
  }
  // 顺带：https 站点同样拒（rebinding 不依赖协议）
  assert.match(crossOriginError(post('https://evil.com', 'evil.com')), /Host 不在允许列表/)
})

test('H1：IP 字面量 / localhost / [::1] 一律放行（DNS 造不出 IP 字面量）', () => {
  clearEnv()
  const ok = [
    ['http://127.0.0.1:7999', '127.0.0.1:7999'],
    ['http://127.0.0.1:19387', '127.0.0.1:19387'],
    ['http://localhost:7999', 'localhost:7999'],
    ['http://[::1]:7999', '[::1]:7999'],
    ['http://192.168.1.5:7999', '192.168.1.5:7999'],   // 局域网直连（同源）
    ['http://10.1.2.3:7999', '10.1.2.3:7999'],
  ]
  for (const [origin, host] of ok) assert.equal(crossOriginError(post(origin, host)), '', origin + ' 应放行')
})

test('H1：配置了公开域名才放行（MEMORY_PUBLIC_HOST / MEMORY_CLOUD_PUBLIC_URL / TRUSTED_HOSTS）', () => {
  clearEnv()
  // 未配置 → 拒
  assert.match(crossOriginError(post('http://mem.example.com', 'mem.example.com')), /Host 不在允许列表/)

  // MEMORY_PUBLIC_HOST（裸主机名）
  process.env.MEMORY_PUBLIC_HOST = 'mem.example.com'
  assert.equal(crossOriginError(post('http://mem.example.com', 'mem.example.com')), '', 'MEMORY_PUBLIC_HOST 应放行')
  assert.equal(crossOriginError(post('http://mem.example.com:8443', 'mem.example.com:8443')), '', '带端口也要认')
  clearEnv()

  // MEMORY_CLOUD_PUBLIC_URL（完整 URL，要能解析出主机名）
  process.env.MEMORY_CLOUD_PUBLIC_URL = 'https://mem.mengbot.com.cn/'
  assert.equal(crossOriginError(post('https://mem.mengbot.com.cn', 'mem.mengbot.com.cn')), '', 'PUBLIC_URL 应放行')
  assert.match(crossOriginError(post('https://other.mengbot.com.cn', 'other.mengbot.com.cn')), /Host 不在允许列表/)
  clearEnv()

  // MEMORY_TRUSTED_HOSTS（逗号分隔）
  process.env.MEMORY_TRUSTED_HOSTS = 'a.example.com, b.example.com:8443'
  assert.equal(crossOriginError(post('http://a.example.com', 'a.example.com')), '')
  assert.equal(crossOriginError(post('https://b.example.com:8443', 'b.example.com:8443')), '')
  clearEnv()
})

test('H1：读请求不受 Host 闸门影响；没有 Host/Origin 的非浏览器调用照旧放行', () => {
  clearEnv()
  assert.equal(crossOriginError({ method: 'GET', headers: { origin: 'http://evil.com', host: 'evil.com' } }), '', 'GET 无副作用，不该被拦')
  assert.equal(crossOriginError({ method: 'HEAD', headers: { origin: 'http://evil.com', host: 'evil.com' } }), '')
  assert.equal(crossOriginError({ method: 'POST', headers: {} }), '', '没有 Origin（curl/CLI/MCP）放行')
  assert.equal(crossOriginError({ method: 'POST', headers: { origin: 'http://evil.com' } }), '', '缺 Host 的调用不误伤')
  // 自定义 scheme（桌面壳）网页伪造不出来
  assert.equal(crossOriginError(post('app://dsh', 'evil.com')), '')
})

test('H1：本机页面 → 云端（Origin 是 loopback、Host 是云端域名）仍然放行', () => {
  clearEnv()
  // 这是产品的正常链路：页面在 127.0.0.1:7999，把数据推到云端。
  // 不靠 Host 白名单放行，靠「Origin 是 loopback = 自家页面」这一条。
  assert.equal(crossOriginError(post('http://127.0.0.1:7999', 'mem.mengbot.com.cn')), '')
  assert.equal(crossOriginError(post('http://localhost:7999', 'mem.mengbot.com.cn')), '')
  // 但非 loopback 的 origin 冒充不了：未配置时被 Host 闸门先挡住
  assert.match(crossOriginError(post('http://evil.com', 'mem.mengbot.com.cn')), /Host 不在允许列表/)
  // 即便把云端域名配进白名单，evil.com 的页面依然是跨站 → 第二道闸门照旧拒
  process.env.MEMORY_PUBLIC_HOST = 'mem.mengbot.com.cn'
  assert.match(crossOriginError(post('http://evil.com', 'mem.mengbot.com.cn')), /跨站写入被拒/)
  clearEnv()
})

test('H1：hostAllowed 的判定表（导出函数，宿主 index.js 共用同一份）', () => {
  clearEnv()
  assert.equal(hostAllowed({ host: '127.0.0.1:7999' }), true)
  assert.equal(hostAllowed({ host: '[::1]:7999' }), true)
  assert.equal(hostAllowed({ host: 'localhost' }), true)
  assert.equal(hostAllowed({ host: 'evil.com' }), false)
  assert.equal(hostAllowed({}), true, '无 Host = 非浏览器调用')
  assert.equal(hostAllowed({ host: '' }), true)
})

test('H1 端到端：Host 是域名且未配置 → 写请求 403 CROSS_ORIGIN_BLOCKED，读请求照常', async () => {
  clearEnv()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-host-'))
  const vault = path.join(dir, 'vault')
  await ensureVault(vault)
  const api = createApi({ vaultDir: () => vault, getSettings: () => ({}) })
  const call = async (method, headers) => {
    const out = { status: 0, body: '' }
    const res = { writeHead(s) { out.status = s }, end(b) { out.body = String(b || '') }, setHeader() {}, on() {}, once() {}, emit() {} }
    const req = { url: API_PREFIX + '/vaults', method, headers, [Symbol.asyncIterator]: async function* () {} }
    await api(req, res)
    return out
  }
  try {
    const blocked = await call('POST', { origin: 'http://evil.com:7999', host: 'evil.com:7999', 'content-type': 'application/json' })
    assert.equal(blocked.status, 403, 'rebinding 写请求必须 403')
    assert.match(blocked.body, /CROSS_ORIGIN_BLOCKED/)
    assert.match(blocked.body, /DNS rebinding/, '文案要说明是 rebinding 防护')

    const readOk = await call('GET', { origin: 'http://evil.com:7999', host: 'evil.com:7999' })
    assert.equal(readOk.status, 200, '读接口不受影响')

    const local = await call('POST', { origin: 'http://127.0.0.1:7999', host: '127.0.0.1:7999', 'content-type': 'application/json' })
    assert.doesNotMatch(local.body, /CROSS_ORIGIN_BLOCKED/, '本机页面正常放行')
  } finally {
    closeAllDb()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})
