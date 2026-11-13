// 备份时间窗：**默认每天 03:00–03:59 之间备一次**
// 守三件事：
//   ① 窗口内、距上次满间隔 → 备；
//   ② 窗口外即使已过间隔也不备（白天不跟用户抢磁盘）；
//   ③ 从没备份过的新装用户要能在任意时刻补第一份（catchup），不能等到明天凌晨。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backupDue, nextBackupAt } from '../index.js'

const at = (h, m = 0, d = 13) => new Date(2026, 10, d, h, m, 0, 0).getTime()
const DAY = 86400000

test('窗口内（03:30）且昨天已备 → due（每天一次，不等满 24h）', () => {
  const r = backupDue({ backupEnabled: true, backupIntervalHours: 24 }, at(3, 30), at(10, 57, 12))
  assert.equal(r.due, true, '昨天 10:57 备过，今天 03:30 也该备一份（只隔 16h 不跳过这一天）')
  assert.equal(r.reason, 'due')
  assert.equal(r.windowStart, 3)
  assert.equal(r.inWindow, true)
})

test('窗口内但今天已经备过 → already-today（当天不重复）', () => {
  const r = backupDue({ backupEnabled: true }, at(3, 30), at(1, 0))
  assert.equal(r.due, false)
  assert.equal(r.reason, 'already-today')
})

test('窗口外（15:00 / 04:30）即使过了间隔也不备', () => {
  for (const h of [15, 4]) {
    const r = backupDue({ backupEnabled: true }, at(h, 0), at(3, 10) - DAY)
    assert.equal(r.due, false, `${h} 点不应该备`)
    assert.equal(r.reason, 'outside-window')
    assert.equal(r.inWindow, false)
  }
})

test('从未备份：任意时刻都补一次（窗口外走 catchup）', () => {
  const outside = backupDue({ backupEnabled: true }, at(15, 0), 0)
  assert.equal(outside.due, true)
  assert.equal(outside.reason, 'never-backed-up-catchup')
  const inside = backupDue({ backupEnabled: true }, at(3, 10), 0)
  assert.equal(inside.reason, 'never-backed-up')
})

test('关闭自动备份 → 任何时刻都不动', () => {
  const r = backupDue({ backupEnabled: false }, at(3, 30), at(3, 10) - DAY)
  assert.equal(r.due, false)
  assert.equal(r.reason, 'disabled')
})

test('窗口小时数可配（backupWindowStart）', () => {
  const r = backupDue({ backupEnabled: true, backupWindowStart: 5 }, at(5, 20), at(5, 10) - DAY)
  assert.equal(r.due, true)
  assert.equal(r.windowStart, 5)
  const wrong = backupDue({ backupEnabled: true, backupWindowStart: 5 }, at(3, 20), at(3, 10) - DAY)
  assert.equal(wrong.due, false)
  assert.equal(wrong.reason, 'outside-window')
})

test('间隔大于 24h（如 72h）仍然只在窗口内动手', () => {
  const cfg = { backupEnabled: true, backupIntervalHours: 72 }
  // 距上次 48h（>24 但 <72）：不该备
  assert.equal(backupDue(cfg, at(3, 30), at(3, 10) - 2 * DAY).due, false)
  // 距上次 96h（>72）：窗口内才备
  assert.equal(backupDue(cfg, at(3, 30), at(3, 10) - 4 * DAY).due, true)
  assert.equal(backupDue(cfg, at(15, 0), at(3, 10) - 4 * DAY).reason, 'outside-window')
})

test('nextBackupAt 落在窗口里（不是「上次 + 24h」这种白天时刻）', () => {
  const now = at(15, 20)
  // 今天已备过 → 明天 03:00
  assert.equal(nextBackupAt({ lastAt: at(3, 30) }, now), at(3, 0, 14))
  // 昨天备过、今天窗口已过 → 明天 03:00
  assert.equal(nextBackupAt({ lastAt: at(10, 57, 12) }, now), at(3, 0, 14))
  // 从未备份、今天还没到窗口 → 今天 03:00（这里 now 是 15:20，已过 → 明天）
  assert.equal(nextBackupAt({ lastAt: 0 }, now), at(3, 0, 14))
  // 窗口可配
  assert.equal(nextBackupAt({ lastAt: at(3, 30), windowStart: 5 }, now), at(5, 0, 14))
  const n = new Date(nextBackupAt({ lastAt: at(3, 30) }, now))
  assert.equal(n.getHours(), 3, '下次备份必须落在窗口小时上')
  assert.equal(n.getMinutes(), 0)
})
