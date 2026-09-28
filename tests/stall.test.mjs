// issue #3-2 / dm#4 回归：停滞探测必须「不该报的不报、真故障要报」。
// 旧判据用累积计数差额 + claimIdleMs，两个方向都错：空闲就误报、真停摆却漏报。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateStall } from '../lib/stall.js'

const NOW = 1_700_000_000_000
const min = (n) => n * 60 * 1000

test('用户离开 20 分钟（窗口外有历史轮次）→ 不报', () => {
  const r = evaluateStall({ claimedAt: [NOW - min(120), NOW - min(90), NOW - min(60)], stoppedAt: [NOW - min(119)], now: NOW })
  assert.equal(r.started, 0)
  assert.equal(r.alert, false, '窗口内没有轮次开始，不该报')
})

test('正常收尾后离开 20 分钟 → 不报', () => {
  const r = evaluateStall({ claimedAt: [NOW - min(30), NOW - min(25)], stoppedAt: [NOW - min(24), NOW - min(23)], now: NOW })
  assert.equal(r.alert, false)
})

test('长任务跑了 20 分钟（窗口内只有 1 个轮次开始）→ 不报', () => {
  const r = evaluateStall({ claimedAt: [NOW - min(19)], stoppedAt: [], now: NOW })
  assert.equal(r.started, 1)
  assert.equal(r.alert, false, '未达 minStarted，长任务不该被误判')
})

test('真故障：窗口内持续开始、零收尾 → 必须报', () => {
  const r = evaluateStall({ claimedAt: [NOW - min(18), NOW - min(12), NOW - min(6), NOW - min(1)], stoppedAt: [], now: NOW })
  assert.equal(r.started, 4)
  assert.equal(r.alert, true, '持续开始却从不收尾，正是真停摆的特征')
})

test('有开始也有收尾 → 不报（哪怕历史上丢过收尾事件）', () => {
  const r = evaluateStall({ claimedAt: [NOW - min(10), NOW - min(9), NOW - min(8), NOW - min(7)], stoppedAt: [NOW - min(6)], now: NOW })
  assert.equal(r.started, 4)
  assert.equal(r.stopped, 1)
  assert.equal(r.alert, false)
})

test('窗口可配：更短的窗口只看最近 5 分钟', () => {
  const claimedAt = [NOW - min(4), NOW - min(3), NOW - min(2)]
  assert.equal(evaluateStall({ claimedAt, stoppedAt: [], now: NOW, windowMs: min(5) }).alert, true)
  assert.equal(evaluateStall({ claimedAt, stoppedAt: [], now: NOW, windowMs: min(1) }).alert, false)
})
