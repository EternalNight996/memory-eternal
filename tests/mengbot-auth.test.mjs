// MengBot 云端账号授权：**按 mengbot control-plane 的真实机制**（better-auth + 邮箱 OTP + bearer），
// 不是 OAuth2 的 code 换 token。守四件事：
//   ① {email} → 代发 OTP，返回 pending（不落状态）；
//   ② {email,otp} → 登录换 token → /v1/me 校验 → 签发本地令牌 → 解析回独立租户；
//   ③ mb_install_* 设备凭据走 /v1/installations/self；
//   ④ 令牌无效 / 不在 allowList / 未配 baseUrl → 都返回明确原因。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyMengbotLogin, resolveTenant, readMengbotConfig } from '../lib/cloud-auth.js'

function withHome(fn, mengbot = { baseUrl: 'https://cloud.mengbot.example' }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mb-'))
  const env = { ...process.env, DSH_HOME: home }
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot }), { mode: 0o600 })
  return Promise.resolve(fn(env, home)).finally(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ } })
}

/** 假 mengbot：按 control-plane 的真实路径与响应形状 */
const fakeMengbot = (calls) => async (url, init = {}) => {
  calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, auth: (init.headers || {}).Authorization })
  if (url.endsWith('/api/auth/email-otp/send-verification-otp')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
  if (url.endsWith('/api/auth/sign-in/email-otp')) {
    const b = JSON.parse(init.body)
    if (b.otp === '12345678') return { ok: true, status: 200, json: async () => ({ token: 'utoken_ok', user: { id: 'u1', email: 'yg@example.com' } }) }
    return { ok: false, status: 401, json: async () => ({ code: 'INVALID_OTP', message: 'invalid code' }) }
  }
  if (url.endsWith('/v1/me')) {
    return init.headers.Authorization === 'Bearer utoken_ok'
      ? { ok: true, status: 200, json: async () => ({ user: { id: 'u1', email: 'yg@example.com', name: 'YG' } }) }
      : { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }
  }
  if (url.endsWith('/v1/installations/self')) {
    return init.headers.Authorization === 'Bearer mb_install_abc.def'
      ? { ok: true, status: 200, json: async () => ({ installation: { id: 'inst-1', name: 'PC' } }) }
      : { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }
  }
  return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
}

test('未配置 baseUrl → 明确原因（不发请求）', () => withHome(async (env) => {
  const r = await verifyMengbotLogin({ token: 'x', env })
  assert.equal(r.ok, false)
  assert.match(r.error, /未配置 MengBot 云地址/)
}, {}))

test('{email} → 代发 OTP，返回 pending（第二步要把 otp 带回来）', () => withHome(async (env) => {
  const calls = []
  const r = await verifyMengbotLogin({ email: 'yg@example.com', env, fetchImpl: fakeMengbot(calls) })
  assert.equal(r.ok, true)
  assert.equal(r.pending, true)
  assert.equal(r.step, 'otp-sent')
  assert.equal(calls[0].url, 'https://cloud.mengbot.example/api/auth/email-otp/send-verification-otp')
  assert.deepEqual(calls[0].body, { email: 'yg@example.com' })
}))

test('{email,otp} → 登录换 token → /v1/me 校验 → 签发本地令牌 + 独立租户', () => withHome(async (env) => {
  const calls = []
  const r = await verifyMengbotLogin({ email: 'yg@example.com', otp: '12345678', env, fetchImpl: fakeMengbot(calls) })
  assert.equal(r.ok, true)
  assert.equal(r.owner, 'yg@example.com')
  assert.equal(r.via, 'mengbot')
  assert.match(r.token, /^mb_/)
  assert.ok(r.vaultRoot.endsWith(path.join('cloud-vaults', 'yg_example.com')) || r.vaultRoot.includes('yg'), '租户目录按 owner 生成')
  // 本地令牌能解析回租户
  const t = resolveTenant('Bearer ' + r.token, env)
  assert.equal(t.ok, true)
  assert.equal(t.owner, 'yg@example.com')
  assert.equal(t.via, 'mengbot')
  // 调用顺序：sign-in/email-otp → /v1/me
  assert.match(calls[0].url, /sign-in\/email-otp$/)
  assert.match(calls[1].url, /\/v1\/me$/)
}))

test('OTP 错误 → 明确报错（不签发本地令牌）', () => withHome(async (env) => {
  const r = await verifyMengbotLogin({ email: 'yg@example.com', otp: '00000000', env, fetchImpl: fakeMengbot([]) })
  assert.equal(r.ok, false)
  assert.match(r.error, /MengBot 登录失败/)
}))

test('设备凭据 mb_install_* 走 /v1/installations/self，owner 是安装 id', () => withHome(async (env) => {
  const calls = []
  const r = await verifyMengbotLogin({ token: 'mb_install_abc.def', env, fetchImpl: fakeMengbot(calls) })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'mengbot-install')
  assert.match(r.owner, /^mb-inst-/)
  assert.match(calls[0].url, /\/v1\/installations\/self$/)
  // resolveTenant 现在透传 session 里的 via（设备凭据保留 'mengbot-install'，便于区分来源）
  assert.equal(resolveTenant('Bearer ' + r.token, env).via, 'mengbot-install')
}))

test('令牌无效 → 401 原因；allowList 之外被拒', () => withHome(async (env) => {
  const bad = await verifyMengbotLogin({ token: 'utoken_bad', env, fetchImpl: fakeMengbot([]) })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /令牌无效/)
}))

test('allowList 生效', () => withHome(async (env) => {
  const r = await verifyMengbotLogin({ token: 'utoken_ok', env, fetchImpl: fakeMengbot([]) })
  assert.equal(r.ok, false)
  assert.match(r.error, /allowList/)
}, { baseUrl: 'https://cloud.mengbot.example', allowList: ['someone-else'] }))

test('配置只暴露 baseUrl / 路径 / allowList，不返回任何令牌', () => withHome(async (env) => {
  const cfg = readMengbotConfig(env)
  assert.equal(cfg.baseUrl, 'https://cloud.mengbot.example')
  assert.deepEqual(cfg.allowList, [])
  assert.ok(cfg.ttlHours >= 1)
}))
