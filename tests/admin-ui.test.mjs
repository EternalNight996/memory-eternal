// 管理端/用户端会话守卫：两套登录必须物理隔离。
// 真实约束：管理端只认管理令牌派生的 HMAC 会话；用户密钥（me_…）永远进不来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { issueSession, verifySession, loginPage, adminPage, shell } from '../lib/cloud-admin-ui.js'
import { userLoginPage } from '../lib/cloud-user-login.js'

const SECRET = 'admin-token-for-test-0123456789abcdef'

test('会话签发/校验往返', () => {
  const c = issueSession(SECRET)
  assert.equal(verifySession(SECRET, c).ok, true)
})

test('换密钥后旧会话失效（管理令牌轮换 = 强制下线）', () => {
  const c = issueSession(SECRET)
  assert.equal(verifySession('another-token-0123456789abcdefghij', c).ok, false)
})

test('篡改签名被拒', () => {
  const c = issueSession(SECRET)
  const bad = c.slice(0, -1) + (c.slice(-1) === 'a' ? 'b' : 'a')
  assert.equal(verifySession(SECRET, bad).ok, false)
})

test('空/畸形 cookie 被拒', () => {
  assert.equal(verifySession(SECRET, '').ok, false)
  assert.equal(verifySession(SECRET, 'garbage').ok, false)
})

test('登录页与管理端页面各自渲染，且互相指引', () => {
  const login = loginPage({})
  assert.match(login, /管理端登录/)
  assert.match(login, /api\/login/)
  const admin = adminPage({ version: '1.0.0', keys: [], tenants: [] })
  assert.match(admin, /记忆云管理端/)
  assert.match(admin, /签发访问密钥/)
  const user = userLoginPage({})
  assert.match(user, /用户登录/)
  assert.match(user, /MengBot/)
  assert.match(user, /api\/admin/)
})

test('用户登录页不含管理令牌输入（权限串味的直接证据）', () => {
  const user = userLoginPage({})
  assert.doesNotMatch(user, /MEMORY_CLOUD_ADMIN_TOKEN/)
  assert.doesNotMatch(user, /管理令牌/)
})

test('shell 转义：标题注入不会破坏结构', () => {
  const h = shell('<script>x</script>', 'body')
  assert.match(h, /<title><script>x<\/script><\/title>/)
})