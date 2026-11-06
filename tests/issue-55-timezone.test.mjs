// issue #55：同一张卡在记忆库显示 22:49、在待审页显示 14:49 —— 待审页把 UTC 墙钟
// 当本地时间显示了（相差一个时区）。回归守卫：
//   ① 纯函数在固定时区下必须把 UTC ISO 转成本地时间；
//   ② 跨零点的 UTC 日期必须落到**本地**日历日（日期筛选不能错一天）；
//   ③ 待审页源码不许再对 created 直接 slice（根因），日期筛选必须走本地日历日。

// 固定成现场时区复现问题（Node 支持运行时改 TZ；显式写死避免 CI 本机时区不同导致误判）。
process.env.TZ = 'Asia/Shanghai'

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')

test('#55 待审时间按本地时区渲染（现场：UTC 14:49 → 东八区 22:49）', async () => {
  const { localDateTime, localClock, localDateKey } = await import('../src/client/datetime.js')
  assert.equal(localDateTime('2026-11-01T14:49:00.000Z'), '2026-11-01 22:49', '同一时刻待审页要和记忆库显示一致')
  assert.equal(localClock('2026-11-01T14:49:00.000Z'), '22:49')
  assert.equal(localDateKey('2026-11-01T14:49:00.000Z'), '2026-11-01')
})

test('#55 跨零点：UTC 的「昨天」要按本地日历日落到今天（日期筛选不错一天）', async () => {
  const { localDateKey, localDateTime } = await import('../src/client/datetime.js')
  // 2026-10-31T17:30Z = 东八区 2026-11-01 01:30
  assert.equal(localDateTime('2026-10-31T17:30:00.000Z'), '2026-11-01 01:30')
  assert.equal(localDateKey('2026-10-31T17:30:00.000Z'), '2026-11-01', '筛「11-01」必须能筛到这张卡')
})

test('#55 纯日期不做时区换算（否则纯日期也会被当成 UTC 零点偏一天）', async () => {
  const { localDateKey, localDateTime } = await import('../src/client/datetime.js')
  assert.equal(localDateKey('2026-11-01'), '2026-11-01')
  assert.equal(localDateTime('2026-11-01'), '2026-11-01 00:00')
  assert.equal(localDateKey(''), '')
  assert.equal(localDateTime('not-a-date'), '')
  assert.equal(localDateKey(null), '')
})

test('#55 待审页源码守卫：不再 slice UTC 字符串，日期筛选走本地日历日', () => {
  const client = read('src/client/index.tsx')
  assert.match(client, /import \{ localDateKey, localDateTime, localClock, toLocalDate \} from '\.\/datetime\.js'/, '要走统一的本地时间模块')
  assert.doesNotMatch(client, /c\.created\s*\?\s*c\.created\.slice\(0, ?16\)/, '待审队列不许再直接截断 UTC ISO')
  assert.doesNotMatch(client, /previewCard\.created\.slice\(0, ?16\)/, '判词栏不许再直接截断 UTC ISO')
  assert.doesNotMatch(client, /\(c\.created \|\| ''\)\.slice\(0, ?10\)/, '日期筛选不许再拿 UTC 日期比本地日期')
  assert.match(client, /localDateTime\(c\.created\)/, '待审队列用本地时间')
  assert.match(client, /localDateTime\(previewCard\.created\)/, '判词栏用本地时间')
  assert.match(client, /localDateKey\(c\.created\)/, '日期筛选用本地日历日')
  assert.doesNotMatch(client, /\(c\.deletedAt \|\| ''\)\.slice\(0, ?10\)/, '回收中心删除日期不许再截断 UTC')
  // issue #57：回收中心同时收「已驳回」，驳回卡没有 deletedAt，日期回落到 updated。
  // 守的是「必须走 localDateKey（本地日历日）」，不是某一种字面写法。
  assert.match(client, /localDateKey\(c\.deletedAt\s*(\|\|\s*c\.updated)?\)/, '回收中心日期走本地日历日（驳回卡回落 updated）')
})
