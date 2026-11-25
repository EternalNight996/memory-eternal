// P1 同步身份：uid / field_hlc / card_events 的基础行为。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureVault, writeCard, setCardStatus, updateCardContent, deleteCard, restoreCard } from '../lib/vault.js'
import { getDb, closeDb, migrateSyncIdentity } from '../lib/db.js'
import { uuidv7, nowHlc, compareHlc } from '../lib/hlc.js'

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'me-sync-')) }
function cleanup(root) {
  try { closeDb(root) } catch { /* 忽略 */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* Windows 句柄延迟 */ }
}
const events = (db) => db.prepare('SELECT op, uid FROM card_events ORDER BY id').all()

test('uuidv7 格式与 HLC 单调', () => {
  const ids = new Set()
  for (let i = 0; i < 50; i++) ids.add(uuidv7())
  assert.equal(ids.size, 50)
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  const a = nowHlc('', 'pc')
  const b = nowHlc(a, 'pc')
  assert.equal(compareHlc(b, a), 1, '同设备后续 HLC 必须更大')
  assert.equal(compareHlc(a, a), 0)
})

test('写卡：uid 稳定、field_hlc 记录字段、create 事件', async () => {
  const root = tmp()
  try {
    await ensureVault(root)
    const w = await writeCard(root, { kind: 'knowledge', title: 'Sync A', body: '正文 A', status: 'pending' }, { dedup: false })
    assert.match(w.uid, /^[0-9a-f-]{36}$/)
    const db = getDb(root)
    const row = db.prepare('SELECT uid, field_hlc, origin_device FROM quarantine WHERE path = ?').get(w.path)
    assert.equal(row.uid, w.uid)
    const fh = JSON.parse(row.field_hlc)
    assert.ok(fh.title && fh.body && fh.tags)
    assert.equal(row.origin_device, 'local')
    const ev = events(db)
    assert.equal(ev.length, 1)
    assert.equal(ev[0].op, 'create')
    assert.equal(ev[0].uid, w.uid)
  } finally { cleanup(root) }
})

test('更新：只改 body 时只有 body 的 field_hlc 前进，并产生 update 事件', async () => {
  const root = tmp()
  try {
    await ensureVault(root)
    const w = await writeCard(root, { kind: 'knowledge', title: 'Sync B', body: '旧正文', status: 'pending' }, { dedup: false })
    const db = getDb(root)
    const before = JSON.parse(db.prepare('SELECT field_hlc FROM quarantine WHERE path = ?').get(w.path).field_hlc)
    await updateCardContent(root, w.path, { body: '新正文' })
    const after = JSON.parse(db.prepare('SELECT field_hlc FROM quarantine WHERE path = ?').get(w.path).field_hlc)
    assert.equal(compareHlc(after.body, before.body), 1, 'body 的 HLC 应变大')
    assert.equal(after.title, before.title, 'title 未改，HLC 不应变')
    const ev = events(db)
    assert.equal(ev[ev.length - 1].op, 'update')
  } finally { cleanup(root) }
})

test('状态流转：批准搬表保留 uid，删除/恢复都有事件', async () => {
  const root = tmp()
  try {
    await ensureVault(root)
    const w = await writeCard(root, { kind: 'knowledge', title: 'Sync C', body: '正文 C', status: 'pending' }, { dedup: false })
    const db = getDb(root)
    await setCardStatus(root, w.path, 'approved', { changedBy: 'test' })
    const inCards = db.prepare('SELECT uid FROM cards WHERE path = ?').get(w.path)
    assert.equal(inCards.uid, w.uid, '搬表后 uid 不变')
    await deleteCard(root, w.path)
    await restoreCard(root, w.path)
    const ops = events(db).map((e) => e.op)
    assert.deepEqual(ops, ['create', 'update', 'delete', 'restore'])
    assert.ok(events(db).every((e) => e.uid === w.uid))
  } finally { cleanup(root) }
})

test('迁移：老卡（uid 为空）会被回填，且重复迁移幂等', async () => {
  const root = tmp()
  try {
    await ensureVault(root)
    const w = await writeCard(root, { kind: 'knowledge', title: 'Sync D', body: '正文 D', status: 'pending' }, { dedup: false })
    const db = getDb(root)
    await setCardStatus(root, w.path, 'approved', { changedBy: 'test' })
    db.prepare('UPDATE cards SET uid = NULL').run()
    migrateSyncIdentity(db)
    const n1 = db.prepare("SELECT COUNT(*) n FROM cards WHERE uid IS NULL OR uid = ''").get().n
    assert.equal(n1, 0, '回填后不应有空 uid')
    const uid1 = db.prepare('SELECT uid FROM cards WHERE path = ?').get(w.path).uid
    migrateSyncIdentity(db)
    const uid2 = db.prepare('SELECT uid FROM cards WHERE path = ?').get(w.path).uid
    assert.equal(uid2, uid1, '重复迁移不应改已有 uid')
  } finally { cleanup(root) }
})

test('回填性能：2000 张老卡在事务里回填，必须远快于逐条提交（防 214 秒回归）', async () => {
  const root = tmp()
  try {
    await ensureVault(root)
    const db = getDb(root)
    const ins = db.prepare("INSERT INTO cards (id, path, kind, title, tags, body, summary, status, source, uid, created_at, updated_at) VALUES (?, ?, 'knowledge', ?, '[]', ?, ?, 'approved', 'test', NULL, datetime('now'), datetime('now'))")
    db.exec('BEGIN')
    for (let i = 0; i < 2000; i++) ins.run(100000 + i, '03-Knowledge/perf-' + i + '.md', 'Perf ' + i, 'body ' + i, 'body ' + i)
    db.exec('COMMIT')
    closeDb(root)
    const t0 = Date.now()
    const db2 = getDb(root)
    const ms = Date.now() - t0
    const left = db2.prepare("SELECT COUNT(*) n FROM cards WHERE uid IS NULL OR uid = ''").get().n
    assert.equal(left, 0)
    // 事务回填 2k 约 100ms；逐条自动提交会到 40s+，这里给足余量但能抓住回归
    assert.ok(ms < 20000, '回填耗时 ' + ms + 'ms，疑似退回逐条提交')
  } finally { cleanup(root) }
})
