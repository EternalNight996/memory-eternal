// 管理面鉴权回归：/cloud/keys 与 /cloud/config 绝不能裸奔到公网
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCloudServer } from '../lib/cloud-server.js'

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-adm-'))
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  return Promise.resolve(fn(home)).finally(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ } })
}

/** 造一个最小 req/res，跑一遍云端 handler，返回 {status, body} */
function invoke(handler, { method = 'GET', path: sub, headers = {}, remoteAddress = '203.0.113.9', body = '' } = {}) {
  return new Promise((resolve) => {
    const chunks = []
    const req = {
      method,
      url: '/memory-eternal/api' + sub,
      headers,
      socket: { remoteAddress },
      on(evt, cb) {
        if (evt === 'data' && body) cb(Buffer.from(body))
        if (evt === 'end') cb()
        return this
      },
      destroy() {},
    }
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}) },
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = text
        try { parsed = JSON.parse(text) } catch { /* 保留原文 */ }
        resolve({ status: this.statusCode, body: parsed, headers: this.headers })
      },
      write() {},
      on() {},
    }
    Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 500, body: { error: String(e && e.message) } }))
  })
}

test('公网来源 + 未配 ADMIM_TOKEN → 签密钥被 403', () => withHome(async (home) => {
  const h = createCloudServer({ env: { ...process.env, DSH_HOME: home } })
  const r = await invoke(h, { method: 'POST', path: '/cloud/keys', body: '{"owner":"attacker"}', headers: { 'content-type': 'application/json' }, remoteAddress: '203.0.113.9' })
  assert.equal(r.status, 403)
  assert.equal(r.body.code, 'admin_required')
  assert.match(r.body.error, /仅允许本机/)
}))

test('公网来源 + 配了 ADMIN_TOKEN 但不带 → 403；带对 → 200', () => withHome(async (home) => {
  const env = { ...process.env, DSH_HOME: home, MEMORY_CLOUD_ADMIN_TOKEN: 'adm_secret_123' }
  const h = createCloudServer({ env })
  const denied = await invoke(h, { method: 'POST', path: '/cloud/keys', body: '{"owner":"x"}', headers: {}, remoteAddress: '203.0.113.9' })
  assert.equal(denied.status, 403)
  assert.match(denied.body.error, /管理令牌无效/)

  const ok = await invoke(h, {
    method: 'POST', path: '/cloud/keys', body: '{"owner":"alice"}',
    headers: { 'content-type': 'application/json', authorization: 'Bearer adm_secret_123' },
    remoteAddress: '203.0.113.9',
  })
  assert.equal(ok.status, 200)
  assert.ok(ok.body.token && ok.body.token.startsWith('me_'), '签发成功应返回明文密钥')
}))

test('X-Admin-Token 头也行', () => withHome(async (home) => {
  const h = createCloudServer({ env: { ...process.env, DSH_HOME: home, MEMORY_CLOUD_ADMIN_TOKEN: 'adm2' } })
  const r = await invoke(h, { method: 'POST', path: '/cloud/keys', body: '{"owner":"bob"}', headers: { 'x-admin-token': 'adm2', 'content-type': 'application/json' }, remoteAddress: '203.0.113.9' })
  assert.equal(r.status, 200)
}))

test('本机回环（未配 token）→ 放行；私网网段**不再**算本机（审计 S2）', () => withHome(async (home) => {
  const h = createCloudServer({ env: { ...process.env, DSH_HOME: home } })
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const r = await invoke(h, { method: 'POST', path: '/cloud/keys', body: '{"owner":"local"}', headers: { 'content-type': 'application/json' }, remoteAddress: ip })
    assert.equal(r.status, 200, ip + ' 应放行')
  }
  // 旧实现把整个 RFC1918 当"本机回环"：Docker 网桥 / K8s Pod / 同机房 VPC / 办公室局域网
  // 里的任何人都能 POST /cloud/keys {"owner":"受害者"} 自签密钥 → 直接拿下对方全部记忆。
  // 收紧后这些地址必须 403，并指向 MEMORY_CLOUD_ADMIN_TOKEN。
  for (const ip of ['172.17.0.1', '172.20.0.5', '10.0.0.5', '192.168.1.5']) {
    const r = await invoke(h, { method: 'POST', path: '/cloud/keys', body: '{"owner":"attacker"}', headers: { 'content-type': 'application/json' }, remoteAddress: ip })
    assert.equal(r.status, 403, ip + ' 是私网但**不是本机回环**，必须拒绝')
    assert.equal(r.body.code, 'admin_required')
    assert.match(r.body.hint, /MEMORY_CLOUD_ADMIN_TOKEN/, '要告诉用户去配 token')
  }
}))

test('本机回环但带反代头（x-forwarded-for）→ 不算本机直连（未配 token 时拒绝）', () => withHome(async (home) => {
  const h = createCloudServer({ env: { ...process.env, DSH_HOME: home } })
  const r = await invoke(h, {
    method: 'POST', path: '/cloud/keys', body: '{"owner":"x"}',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    remoteAddress: '127.0.0.1',
  })
  assert.equal(r.status, 403, '带反代头说明前面有代理，真实来源无法确认')
}))

test('/cloud/config 同样受管（公网裸访问被拦）', () => withHome(async (home) => {
  const h = createCloudServer({ env: { ...process.env, DSH_HOME: home, MEMORY_CLOUD_ADMIN_TOKEN: 'adm3' } })
  const r = await invoke(h, { method: 'GET', path: '/cloud/config', remoteAddress: '203.0.113.9' })
  assert.equal(r.status, 403)
  const ok = await invoke(h, { method: 'GET', path: '/cloud/config', headers: { authorization: 'Bearer adm3' }, remoteAddress: '203.0.113.9' })
  assert.equal(ok.status, 200)
  assert.ok(ok.body.license, '应有 license 摘要')
  assert.ok(ok.body.access, '应有 access 摘要')
}))

test('租户面不受影响：/cloud/whoami 仍要租户令牌（公网无令牌 → 401 而非 403）', () => withHome(async (home) => {
  const h = createCloudServer({ env: { ...process.env, DSH_HOME: home, MEMORY_CLOUD_ADMIN_TOKEN: 'adm4' } })
  const r = await invoke(h, { method: 'GET', path: '/cloud/whoami', remoteAddress: '203.0.113.9' })
  assert.equal(r.status, 401, '应走租户鉴权分支')
}))
