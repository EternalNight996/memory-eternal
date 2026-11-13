// 定时自动体检（lib/auto-junk.js）。
//
// 红线：**自动流程只归档，绝不删除**。归档可逆（一键全部恢复），删除不可逆
// （回收站 30 天后清空）。自动跑的东西不该拥有不可逆的权力。
//
// 守八件事：
//   ① 默认关闭（enabled=false 时调度器不跑）
//   ② 只碰 neverRecalled / stale，duplicate / tooShort / quarantineStale 一律不动
//   ③ 有召回记录的老卡不是僵尸（recall_count > 0）
//   ④ 默认 dryRun（不传 dryRun:false 不改数据）
//   ⑤ maxPerRun 上限生效（第一次开启时不会一口气归档几千张）
//   ⑥ 每次真跑写状态文件（上次时间 + 报告）
//   ⑦ 调度判断四态：disabled / never-ran / not-due / due
//   ⑧ 配置非法值回落默认，不会把上限算成 NaN 或 0
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runAutoJunk, autoConfigFrom, autoJunkDue, readAutoState, tickAutoJunk, AUTO_ARCHIVE_REASONS, AUTO_DEFAULTS } from '../lib/auto-junk.js'
import { getDb, closeDb } from '../lib/db.js'
import { contentHash } from '../lib/card-hash.js'
import { scanJunk } from '../lib/junk.js'

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'me-auto-'))
}

