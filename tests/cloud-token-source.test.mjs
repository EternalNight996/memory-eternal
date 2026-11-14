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

test('mba_（管理员令牌）拒绝 —— 对方 C3 明确「不要发给第三方」', () => withServer({}, async (base) => {
  const r = await fetch(base + '/memory-eternal/api/cloud/whoami', { headers: { Authorization: 'Bearer mba_abcdefghij' } })
  assert.equal(r.status, 401)
  const b = await r.json()
  assert.match(String(b.error), /管理员令牌/, '要说清 mba_ 是管理员令牌')
  assert.match(String(b.error), /mbt_/, '要指引去建 mbt_ 令牌')
}))

// ── 会话令牌只存 hash（云端的 cloud-keys.json 是全局单文件）──────────────
// 明文会话令牌 = "能冒充该用户的密码"，而 cloud-keys.json 所有租户共用，
// 一旦泄漏全员沦陷。改成只存 sha256，校验时算 hash 比对。
test('会话令牌只存 hash：文件里不出现明文，但登录仍可用', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { issueSessionTokenForOwner, resolveTenant, revokeSessionToken } = await import('../lib/cloud-auth.js')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-sess-'))
  const env = { ...process.env, DSH_HOME: home }
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }))

  const issued = issueSessionTokenForOwner('s@x.com', 'oidc', env)
  const token = issued.token || issued
  const rawText = fs.readFileSync(path.join(home, 'cloud-keys.json'), 'utf8')
  assert.equal(rawText.includes(String(token)), false, '明文令牌不能出现在文件里')
  const sess = JSON.parse(rawText).mengbot.sessions[0]
  assert.ok(sess.tokenHash, '应存 tokenHash')
  assert.equal(sess.token, undefined, '不该再存明文 token')

  // 校验仍然通过
  const ok = resolveTenant('Bearer ' + token, env)
  assert.equal(ok.ok, true)
  assert.equal(ok.owner, 's@x.com')

  // 吊销后失效
  assert.equal(revokeSessionToken(token, env).ok, true)
  assert.equal(resolveTenant('Bearer ' + token, env).ok, false)

  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

test('老格式（存明文 token）的记录仍能校验 —— 兼容迁移前的数据', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { resolveTenant } = await import('../lib/cloud-auth.js')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-sess2-'))
  const env = { ...process.env, DSH_HOME: home }
  // 手工造一条老格式记录
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({
    version: 1, keys: [],
    mengbot: { sessions: [{ token: 'mb_legacy_plaintext_123', owner: 'old@x.com', via: 'oidc', expiresAt: new Date(Date.now() + 86400000).toISOString() }] },
  }))
  const r = resolveTenant('Bearer mb_legacy_plaintext_123', env)
  assert.equal(r.ok, true, '老记录必须还能用（否则迁移会踢掉所有人）')
  assert.equal(r.owner, 'old@x.com')
  try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
})
