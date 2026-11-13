// 备份侧的红线：**备份自己必须是校验过的**，且不能因为重复触发把保留窗口挤没。
// 这里守四件事：
//   1) backupDb 备份完立刻自校验（quick_check + 卡片数），坏备份自己消失、返回 ok:false；
//   2) 同一天只留最新一份（小时级重复触发不会把保留窗口挤没）；
//   3) 保留策略两条都生效：**按天过期**（keepDays）+ **份数上限**（maxKeep）；
//   4) 「上次成功备份时间」持久化在 backups/.last-backup.json（定时器跨进程重启靠它）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeCard, setCardStatus } from '../lib/vault.js'
import { backupDb, restoreFromBackup, probeDbFile, closeDb, readBackupState, lastBackupAt, listBackupFiles, isExpiredBackup, backupDayOf } from '../lib/db.js'
import { ensureHealthy } from '../lib/auto-restore.js'

const body = (n) => '# 备份纪律\n' + ('- 第 ' + n + ' 条：备份要校验，保留要按天。\n').repeat(4)

async function makeVault(n = 3) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-backup-'))
  for (let i = 0; i < n; i++) {
    const r = await writeCard(root, { kind: 'knowledge', title: '备份纪律 ' + i, tags: [], body: body(i), status: 'pending', submittedBy: 'test' }, { dedup: false })
    await setCardStatus(root, r.path, 'approved')
  }
  const cleanup = () => {
    try { closeDb(root) } catch {}
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  }
  return { root, cleanup }
}

const backupsIn = (root) => fs.readdirSync(path.join(root, 'backups')).filter((f) => f.startsWith('memory-eternal-') && f.endsWith('.db')).sort()