function cleanup(root) {
  try { closeDb(root) } catch { /* 忽略 */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

/** 造卡（直接插库，绕开审核闸门，专注测自动归档规则） */
function seed(root, rows) {
  const db = getDb(root)
  const ins = db.prepare(`
    INSERT INTO cards (id, path, kind, title, tags, body, summary, status, source, created_at, updated_at, content_hash, recall_count)
    VALUES (?, ?, 'knowledge', ?, '[]', ?, '', 'approved', '', ?, ?, ?, ?)
  `)
  rows.forEach((r, i) => ins.run(i + 1, r.path, r.title, r.body, r.created || '2026-01-01 00:00:00', r.updated || r.created || '2026-01-01 00:00:00', contentHash(r.title, r.body), r.recall || 0))
  return db
}

const OLD = '2026-01-01 00:00:00' // 远超 90 天

test('只允许自动归档 neverRecalled / stale 两类', () => {
  assert.deepEqual(AUTO_ARCHIVE_REASONS, ['neverRecalled', 'stale'])
  assert.ok(!AUTO_ARCHIVE_REASONS.includes('duplicate'), '重复卡不该被自动归档（该人工决定）')
  assert.ok(!AUTO_ARCHIVE_REASONS.includes('tooShort'), '过短卡不该自动处理')
})

test('默认配置：关闭 + 24 小时 + 单次 200 张', () => {
  assert.equal(AUTO_DEFAULTS.enabled, false, '必须默认关闭')
  const cfg = autoConfigFrom({})
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.intervalHours, 24)
  assert.equal(cfg.maxPerRun, 200)
})

test('配置解析：非法值回落，上限受钳制', () => {
  const bad = autoConfigFrom({ junkAutoEnabled: true, junkAutoIntervalHours: 'abc', junkAutoMaxPerRun: -5, junkAutoNeverRecalledDays: null })
  assert.equal(bad.intervalHours, AUTO_DEFAULTS.intervalHours)
  assert.equal(bad.maxPerRun, AUTO_DEFAULTS.maxPerRun)
  assert.equal(bad.neverRecalledDays, AUTO_DEFAULTS.neverRecalledDays)
  const huge = autoConfigFrom({ junkAutoMaxPerRun: 999999 })
  assert.equal(huge.maxPerRun, 2000, '上限应钳到 2000')
})

test('dryRun 默认：不传就什么都不改', async () => {
  const root = tmpVault()
  seed(root, [{ path: 'z.md', title: '僵尸', body: '一张很老且从未被召回过的卡，内容长度足够用于测试。', created: OLD, recall: 0 }])
  const r = await runAutoJunk(root, { enabled: true, neverRecalledDays: 90, staleDays: 3650 })
  assert.equal(r.dryRun, true, '默认必须是预演')
  assert.equal(r.archived, 0)
  assert.ok(r.candidates >= 1)
  assert.equal(getDb(root).prepare('SELECT COUNT(*) n FROM quarantine').get().n, 0, '预演不该动数据')
  cleanup(root)
})

test('真跑：只归档僵尸，不碰有召回的卡与过短卡', async () => {
  const root = tmpVault()
  seed(root, [
    { path: 'z1.md', title: '僵尸1', body: '第一张很老且从未被召回过的卡，内容长度足够用于测试。', created: OLD, recall: 0 },
    { path: 'z2.md', title: '僵尸2', body: '第二张很老且从未被召回过的卡，内容长度足够用于测试。', created: OLD, recall: 0 },
    { path: 'used.md', title: '常用老卡', body: '这张老卡被召回很多次，不应该被自动归档，内容长度足够。', created: OLD, recall: 30 },
    { path: 'short.md', title: '碎片', body: '短', created: OLD, recall: 0 },
  ])
  const r = await runAutoJunk(root, { enabled: true, neverRecalledDays: 90, staleDays: 3650, dryRun: false })
  assert.equal(r.archived, 2, '应归档 2 张僵尸，实际 ' + r.archived)
  assert.deepEqual(r.paths.sort(), ['z1.md', 'z2.md'])
  const db = getDb(root)
  const arch = db.prepare("SELECT path FROM quarantine WHERE status = 'archived'").all().map((x) => x.path).sort()
  assert.deepEqual(arch, ['z1.md', 'z2.md'])
  assert.ok(!arch.includes('used.md'), '有召回记录的老卡不是僵尸')
  assert.ok(!arch.includes('short.md'), '过短卡不在自动归档范围内')
  cleanup(root)
})

test('maxPerRun 上限生效（第一次开启不会一口气归档几千张）', async () => {
  const root = tmpVault()
  const rows = []
  for (let i = 0; i < 12; i++) {
    rows.push({ path: `m${i}.md`, title: `僵尸${i}`, body: `第 ${i} 张很老的卡，从未被召回，内容长度足够用于测试批量上限。`, created: OLD, recall: 0 })
  }
  seed(root, rows)
  const r = await runAutoJunk(root, { enabled: true, neverRecalledDays: 90, staleDays: 3650, maxPerRun: 5, dryRun: false })
  assert.equal(r.archived, 5, '单次应只归档 5 张')
  assert.ok(r.candidates >= 12, '候选数应报全量')
  cleanup(root)
})

test('真跑会写状态文件（上次时间 + 报告）', async () => {
  const root = tmpVault()
  seed(root, [{ path: 's.md', title: '僵尸', body: '一张很老且从未被召回过的卡，内容长度足够用于测试。', created: OLD, recall: 0 }])
  await runAutoJunk(root, { enabled: true, neverRecalledDays: 90, staleDays: 3650, dryRun: false })
  const st = readAutoState(root)
  assert.ok(st.lastRunAt > 0, '要记录上次运行时间')
  assert.ok(st.lastReport && st.lastReport.archived >= 1, '要记录报告')
  cleanup(root)
})

test('调度四态：disabled / never-ran / not-due / due', async () => {
  const root = tmpVault()
  // 未启用
  assert.equal(autoJunkDue(root, autoConfigFrom({})).reason, 'disabled')
  // 启用但没跑过
  const on = autoConfigFrom({ junkAutoEnabled: true, junkAutoIntervalHours: 24 })
  assert.equal(autoJunkDue(root, on).reason, 'never-ran')
  // 刚跑完 → not-due
  await runAutoJunk(root, { enabled: true, already: true, dryRun: false })
  assert.equal(autoJunkDue(root, on).reason, 'not-due')
  // 12 小时后 → 还没到
  const t12 = Date.now() + 12 * 3600000
  assert.equal(autoJunkDue(root, on, t12).reason, 'not-due')
  // 25 小时后 → due
  const t25 = Date.now() + 25 * 3600000
  assert.equal(autoJunkDue(root, on, t25).reason, 'due')
  cleanup(root)
})

test('tickAutoJunk：关闭时直接跳过，不产生任何动作', async () => {
  const root = tmpVault()
  seed(root, [{ path: 't.md', title: '僵尸', body: '一张很老且从未被召回过的卡，内容长度足够用于测试。', created: OLD, recall: 0 }])
  const r = await tickAutoJunk(root, { junkAutoEnabled: false })
  assert.equal(r.ran, false)
  assert.equal(r.reason, 'disabled')
  assert.equal(getDb(root).prepare('SELECT COUNT(*) n FROM quarantine').get().n, 0)
  // 开启后应真的跑
  const r2 = await tickAutoJunk(root, { junkAutoEnabled: true, junkAutoNeverRecalledDays: 90 })
  assert.equal(r2.ran, true, '开启后应跑一次')
  assert.ok(r2.result.archived >= 1)
  cleanup(root)
})

test('归档后 neverRecalled 归零（自动体检的效果可验证）', async () => {
  const root = tmpVault()
  seed(root, [{ path: 'q.md', title: '僵尸', body: '一张很老且从未被召回过的卡，内容长度足够用于测试。', created: OLD, recall: 0 }])
  assert.ok(scanJunk(root, { neverRecalledDays: 90, staleDays: 3650 }).summary.neverRecalled >= 1)
  await runAutoJunk(root, { enabled: true, neverRecalledDays: 90, staleDays: 3650, dryRun: false })
  assert.equal(scanJunk(root, { neverRecalledDays: 90, staleDays: 3650 }).summary.neverRecalled, 0, '归档后不该再算出僵尸')
  cleanup(root)
})
