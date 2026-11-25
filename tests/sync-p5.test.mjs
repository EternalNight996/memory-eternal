// P5：设备心跳/对齐任务 + 事件日志 GC。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureVault, writeCard } from '../lib/vault.js'
import { getDb, closeDb } from '../lib/db.js'
import {
  recordDeviceHello, completeSyncTask, listSyncTasks, compactEvents,
  digestOf, pendingEvents, markEventsSynced,
} from '../lib/sync.js'

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'me-p5-')) }
function cleanup(root) {
  try { closeDb(root) } catch { /* 忽略 */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

test('P5a：digest 不一致 → 登记对齐任务；一致 → 不登记；完成 → done', async () => {
  const root = tmp()
  try {
    await ensureVault(root)
    process.env.MEMORY_ETERNAL_DEVICE = 'devP5'
    await writeCard(root, { kind: 'knowledge', title: 'P5', body: '正文', status: 'pending' }, { dedup: false })
    const bad = recordDeviceHello(root, { device: 'devP5', cursor: 0, digest: 'deadbeef', pending: 0 })
    assert.equal(bad.ok, true)
    assert.equal(bad.mismatch, true)
    assert.ok(bad.task && bad.task.id, '应创建对齐任务')
    const good = recordDeviceHello(root, { device: 'devP5', cursor: 0, digest: digestOf(root).digest, pending: 0 })
    assert.equal(good.mismatch, false)
    assert.equal(listSyncTasks(root, { state: 'pending' }).tasks.length, 1, 'pending 任务只保留一条')
    completeSyncTask(root, bad.task.id, { ok: true })
    const done = listSyncTasks(root, { state: 'done' }).tasks
    assert.ok(done.some((t) => t.id === bad.task.id), '任务应标记 done')
  } finally { cleanup(root) }
})

test('P5b：GC 只删已同步且过期的事件，未同步事件保留', async () => {
  const root = tmp()
  try {
    await ensureVault(root)
    process.env.MEMORY_ETERNAL_DEVICE = 'devGC'
    await writeCard(root, { kind: 'knowledge', title: 'GC1', body: '正文1', status: 'pending' }, { dedup: false })
    const db = getDb(root)
    const pend = pendingEvents(root, 'devGC')
    markEventsSynced(root, pend.map((e) => e.id), 1)
    db.prepare("UPDATE card_events SET created_at = datetime('now', '-40 days') WHERE id = ?").run(pend[0].id)
    // 再写一张：事件未同步
    await writeCard(root, { kind: 'knowledge', title: 'GC2', body: '正文2', status: 'pending' }, { dedup: false })
    const before = db.prepare('SELECT COUNT(*) n FROM card_events').get().n
    const out = compactEvents(root, { keepDays: 30 })
    const after = db.prepare('SELECT COUNT(*) n FROM card_events').get().n
    assert.equal(out.removed, 1)
    assert.equal(before - after, 1)
    const left = db.prepare('SELECT COUNT(*) n FROM card_events WHERE server_seq IS NULL').get().n
    assert.ok(left >= 1, '未同步事件必须保留')
  } finally { cleanup(root) }
})
