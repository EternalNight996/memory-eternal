// 账号层单元守卫（不需要 PG）：口令哈希、邮箱归一、密码策略。
// 这些是「错一次就泄漏」的地方，必须有回归。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashPassword, verifyPassword, passwordProblem, normalizeEmail, isEmail } from '../lib/accounts.js'

test('scrypt 往返：正确口令通过，错误口令不通过', () => {
  const h = hashPassword('correct horse battery staple')
  assert.match(h, /^scrypt\$16384\$8\$1\$/)
  assert.equal(verifyPassword('correct horse battery staple', h), true)
  assert.equal(verifyPassword('wrong', h), false)
})

test('同一口令两次哈希不同（加盐）', () => {
  const a = hashPassword('same-password-123')
  const b = hashPassword('same-password-123')
  assert.notEqual(a, b)
  assert.equal(verifyPassword('same-password-123', a), true)
  assert.equal(verifyPassword('same-password-123', b), true)
})

test('畸形哈希不抛错，返回 false', () => {
  for (const bad of ['', 'x', 'md5$1$2$3$4$5', 'scrypt$notanumber$8$1$aaa$bbb']) {
    assert.equal(verifyPassword('x', bad), false)
  }
})

test('密码策略：至少 8 位', () => {
  assert.match(passwordProblem('1234567'), /8 位/)
  assert.equal(passwordProblem('12345678'), '')
})

test('邮箱归一与校验', () => {
  assert.equal(normalizeEmail('  A@B.CoM '), 'a@b.com')
  assert.equal(isEmail('a@b.com'), true)
  assert.equal(isEmail('a@b'), false)
  assert.equal(isEmail(''), false)
})