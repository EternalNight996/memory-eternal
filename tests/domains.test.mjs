// 域名基座：登录 / 支付 / 订阅 / 提示文案都从这一处派生。
// 备案域名 mengbot.com.cn 是默认首选，mengbot.vip 是当前迁移期的临时域。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_DOMAIN_BASE, DOMAIN_BASES, normalizeDomainBase, domainBaseFromUrl,
  hostFor, resolveDomainBase, resolveDomains,
} from '../lib/domains.js'

test('默认基座是备案域名', () => {
  assert.equal(DEFAULT_DOMAIN_BASE, 'mengbot.com.cn')
  assert.deepEqual(DOMAIN_BASES, ['mengbot.com.cn', 'mengbot.vip'])
})

test('从任意已知子域反推基座；自建域名不猜', () => {
  assert.equal(domainBaseFromUrl('https://mem.mengbot.vip'), 'mengbot.vip')
  assert.equal(domainBaseFromUrl('https://cloud.mengbot.com.cn'), 'mengbot.com.cn')
  assert.equal(domainBaseFromUrl('https://accounts.mengbot.vip/auth'), 'mengbot.vip')
  assert.equal(domainBaseFromUrl('https://memory.example.com'), '')
  assert.equal(domainBaseFromUrl(''), '')
})

test('基座归一：接受裸域 / 带协议 / 带子域，只认已知基座', () => {
  assert.equal(normalizeDomainBase('mengbot.vip'), 'mengbot.vip')
  assert.equal(normalizeDomainBase('https://mengbot.com.cn/'), 'mengbot.com.cn')
  assert.equal(normalizeDomainBase('mem.mengbot.vip'), 'mengbot.vip')
  assert.equal(normalizeDomainBase('evil.example.com'), '')
})

test('四个角色对称派生', () => {
  assert.equal(hostFor('mem', 'mengbot.vip'), 'mem.mengbot.vip')
  assert.equal(hostFor('pay', 'mengbot.vip'), 'pay.mengbot.vip')
  assert.equal(hostFor('accounts', 'mengbot.com.cn'), 'accounts.mengbot.com.cn')
  assert.equal(hostFor('cloud', 'mengbot.vip'), 'cloud.mengbot.vip')
})

test('切换基座：一处配置，登录与支付同时换', () => {
  const own = resolveDomains({ env: {} })
  assert.equal(own.base, 'mengbot.com.cn')
  assert.equal(own.memUrl, 'https://mem.mengbot.com.cn')
  assert.equal(own.payUrl, 'https://pay.mengbot.com.cn')

  const temp = resolveDomains({ env: { MEMORY_MENGBOT_DOMAIN: 'mengbot.vip' } })
  assert.equal(temp.base, 'mengbot.vip')
  assert.equal(temp.memUrl, 'https://mem.mengbot.vip')
  assert.equal(temp.payUrl, 'https://pay.mengbot.vip')
  assert.equal(temp.accountsUrl, 'https://accounts.mengbot.vip')
})

test('按当前云端连接反推（云端已连 vip 时，支付也必须是 vip）', () => {
  const d = resolveDomains({ env: {}, cloudUrl: 'https://mem.mengbot.vip' })
  assert.equal(d.base, 'mengbot.vip')
  assert.equal(d.payUrl, 'https://pay.mengbot.vip')
})

test('显式基座优先于连接地址（便于灰度/回切备案域）', () => {
  const d = resolveDomains({ env: { MEMORY_MENGBOT_DOMAIN: 'mengbot.com.cn' }, cloudUrl: 'https://mem.mengbot.vip' })
  assert.equal(d.base, 'mengbot.com.cn')
  assert.equal(d.payUrl, 'https://pay.mengbot.com.cn')
})
