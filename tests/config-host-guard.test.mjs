// DSH 宿主 HTTP 门禁（403 "Browser access is disabled"）的分类与降级：
// 它不是令牌问题，也不是「保存失败」——文件监听通道仍可用，应判 queued 而非 failed。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isHostGuardError, describeApplyFailure, triggerHostDrain } from '../lib/config-sync.js'

test('Browser access is disabled 归类为宿主门禁（不是令牌不匹配）', () => {
  assert.equal(isHostGuardError('Browser access is disabled'), true)
  assert.equal(isHostGuardError('HTTP 403 Browser access is disabled'), true)
  const d = describeApplyFailure('Browser access is disabled')
  assert.equal(d.kind, 'host-guard')
  assert.match(d.hint, /宿主|DSH/)
})

test('triggerHostDrain：403 原样带出状态与原因', async () => {
  const r = await triggerHostDrain({
    port: 12345,
    token: 'x',
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ ok: false, error: 'Browser access is disabled' }),
    }),
  })
  assert.equal(r.ok, false)
  assert.equal(r.status, 403)
  assert.match(String(r.error), /Browser access is disabled/)
})

test('源码守卫：配置保存把宿主门禁当 queued 处理，而不是 failed', () => {
  const src = fs.readFileSync(new URL('../lib/api.js', import.meta.url), 'utf8')
  assert.match(src, /hostGuardBlocked/, '要有门禁标记')
  assert.match(src, /browser access is disabled/i, '要识别 Browser access is disabled')
  assert.match(src, /outcome = \(tokenMismatch \|\| hostGuardBlocked\) \? 'queued' : 'failed'/, '403 应排队而不是失败')
})
