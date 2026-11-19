// 授权登录的安全/可用性守卫。
// 这些点都是实际踩过或审出来的，不是理论清单：
//   ① 回跳地址必须过白名单（两个分支都要），否则开放重定向会把令牌送去外部站点
//   ② MengBot 返回非 JSON 时要明确报「地址可能指错」，不能报「未返回用户标识」
//   ③ 发码接口必须限速，否则能被拿来做邮件轰炸 / 打坏发信信誉
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { safeRedirectTarget } from '../lib/cloud-server.js'

const env = { MEMORY_CLOUD_PUBLIC_URL: 'https://mem.example.com' }

test('回跳白名单：外部站点一律拒绝', () => {
  assert.equal(safeRedirectTarget('https://evil.example.net/x', env), '')
  assert.equal(safeRedirectTarget('javascript:alert(1)', env), '')
  assert.equal(safeRedirectTarget('//evil.example.net', env), '')
  assert.equal(safeRedirectTarget('', env), '')
})

test('回跳白名单：本站与 dsh-app 放行', () => {
  assert.equal(safeRedirectTarget('https://mem.example.com/done', env), 'https://mem.example.com/done')
  assert.equal(safeRedirectTarget('dsh-app://app', env), 'dsh-app://app')
})

test('回跳白名单：畸形输入不抛错，返回空串', () => {
  assert.equal(safeRedirectTarget('http://', env), '')
  assert.equal(safeRedirectTarget('a b c', env), '')
})