/** `YYYY-MM-DD` 往前推 n 天（保留策略用例造历史备份用）。 */
const daysAgo = (n) => {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('backupDb：备份后自校验通过，卡片数与主库一致，且不留下 -wal/-shm 残件', async () => {
  const v = await makeVault(3)
  try {
    const r = await backupDb(v.root)
    assert.equal(r.ok, true, r.error)
    assert.equal(r.cards, 3, '自校验要回报真实卡片数')
    const files = backupsIn(v.root)
    assert.equal(files.length, 1)
    const probe = probeDbFile(path.join(v.root, 'backups', files[0]))
    assert.equal(probe.ok, true)
    assert.equal(probe.cards, 3)
    assert.deepEqual(fs.readdirSync(path.join(v.root, 'backups')).filter((f) => /-(wal|shm)$/.test(f)), [], '备份不该带 wal/shm 残件')
  } finally { v.cleanup() }
})

test('同一天重复备份只保留最新一份（保留窗口按天算）', async () => {
  const v = await makeVault(2)
  try {
    const a = await backupDb(v.root)
    assert.equal(a.ok, true, a.error)
    // 加一张卡再备份一次：同一天，应当只剩一份且包含最新数据
    const extra = await writeCard(v.root, { kind: 'knowledge', title: '后来的一张', tags: [], body: body(9), status: 'pending', submittedBy: 'test' }, { dedup: false })
    await setCardStatus(v.root, extra.path, 'approved')
    const b = await backupDb(v.root)
    assert.equal(b.ok, true, b.error)
    const files = backupsIn(v.root)
    assert.equal(files.length, 1, '同一天不该留下多份：' + files.join(', '))
    assert.equal(probeDbFile(path.join(v.root, 'backups', files[0])).cards, 3, '留下的必须是含最新数据的那份')
  } finally { v.cleanup() }
})

test('maxKeep 真正生效：保留最近 N 份、最旧的被清掉，latest 仍可还原', async () => {
  const v = await makeVault(2)
  try {
    // keepDays=0 = 关掉按天过期，本用例**只**验份数上限（两条策略分开验，避免互相掩盖）
    const first = await backupDb(v.root, { maxKeep: 3, keepDays: 0 })
    assert.equal(first.ok, true, first.error)
    // 造 3 份不同日期的历史备份（只需结构可用的真实备份）
    const dir = path.join(v.root, 'backups')
    for (const d of ['2020-01-01', '2020-01-02', '2020-01-03']) {
      fs.copyFileSync(first.path, path.join(dir, `memory-eternal-${d}_0300.db`))
    }
    const again = await backupDb(v.root, { maxKeep: 3, keepDays: 0 })
    assert.equal(again.ok, true, again.error)
    const files = backupsIn(v.root)
    assert.equal(files.length, 3, '应当只保留 3 份：' + files.join(', '))
    assert.ok(!files.some((f) => f.includes('2020-01-01')), '最旧的必须被清掉')
    assert.ok(again.prunedMaxKeep >= 1, '按份数清理的份数要如实回报：' + JSON.stringify(again))
    // latest 解析到最新一份且可用
    const out = await restoreFromBackup(v.root, { from: 'latest', dryRun: true, force: true })
    assert.equal(out.ok, true, out.error)
    assert.equal(out.cards, 2)
  } finally { v.cleanup() }
})

test('keepDays 真正生效：5 份不同日期 + keepDays=2 → 只剩窗口内的 2 份，pruned 如实回报', async () => {
  const v = await makeVault(2)
  try {
    const first = await backupDb(v.root, { keepDays: 0 })
    assert.equal(first.ok, true, first.error)
    // 造「今天 / 1 / 2 / 3 / 4 天前」5 份真实备份（今天这份是 backupDb 自己写的）
    const dir = path.join(v.root, 'backups')
    const todayName = path.basename(first.path)
    for (const d of [1, 2, 3, 4]) {
      fs.copyFileSync(first.path, path.join(dir, `memory-eternal-${daysAgo(d)}_0300.db`))
    }
    assert.equal(backupsIn(v.root).length, 5, '前置：应有 5 份备份')
    // 窗口 2 天 = 今天 + 昨天；3/4 天前必须被清掉
    const r = await backupDb(v.root, { keepDays: 2 })
    assert.equal(r.ok, true, r.error)
    const files = backupsIn(v.root)
    assert.equal(files.length, 2, 'keepDays=2 应只剩 2 份：' + files.join(', '))
    assert.ok(files.some((f) => f.startsWith(`memory-eternal-${daysAgo(0)}`)), '今天那份必须在')
    assert.ok(files.some((f) => f.startsWith(`memory-eternal-${daysAgo(1)}`)), '昨天那份必须在')
    assert.ok(!files.some((f) => f.startsWith(`memory-eternal-${daysAgo(2)}`)), '2 天前那份必须被清掉')
    assert.ok(!files.some((f) => f.startsWith(`memory-eternal-${daysAgo(3)}`)), '3 天前那份必须被清掉')
    assert.equal(r.pruned, r.prunedExpired + r.prunedMaxKeep, 'pruned = 过期清理 + 超限清理')
    assert.ok(r.prunedExpired >= 3, '过期清理份数应 ≥3（本次新建那份不算）：' + r.prunedExpired)
    assert.deepEqual(r.retention, { keepDays: 2, maxKeep: 0 }, '回报实际生效的保留策略')
    // 剩下的备份仍然可用
    assert.equal(probeDbFile(path.join(dir, files.find((f) => f.startsWith(`memory-eternal-${daysAgo(1)}`)))).ok, true)
  } finally { v.cleanup() }
})

test('保留策略两条同时生效：keepDays 先清过期，maxKeep 再兜底', async () => {
  const v = await makeVault(1)
  try {
    const first = await backupDb(v.root, { keepDays: 0 })
    assert.equal(first.ok, true, first.error)
    const dir = path.join(v.root, 'backups')
    // 窗口内的 3 天（今天/1/2 天前）+ 一个远在窗口外的老备份
    for (const d of [1, 2]) fs.copyFileSync(first.path, path.join(dir, `memory-eternal-${daysAgo(d)}_0300.db`))
    fs.copyFileSync(first.path, path.join(dir, 'memory-eternal-2019-05-05_0300.db'))
    assert.equal(backupsIn(v.root).length, 4)
    // keepDays=5（不会删窗口内的） + maxKeep=2：先过期清掉 2019，再按份数截到 2
    const r = await backupDb(v.root, { keepDays: 5, maxKeep: 2 })
    assert.equal(r.ok, true, r.error)
    const files = backupsIn(v.root)
    assert.equal(files.length, 2, 'maxKeep=2 是最后生效的上限：' + files.join(', '))
    assert.ok(!files.some((f) => f.includes('2019-05-05')), '窗口外的老备份必须被过期清理')
    assert.equal(r.prunedExpired, 1, '过期清理份数')
    assert.equal(r.prunedMaxKeep, files.length >= 2 ? r.prunedMaxKeep : 0, '超限清理份数（保留最新）')
    assert.ok(r.prunedMaxKeep >= 1, '份数上限必须真的删掉了东西：' + JSON.stringify(r))
  } finally { v.cleanup() }
})

test('保留策略的口径：日期取自文件名、认不出的不删、当天算第 1 天', () => {
  const today = daysAgo(0)
  assert.equal(backupDayOf(`memory-eternal-${today}_0300.db`), today)
  assert.equal(backupDayOf('memory-eternal-2024-02-29.db'), '2024-02-29')
  assert.equal(backupDayOf('memory-eternal-not-a-date.db'), '')
  assert.equal(isExpiredBackup(`memory-eternal-${today}_0300.db`, 1), false, '当天 = 第 1 天，不能被清')
  assert.equal(isExpiredBackup(`memory-eternal-${daysAgo(1)}_0300.db`, 1), true)
  assert.equal(isExpiredBackup(`memory-eternal-${daysAgo(1)}_0300.db`, 2), false)
  assert.equal(isExpiredBackup('memory-eternal-handmade.db', 1), false, '认不出日期的一律不删')
  assert.equal(isExpiredBackup(`memory-eternal-${daysAgo(9)}_0300.db`, 0), false, 'keepDays=0 = 关闭按天过期')
})

test('「上次成功备份时间」持久化：状态文件跨进程可读，失败不留成功时间', async () => {
  const v = await makeVault(1)
  try {
    assert.equal(lastBackupAt(v.root), 0, '从没备份过 → 0（定时器据此判断"立刻该备"）')
    const r = await backupDb(v.root, { keepDays: 30 })
    assert.equal(r.ok, true, r.error)
    const st = readBackupState(v.root)
    assert.equal(st.name, path.basename(r.path))
    assert.equal(st.cards, 1)
    assert.ok(st.atMs > 0)
    assert.equal(lastBackupAt(v.root), st.atMs, '定时器读到的就是这次成功备份的时间')
    const files = await listBackupFiles(v.root)
    assert.equal(files.length, 1)
    assert.equal(files[0].day, backupDayOf(files[0].name))
    assert.equal(typeof files[0].sizeMB, 'number')
  } finally { v.cleanup() }
})

test('ensureHealthy：库不存在 / 库健康 两种常态都不动任何文件', async () => {
  const v = await makeVault(1)
  try {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'me-no-db-'))
    try {
      const r = await ensureHealthy(empty)
      assert.equal(r.ok, false)
      assert.equal(r.action, 'no-db')
    } finally { fs.rmSync(empty, { recursive: true, force: true, maxRetries: 5 }) }
    const ok = await ensureHealthy(v.root)
    assert.equal(ok.ok, true)
    assert.equal(ok.action, 'none')
    assert.equal(ok.cards, 1)
  } finally { v.cleanup() }
})

