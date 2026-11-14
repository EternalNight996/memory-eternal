// 令牌来源：**Authorization 头优先，其次 HttpOnly cookie**。
//
// 为什么要两条路：登录成功后服务端种 cookie。同源场景（页面就跑在 mem.mengbot.com.cn）
// 浏览器自动带 cookie；跨域场景（127.0.0.1 调云端）cookie 因 SameSite=Lax 不会带，
// 靠前端显式 Authorization。缺了 cookie 这条，用户明明登录过却看到
// 「缺少 Authorization: Bearer <token>」—— 这是真事故。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createCloudServer } from '../lib/cloud-server.js'

function withServer(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-tok-'))
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  const handler = createCloudServer({ env: { ...process.env, DSH_HOME: home, MEMORY_CLOUD_PUBLIC_URL: 'https://mem.mengbot.com.cn' } })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', async () => {
      try { await fn(`http://127.0.0.1:${srv.address().port}`, home) }
      finally { srv.close(); resolve() }
    })
  })
}

/** 签一把租户密钥 */
async function issueToken(base) {
  const r = await fetch(base + '/memory-eternal/api/cloud/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: 'cookieuser' }),
  })
  const j = await r.json()
  assert.equal(j.ok, true, '签发应成功')
  return j.token
}

test('完全没令牌 → 401 + code=no_token + 可操作提示', () => withServer(async (base) => {
  const r = await fetch(base + '/memory-eternal/api/overview')
  assert.equal(r.status, 401)
  const b = await r.json()
  assert.equal(b.code, 'no_token')
  assert.match(String(b.hint), /用 MengBot 账号登录|访问密钥/, '提示要能指导下一步')
}))

test('仅 cookie 就能访问（同源登录后的场景）', () => withServer(async (base) => {
  const token = await issueToken(base)
  const r = await fetch(base + '/memory-eternal/api/overview', { headers: { cookie: 'me_cloud_token=' + token } })
  assert.equal(r.status, 200, '带有效 cookie 应该 200（之前这里是 401）')
  const b = await r.json()
  assert.match(String(b.vaultDir || ''), /cloud-vaults[\\/]cookieuser/)
}))

test('仅 Authorization 也能访问（跨域场景）', () => withServer(async (base) => {
  const token = await issueToken(base)
  const r = await fetch(base + '/memory-eternal/api/overview', { headers: { Authorization: 'Bearer ' + token } })
  assert.equal(r.status, 200)
}))

test('Authorization 优先于 cookie（两者都在时用 header）', () => withServer(async (base) => {
  const good = await issueToken(base)
  const bad = 'me_bogus_token'
  const r = await fetch(base + '/memory-eternal/api/overview', {
    headers: { Authorization: 'Bearer ' + good, cookie: 'me_cloud_token=' + bad },
  })
  assert.equal(r.status, 200, 'header 有效时不该被坏 cookie 拖累')
}))

test('whoami 也认 cookie', () => withServer(async (base) => {
  const token = await issueToken(base)
  const r = await fetch(base + '/memory-eternal/api/cloud/whoami', { headers: { cookie: 'me_cloud_token=' + token } })
  assert.equal(r.status, 200)
  const b = await r.json()
  assert.equal(b.owner, 'cookieuser')
}))

test('无效 cookie → 401 + code=invalid_token（与「没令牌」区分开）', () => withServer(async (base) => {
  const r = await fetch(base + '/memory-eternal/api/overview', { headers: { cookie: 'me_cloud_token=bogus' } })
  assert.equal(r.status, 401)
  const b = await r.json()
  assert.equal(b.code, 'invalid_token')
  assert.match(String(b.hint), /重新登录|重新填/, '要提示重新登录')
}))

test('billing / connect 等也是同一套令牌来源', () => withServer(async (base) => {
  const token = await issueToken(base)
  for (const p of ['/cloud/billing/plan']) {
    const r = await fetch(base + '/memory-eternal/api' + p, { headers: { cookie: 'me_cloud_token=' + token } })
    assert.equal(r.status, 200, p + ' 应认 cookie')
  }
  const c = await fetch(base + '/memory-eternal/api/cloud/connect', { method: 'POST', headers: { cookie: 'me_cloud_token=' + token } })
  assert.equal(c.status, 200, 'connect 应认 cookie')
}))

test('mbo_ 前缀（MengBot OAuth 令牌）给出正确指引，而不是笼统的「无法识别」', () => withServer({}, async (base) => {
  const r = await fetch(base + '/memory-eternal/api/cloud/whoami', { headers: { Authorization: 'Bearer mbo_QGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' } })
  assert.equal(r.status, 401)
  const b = await r.json()
  assert.match(String(b.error), /MengBot 的 OAuth 令牌/, '要说清 mbo_ 是什么')
  assert.match(String(b.error), /用 MengBot 账号登录/, '要给出正确做法')
}))
