// 支付域推导：升级/续费链接必须跟随**当前云端实例**的域名，
// 否则用户切到自建或另一个官方实例后，会被带去别的商户的订阅页。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { payBaseFromCloudUrl, resolvePayBase, DEFAULT_PAY_BASE } from '../lib/billing.js'

test('官方实例：mem/cloud 子域推导出同后缀的 pay 域', () => {
  assert.equal(payBaseFromCloudUrl('https://mem.mengbot.com.cn'), 'https://pay.mengbot.com.cn')
  assert.equal(payBaseFromCloudUrl('https://cloud.mengbot.com.cn'), 'https://pay.mengbot.com.cn')
  assert.equal(payBaseFromCloudUrl('https://mem.mengbot.vip'), 'https://pay.mengbot.vip')
  assert.equal(payBaseFromCloudUrl('http://mem.mengbot.vip:7999'), 'https://pay.mengbot.vip')
})

test('已经是 pay 域：原样返回（不叠一层 pay.pay）', () => {
  assert.equal(payBaseFromCloudUrl('https://pay.mengbot.com.cn'), 'https://pay.mengbot.com.cn')
})

test('自建域名不猜（猜错比不猜更糟）', () => {
  assert.equal(payBaseFromCloudUrl('https://memory.example.com'), '')
  assert.equal(payBaseFromCloudUrl('https://192.168.1.10:7999'), '')
  assert.equal(payBaseFromCloudUrl('not-a-url'), '')
  assert.equal(payBaseFromCloudUrl(''), '')
})

test('resolvePayBase 优先级：显式配置 > 按实例推导 > 官方默认', () => {
  assert.equal(resolvePayBase({ env: { MEMORY_MENGBOT_PAY_BASE: 'https://pay.internal.example/' }, cloudUrl: 'https://mem.mengbot.vip' }), 'https://pay.internal.example')
  assert.equal(resolvePayBase({ env: {}, cloudUrl: 'https://mem.mengbot.vip' }), 'https://pay.mengbot.vip')
  assert.equal(resolvePayBase({ env: {}, cloudUrl: 'https://memory.example.com' }), DEFAULT_PAY_BASE)
  assert.equal(DEFAULT_PAY_BASE, 'https://pay.mengbot.com.cn')   // 备案域是默认首选
  assert.equal(resolvePayBase({ env: {}, cloudUrl: '' }), DEFAULT_PAY_BASE)
})

test('推导结果不带尾斜杠（拼 /subscribe 不能出现双斜杠）', () => {
  for (const u of ['https://mem.mengbot.com.cn/', 'https://mem.mengbot.vip/']) {
    const base = resolvePayBase({ env: {}, cloudUrl: u })
    assert.ok(!base.endsWith('/'), base)
    assert.equal(base + '/subscribe?sku=sub-pro', base + '/subscribe?sku=sub-pro')
    assert.ok(!(base + '/subscribe').includes('//subscribe'), base)
  }
})