test('ensureHealthy：主库被写成垃圾 → 用最新可用备份自动重建，留证文件仍在（绝不删）', async () => {
  const v = await makeVault(2)
  try {
    const b = await backupDb(v.root, { keepDays: 30 })
    assert.equal(b.ok, true, b.error)
    // 备份之后又写一张：按 RPO 语义这一步会丢，正好证明"真的用了备份"
    const extra = await writeCard(v.root, { kind: 'knowledge', title: '备份之后的一张', tags: [], body: body(7), status: 'pending', submittedBy: 'test' }, { dedup: false })
    await setCardStatus(v.root, extra.path, 'approved')
    closeDb(v.root)
    const dbFile = path.join(v.root, 'memory-eternal.db')
    fs.writeFileSync(dbFile, 'THIS IS NOT A SQLITE DATABASE')
    assert.equal(probeDbFile(dbFile).ok, false, '前置：主库此刻确实不可用')

    const out = await ensureHealthy(v.root, { env: { DSH_HOME: path.join(v.root, '.no-such-home') } })
    assert.equal(out.ok, true, '应当自动还原成功：' + JSON.stringify(out))
    assert.equal(out.action, 'restored')
    assert.equal(out.cards, 2, '恢复到备份时点的 2 张')
    assert.equal(out.from, b.path, '用的是那份已验证的备份')
    assert.ok(out.movedAside.length >= 1, '坏库必须改名留证')
    for (const f of out.movedAside) assert.ok(fs.existsSync(f), '留证文件必须真的存在：' + f)
    assert.equal(probeDbFile(dbFile).cards, 2, '还原后主库可用')
  } finally { v.cleanup() }
})

test('ensureHealthy：没有可用备份时保持现场不动（action=no-backup）', async () => {
  const v = await makeVault(1)
  try {
    closeDb(v.root)
    const dbFile = path.join(v.root, 'memory-eternal.db')
    fs.writeFileSync(dbFile, 'broken')
    const out = await ensureHealthy(v.root, { env: { DSH_HOME: path.join(v.root, '.no-such-home') } })
    assert.equal(out.ok, false)
    assert.equal(out.action, 'no-backup')
    assert.equal(fs.readFileSync(dbFile, 'utf8'), 'broken', '没有备份时不许动现场')
    assert.deepEqual(fs.readdirSync(v.root).filter((f) => f.includes('.corrupt-')), [], '也不该产生留证文件')
  } finally { v.cleanup() }
})

test('ensureHealthy：backupAutoRestore=false 时什么都不做（action=disabled）', async () => {
  const v = await makeVault(1)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-cfg-'))
  try {
    const b = await backupDb(v.root, { keepDays: 30 })
    assert.equal(b.ok, true, b.error)
    fs.writeFileSync(path.join(home, 'memory-eternal-config.json'), JSON.stringify({ backupAutoRestore: false }))
    closeDb(v.root)
    const dbFile = path.join(v.root, 'memory-eternal.db')
    fs.writeFileSync(dbFile, 'broken')
    const out = await ensureHealthy(v.root, { env: { DSH_HOME: home } })
    assert.equal(out.ok, false)
    assert.equal(out.action, 'disabled')
    assert.equal(fs.readFileSync(dbFile, 'utf8'), 'broken', '关闭自动还原时不许动现场')
  } finally {
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } catch {}
    v.cleanup()
  }
})
