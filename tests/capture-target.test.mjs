// 是否写本地 / 写云端的判定（2026-11-17 现场回归）
//
// 现场：用户已在面板切「本地模式」，但 Node 侧的 cloud-conn 记录没落盘，插件仍按云端写；
// 云端是本机反代 + 自签 CA，Node fetch 直接 SELF_SIGNED_CERT_IN_CHAIN →
// 每回合一条「写卡失败：未知原因」。这条测试锁死「conn=local 就必须写本地」，
// 避免判定逻辑再被改回去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveCaptureTarget, cloudReady } from '../lib/capture-target.js'

const cfg = { cloudWriteMode: 'cloud' }

test('conn=local：无论 cloudWriteMode 是什么都写本地', () => {
  assert.equal(resolveCaptureTarget({ conn: { mode: 'local', url: 'https://x', token: 't' }, cfg }), 'local')
  assert.equal(resolveCaptureTarget({ conn: { mode: 'local', url: '', token: '' }, cfg: { cloudWriteMode: 'both' } }), 'local')
})

test('conn=cloud 但缺令牌 / 地址非法 / active=false：写本地', () => {
  assert.equal(resolveCaptureTarget({ conn: { mode: 'cloud', active: true, url: 'https://x', token: '' }, cfg }), 'local')
  assert.equal(resolveCaptureTarget({ conn: { mode: 'cloud', active: true, url: 'not-a-url', token: 't' }, cfg }), 'local')
  assert.equal(resolveCaptureTarget({ conn: { mode: 'cloud', active: false, url: 'https://x', token: 't' }, cfg }), 'local')
  assert.equal(cloudReady({ mode: 'cloud', active: true, url: 'https://x', token: 't' }), true)
})

test('conn 完整且是 cloud 模式：默认只写云端；both 才写本地', () => {
  const conn = { mode: 'cloud', active: true, url: 'https://x', token: 't' }
  assert.equal(resolveCaptureTarget({ conn, cfg }), 'cloud')
  assert.equal(resolveCaptureTarget({ conn, cfg: { cloudWriteMode: 'both' } }), 'local')
  assert.equal(resolveCaptureTarget({ conn, cfg: { cloudWriteMode: 'CLOUD' } }), 'cloud')
})
