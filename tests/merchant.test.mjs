// 商户接入（lib/merchant.js）。
//
// 与「客户端订阅」是两条独立的路：
//   客户端订阅 = 个人订阅 personal/pro/max，凭据 me_ / mb_
//   商户接入   = 商户自有云端实例接入托管，凭据 mch_ / msk_
//
// 守住七件事：
//   ① 商户密钥只存 hash，台账里没有明文
//   ② 域名归一化（https://x.com/y → x.com）且全局唯一
//   ③ 同一注册人名下不可重名，不同注册人可以同名
//   ④ 校验：正确通过 / 错误拒绝 / 不存在拒绝
//   ⑤ 轮换后旧密钥**立即失效**
//   ⑥ 吊销后彻底不可用，也不再出现在列表里
//   ⑦ 只能操作自己名下的商户（越权测试在前一个文件里走 API）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  registerMerchant, listMerchantsByOwner, getMerchant, verifyMerchant,
  rotateMerchantSecret, revokeMerchant, applyMerchantEntitlement, merchantStorePath,
} from '../lib/merchant.js'

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mch-'))
  return { home, env: { ...process.env, DSH_HOME: home } }
}
const cleanup = (home) => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ } }

test('注册：返回 secret，但台账里没有明文', () => {
  const { home, env } = setup()
  const r = registerMerchant({ name: 'Acme 科技', domain: 'https://memory.acme.com/x', owner: 'boss@acme.com', env })
  assert.equal(r.ok, true)
  assert.match(r.merchant.id, /^mch_/)
  assert.match(r.secret, /^msk_/)
  assert.equal(r.merchant.domain, 'memory.acme.com', '域名要归一化')
  assert.equal(r.merchant.status, 'pending')
  const raw = fs.readFileSync(merchantStorePath(env), 'utf8')
  assert.equal(raw.includes(r.secret), false, '台账里不能有明文商户密钥')
  assert.ok(raw.includes('secretHash'), '应存 secretHash')
  cleanup(home)
})

test('重名与重复域名', () => {
  const { home, env } = setup()
  registerMerchant({ name: 'Acme', domain: 'a.com', owner: 'boss@acme.com', env })
  assert.match(registerMerchant({ name: 'Acme', owner: 'boss@acme.com', env }).error, /同名/)
  assert.match(registerMerchant({ name: 'Other', domain: 'a.com', owner: 'x@y.com', env }).error, /已被其他商户接入/)
  // 不同注册人同名可以（公司重名很常见）
  assert.equal(registerMerchant({ name: 'Acme', owner: 'other@x.com', env }).ok, true)
  cleanup(home)
})

test('校验：正确 / 错误 / 不存在', () => {
  const { home, env } = setup()
  const r = registerMerchant({ name: 'M', owner: 'o@x.com', env })
  assert.equal(verifyMerchant(r.merchant.id, r.secret, env).ok, true)
  assert.match(verifyMerchant(r.merchant.id, 'msk_wrong', env).error, /密钥无效/)
  assert.match(verifyMerchant('mch_nope', r.secret, env).error, /不存在/)
  assert.match(verifyMerchant('', '', env).error, /缺少/)
  cleanup(home)
})

test('**轮换后旧密钥立即失效**（商户密钥会嵌进对方服务端，泄漏要能立刻作废）', () => {
  const { home, env } = setup()
  const r = registerMerchant({ name: 'M', owner: 'o@x.com', env })
  const rot = rotateMerchantSecret(r.merchant.id, env)
  assert.equal(rot.ok, true)
  assert.notEqual(rot.secret, r.secret)
  assert.equal(verifyMerchant(r.merchant.id, rot.secret, env).ok, true, '新密钥可用')
  assert.equal(verifyMerchant(r.merchant.id, r.secret, env).ok, false, '旧密钥必须立刻失效')
  cleanup(home)
})

test('吊销后不可用且不在列表里', () => {
  const { home, env } = setup()
  const r = registerMerchant({ name: 'M', owner: 'o@x.com', env })
  assert.equal(revokeMerchant(r.merchant.id, env).ok, true)
  assert.match(verifyMerchant(r.merchant.id, r.secret, env).error, /吊销/)
  assert.equal(listMerchantsByOwner('o@x.com', env).length, 0)
  cleanup(home)
})

test('按 owner 隔离：别人看不到我的商户', () => {
  const { home, env } = setup()
  registerMerchant({ name: 'A', owner: 'a@x.com', env })
  registerMerchant({ name: 'B', owner: 'b@x.com', env })
  assert.equal(listMerchantsByOwner('a@x.com', env).length, 1)
  assert.equal(listMerchantsByOwner('b@x.com', env).length, 1)
  assert.equal(listMerchantsByOwner('c@x.com', env).length, 0)
  cleanup(home)
})

test('权益 webhook 能把 pending 转 active 并写入套餐', () => {
  const { home, env } = setup()
  const r = registerMerchant({ name: 'M', owner: 'o@x.com', env })
  assert.equal(r.merchant.status, 'pending')
  const up = applyMerchantEntitlement(r.merchant.id, { plan: 'merchant-pro', status: 'active' }, env)
  assert.equal(up.ok, true)
  assert.equal(up.merchant.plan, 'merchant-pro')
  assert.equal(up.merchant.status, 'active')
  assert.equal(getMerchant(r.merchant.id, env).status, 'active')
  cleanup(home)
})

test('缺参数要明确报错，不能注册出无名商户', () => {
  const { home, env } = setup()
  assert.match(registerMerchant({ name: '', owner: 'o@x.com', env }).error, /缺少商户名称/)
  assert.match(registerMerchant({ name: 'M', owner: '', env }).error, /必须先登录/)
  cleanup(home)
})
