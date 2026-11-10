// #59 回归：蒸馏因 AUTH / 401 失败时，健康提示必须告诉用户「怎么办」
// （更新 provider Key / 换蒸馏模型 / 关闭蒸馏只存原文卡），而不是只报「蒸馏失败」。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { humanizeDistillFailure, isAuthFailure } = await import('../index.js')

test('#59 AUTH 失败 → 提示包含换 Key / 换模型 / 关闭蒸馏的路径', () => {
  const f = { provider: 'deepseek-official', code: 'AUTH', message: 'Authentication Fails, Your api key: ****a4ae is invalid' }
  assert.equal(isAuthFailure(f), true)
  const msg = humanizeDistillFailure(f)
  assert.match(msg, /deepseek-official/, '应带上出问题的 provider，便于定位')
  assert.match(msg, /API Key/i, '应提示更新 Key')
  assert.match(msg, /蒸馏知识卡/, '应提示可以关闭蒸馏')
  assert.match(msg, /原文卡/, '应说明关掉蒸馏后内容仍会以原文卡保存')
})

test('#59 401 / 403 也按鉴权失败处理', () => {
  assert.equal(isAuthFailure({ code: '401', message: 'Unauthorized' }), true)
  assert.equal(isAuthFailure({ code: 'HTTP_403', message: 'forbidden' }), true)
  assert.equal(isAuthFailure({ code: 'AUTH_FAILED', message: '' }), true)
})

test('#59 非凭证失败不误报凭证建议', () => {
  const f = { provider: 'x', code: 'MAX_TOKENS', message: '输出撞上限' }
  assert.equal(isAuthFailure(f), false)
  assert.doesNotMatch(humanizeDistillFailure(f), /API Key/)
})
