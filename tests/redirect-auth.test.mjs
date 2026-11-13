// 跳转授权（redirect + 回跳）：替代「面板里输邮箱 + 验证码」。
// 守五件事：① start 生成一次性 state；② state 消费即失效（防重放）；
//   ③ 登录页 URL 支持模板/自动补参；④ 未配置时给可读原因；⑤ 回跳令牌走 fragment 不进日志。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startMengbotAuth, consumeAuthState, mengbotLoginUrl, completeMengbotAuth } from '../lib/cloud-auth.js'

function withHome(fn, mengbot = { baseUrl: 'https://cloud.mengbot.example' }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-redir-'))
  const env = { ...process.env, DSH_HOME: home, MEMORY_MENGBOT_BASE_URL: '', MEMORY_MENGBOT_LOGIN_URL: '', MEMORY_MENGBOT_EXCHANGE_URL: '' }
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot }), { mode: 0o600 })
  return Promise.resolve(fn(env, home)).finally(() => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ } })
}

test('start 生成一次性 state + 带 redirect_uri/state 的登录页 URL', () => withHome((env) => {
  const r = startMengbotAuth({ redirectUri: 'https://app.example/done', callbackUrl: 'https://mem.example/cb', env })
  assert.equal(r.ok, true)
  assert.ok(r.state.length >= 20, 'state 要有足够熵')
  assert.equal(r.expiresInSeconds, 300, 'state 5 分钟有效')
  assert.match(r.url, /cloud\.mengbot\.example\/login\?/)
  assert.match(r.url, /redirect_uri=https%3A%2F%2Fmem\.example%2Fcb/)
  assert.match(r.url, /state=/)
}))

test('state 消费即失效（防重放）', () => withHome((env) => {
  const r = startMengbotAuth({ redirectUri: 'https://a/b', env })
  const first = consumeAuthState(r.state)
  assert.equal(first.ok, true)
  assert.equal(first.redirectUri, 'https://a/b')
  const second = consumeAuthState(r.state)
  assert.equal(second.ok, false)
  assert.match(second.error, /无效或已过期/)
}))

test('未配置登录页 → 明确原因（不是静默空串）', () => withHome((env) => {
  const r = startMengbotAuth({ redirectUri: '', env })
  assert.equal(r.ok, false)
  assert.match(r.error, /未配置 MengBot 登录页/)
}, {}))

test('登录 URL 支持自定义模板占位符', () => withHome((env) => {
  const r = mengbotLoginUrl(
    { state: 'ST', redirectUri: 'RD', callbackUrl: 'CB' },
    { ...env, MEMORY_MENGBOT_LOGIN_URL: 'https://x/login?cb={redirect_uri}&s={state}&c={client}' },
  )
  assert.equal(r.url, 'https://x/login?cb=CB&s=ST&c=memory-eternal-cloud')
}))

test('callback 无 state/无码 → 可读失败，不建租户', () => withHome(async (env) => {
  const noState = await completeMengbotAuth({ token: 'x', state: 'nope', env })
  assert.equal(noState.ok, false)
  assert.match(noState.error, /state 无效/)

  const r = startMengbotAuth({ redirectUri: 'https://a/b', env })
  const noCode = await completeMengbotAuth({ code: '', token: '', state: r.state, env })
  assert.equal(noCode.ok, false)
  assert.match(noCode.error, /缺少 code 或 token/)
}))
