// 云端 CORS：客户端界面与云端是不同 origin，缺 CORS 头 = 浏览器直接拦（"连接云端直接失败"）。
// 守五件事：
//   ① 本机任意端口放行（本地 web / DSH 内嵌页）；
//   ② 自己的公网域名放行；
//   ③ 未知 origin 不给（防任意站盗用）；
//   ④ 预检 OPTIONS → 204 + 全套头，且**不被鉴权拦住**（浏览器预检不带 Authorization）；
//   ⑤ 显式白名单与 `*` 都支持。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createCloudServer, corsOriginAllowed } from '../lib/cloud-server.js'

const PUB = 'https://mem.mengbot.com.cn'

test('白名单：本机任意端口 / 自己的域名 / 显式列表 / 通配', () => {
  const env = { ...process.env, MEMORY_CLOUD_PUBLIC_URL: PUB }
  for (const o of ['http://127.0.0.1:7999', 'http://localhost:3000', 'http://[::1]:8080', PUB]) {
    assert.equal(corsOriginAllowed(o, env), o, o)
  }
  assert.equal(corsOriginAllowed('https://evil.com', env), '', '未知 origin 不给')
  assert.equal(corsOriginAllowed('', env), '', '空 origin 不给')
  assert.equal(corsOriginAllowed('https://foo.example', { ...env, MEMORY_CLOUD_CORS_ORIGINS: 'https://foo.example' }), 'https://foo.example')
  assert.equal(corsOriginAllowed('https://bar.example', { ...env, MEMORY_CLOUD_CORS_ORIGINS: '*' }), 'https://bar.example')
})

function withServer(env, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-cors-'))
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  const handler = createCloudServer({ env: { ...process.env, ...env, DSH_HOME: home } })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', async () => {
      try { await fn(`http://127.0.0.1:${srv.address().port}`) }
      finally { srv.close(); try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ } ; resolve() }
    })
  })
}

test('预检 OPTIONS → 204 + 全套 CORS 头（不被鉴权拦）', () => withServer({ MEMORY_CLOUD_PUBLIC_URL: PUB }, async (base) => {
  const r = await fetch(base + '/memory-eternal/api/overview', {
    method: 'OPTIONS',
    headers: { Origin: 'http://127.0.0.1:7999', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
  })
  assert.equal(r.status, 204, '预检必须 204（不能 401，否则浏览器判失败）')
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://127.0.0.1:7999')
  assert.equal(r.headers.get('access-control-allow-credentials'), 'true')
  assert.match(String(r.headers.get('access-control-allow-methods')), /GET/)
  assert.match(String(r.headers.get('access-control-allow-headers')), /Authorization/i)
}))

test('白名单 origin 的实际请求带 ACAO；非白名单不带', () => withServer({ MEMORY_CLOUD_PUBLIC_URL: PUB }, async (base) => {
  const ok = await fetch(base + '/memory-eternal/api/overview', { headers: { Origin: 'http://127.0.0.1:7999' } })
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://127.0.0.1:7999')
  const bad = await fetch(base + '/memory-eternal/api/overview', { headers: { Origin: 'https://evil.com' } })
  assert.equal(bad.headers.get('access-control-allow-origin'), null, '非白名单不能给 ACAO')
}))

test('管理面也要有 CORS（客户端可能在设置页调 /cloud/config）', () => withServer({ MEMORY_CLOUD_PUBLIC_URL: PUB, MEMORY_CLOUD_ADMIN_TOKEN: 'adm' }, async (base) => {
  const r = await fetch(base + '/memory-eternal/api/cloud/config', {
    method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:7999', 'Access-Control-Request-Method': 'GET' },
  })
  assert.equal(r.status, 204)
  assert.equal(r.headers.get('access-control-allow-origin'), 'http://127.0.0.1:7999')
  // 实际请求：带管理令牌才 200，但 CORS 头要在（否则浏览器读不到响应）
  const real = await fetch(base + '/memory-eternal/api/cloud/config', { headers: { Origin: 'http://127.0.0.1:7999', Authorization: 'Bearer adm' } })
  assert.equal(real.status, 200)
  assert.equal(real.headers.get('access-control-allow-origin'), 'http://127.0.0.1:7999')
}))

test('X-MengBot-* 与 X-Admin-Token 都在 Allow-Headers 里', () => withServer({ MEMORY_CLOUD_PUBLIC_URL: PUB }, async (base) => {
  const r = await fetch(base + '/memory-eternal/api/cloud/webhook/mengbot', {
    method: 'OPTIONS',
    headers: { Origin: 'http://127.0.0.1:7999', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-mengbot-signature,x-admin-token' },
  })
  const allow = String(r.headers.get('access-control-allow-headers'))
  for (const h of ['X-MengBot-Signature', 'X-Admin-Token', 'Authorization', 'Content-Type']) {
    assert.ok(new RegExp(h, 'i').test(allow), h + ' 应在 Allow-Headers 里')
  }
}))
