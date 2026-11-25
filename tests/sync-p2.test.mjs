// P2：事件推送/拉取、字段级合并、删除传播、幂等、digest 收敛。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureVault, writeCard, updateCardContent, deleteCard, restoreCard, setCardStatus } from '../lib/vault.js'
import { applyEvent } from '../lib/sync.js'
import { getDb, closeDb } from '../lib/db.js'
import { pendingEvents, markEventsSynced, appendRemoteEvents, pullEvents, digestOf, reconcileContentDuplicates, snapshotOf, vaultCardCount } from '../lib/sync.js'

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'me-syncp2-')) }
function setup() { const a = tmp(); const b = tmp(); return { a, b } }
async function clean(...roots) {
  for (const r of roots) { try { closeDb(r) } catch { /* 忽略 */ } try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* 忽略 */ } }
}
function useDevice(id) { process.env.MEMORY_ETERNAL_DEVICE = id }
function eventsOf(root, dev) { return pendingEvents(root, dev) }
function pushTo(dst, events) { return appendRemoteEvents(dst, events.map((e) => ({ ...e }))) }

test('P2：A 写卡 → 事件推给 B（幂等），digest 收敛', async () => {
  const { a, b } = setup()
  try {
    useDevice('devA'); await ensureVault(a)
    useDevice('devB'); await ensureVault(b)
    useDevice('devA')
    const w = await writeCard(a, { kind: 'knowledge', title: 'P2 A', body: '正文 A', status: 'pending' }, { dedup: false })
    const evs = eventsOf(a, 'devA')
    assert.ok(evs.length >= 1, '本机应有待推送事件')
    assert.equal(evs[0].patch.body, '正文 A', 'create 事件要带完整快照')
    const r1 = pushTo(b, evs)
    assert.equal(r1.accepted, evs.length)
    const cardsB = getDb(b).prepare('SELECT uid, body, status FROM quarantine').all()
    assert.equal(cardsB.length, 1)
    assert.equal(cardsB[0].uid, w.uid)
    assert.equal(cardsB[0].status, 'pending')
    assert.equal(digestOf(a).digest, digestOf(b).digest, '同步后 digest 应一致')
    const r2 = pushTo(b, evs)
    assert.equal(r2.accepted, 0, '重复推送应全部幂等跳过')
    assert.equal(r2.skipped, evs.length)
  } finally { await clean(a, b) }
})

test('P2：不同设备改不同字段 → 字段级合并，不互相覆盖', async () => {
  const { a, b } = setup()
  try {
    useDevice('devA'); await ensureVault(a)
    useDevice('devB'); await ensureVault(b)
    useDevice('devA')
    const w = await writeCard(a, { kind: 'knowledge', title: '原标题', body: '原正文', status: 'pending' }, { dedup: false })
    const createEvs = eventsOf(a, 'devA')
    pushTo(b, createEvs)
    markEventsSynced(a, createEvs.map((e) => e.id), 1)
    // A 改正文
    useDevice('devA'); await updateCardContent(a, w.path, { body: 'A 的新正文' })
    const aUpd = eventsOf(a, 'devA').filter((e) => e.op === 'update')
    markEventsSynced(a, aUpd.map((e) => e.id), 2)
    // B 改标题
    useDevice('devB'); const pathB = getDb(b).prepare('SELECT path FROM quarantine WHERE uid = ?').get(w.uid).path
    await updateCardContent(b, pathB, { title: 'B 的新标题' })
    const bUpd = eventsOf(b, 'devB').filter((e) => e.op === 'update')
    // 双向推送
    pushTo(b, aUpd)
    const bRow = getDb(b).prepare('SELECT title, body FROM quarantine WHERE uid = ?').get(w.uid)
    assert.equal(bRow.body, 'A 的新正文', 'A 改的正文应合并进来')
    assert.equal(bRow.title, 'B 的新标题', 'B 改的标题不应被覆盖')
    pushTo(a, bUpd)
    const aRow = getDb(a).prepare('SELECT title, body FROM quarantine WHERE uid = ?').get(w.uid)
    assert.equal(aRow.title, 'B 的新标题')
    assert.equal(aRow.body, 'A 的新正文')
    assert.equal(digestOf(a).digest, digestOf(b).digest)
  } finally { await clean(a, b) }
})

test('P2：删除/恢复传播到另一台设备', async () => {
  const { a, b } = setup()
  try {
    useDevice('devA'); await ensureVault(a)
    useDevice('devB'); await ensureVault(b)
    useDevice('devA')
    const w = await writeCard(a, { kind: 'knowledge', title: 'P2 Del', body: '正文', status: 'pending' }, { dedup: false })
    const c = eventsOf(a, 'devA'); pushTo(b, c); markEventsSynced(a, c.map((e) => e.id), 1)
    await deleteCard(a, w.path)
    const d = eventsOf(a, 'devA').filter((e) => e.op === 'delete'); markEventsSynced(a, d.map((e) => e.id), 2)
    pushTo(b, d)
    const bDel = getDb(b).prepare('SELECT status FROM quarantine WHERE uid = ?').get(w.uid)
    assert.equal(bDel.status, 'deleted')
    await restoreCard(a, w.path)
    const r = eventsOf(a, 'devA').filter((e) => e.op === 'restore'); markEventsSynced(a, r.map((e) => e.id), 3)
    pushTo(b, r)
    const bBack = getDb(b).prepare('SELECT status FROM cards WHERE uid = ?').get(w.uid)
    assert.equal(bBack && bBack.status, 'approved')
    assert.equal(digestOf(a).digest, digestOf(b).digest)
  } finally { await clean(a, b) }
})

test('P2：pull 游标增量', async () => {
  const { a, b } = setup()
  try {
    useDevice('devA'); await ensureVault(a)
    useDevice('devB'); await ensureVault(b)
    useDevice('devA')
    const w = await writeCard(a, { kind: 'knowledge', title: 'P2 Pull', body: '正文', status: 'pending' }, { dedup: false })
    pushTo(b, eventsOf(a, 'devA'))
    const p1 = pullEvents(b, 0)
    assert.ok(p1.events.length >= 1)
    assert.ok(p1.nextSince >= 1)
    const p2 = pullEvents(b, p1.nextSince)
    assert.equal(p2.events.length, 0, '游标之后不应再有事件')
    assert.equal(p2.nextSince, p1.nextSince)
  } finally { await clean(a, b) }
})

test('P2：同源技能卡事件不会撞 source 唯一索引（合并/跳过）', async () => {
  const { a, b } = setup()
  try {
    useDevice('devA'); await ensureVault(a)
    useDevice('devB'); await ensureVault(b)
    // B 先有一张已批准的技能卡
    useDevice('devB')
    const wb = await writeCard(b, { kind: 'skill', title: 'Skill X', body: 'B 版', source: 'skill:x', status: 'pending' }, { dedup: false })
    await setCardStatus(b, wb.path, 'approved', { changedBy: 'test' })
    // A 发来同 source 的 approved create 事件
    const uid2 = '01a2112800007000800000000000beef'
    const hlc = '001795700000000-0000-devA'
    const ev = { uid: uid2, op: 'create', patch: { kind: 'skill', source: 'skill:x', status: 'approved', title: 'Skill X', body: 'A 版' }, hlc, field_hlc: { title: hlc, body: hlc }, device: 'devA', device_seq: 1 }
    const r = appendRemoteEvents(b, [ev])
    assert.equal(r.accepted, 1, JSON.stringify(r))
    const cards = getDb(b).prepare("SELECT uid, body FROM cards WHERE kind = 'skill' AND source = 'skill:x'").all()
    assert.equal(cards.length, 1, '同源技能卡只能有一张 approved')
    assert.equal(cards[0].uid, wb.uid, '应合并进已有卡')
  } finally { await clean(a, b) }
})

test('P3a：同内容不同 uid 历史对账 → 归并 + 广播，三端收敛', async () => {
  const a = tmp(); const b = tmp(); const c = tmp()
  try {
    useDevice('devA'); await ensureVault(a)
    useDevice('devB'); await ensureVault(b)
    useDevice('devC'); await ensureVault(c)
    // A/B 各自有一张内容相同但 uid 不同的卡（模拟 P1 前各自回填）
    useDevice('devA')
    const wa = await writeCard(a, { kind: 'knowledge', title: '同一张卡', body: '同样的正文内容', status: 'pending' }, { dedup: false })
    useDevice('devB')
    const wb = await writeCard(b, { kind: 'knowledge', title: '同一张卡', body: '同样的正文内容', status: 'pending' }, { dedup: false })
    assert.notEqual(wa.uid, wb.uid)
    // 云端 C 收到两边的 create 事件
    appendRemoteEvents(c, pendingEvents(a, 'devA'))
    appendRemoteEvents(c, pendingEvents(b, 'devB'))
    assert.equal(getDb(c).prepare('SELECT COUNT(*) n FROM quarantine').get().n, 2, '云端先有两张同内容卡')
    // 对账
    const rec = reconcileContentDuplicates(c, 'devC')
    assert.equal(rec.groups, 1)
    assert.equal(rec.removed, 1)
    assert.equal(getDb(c).prepare('SELECT COUNT(*) n FROM quarantine').get().n, 1, '对账后只留一张')
    // 把对账事件（delete 输家 + update 保留卡）广播回 A/B
    const evs = pendingEvents(c, 'devC')
    assert.ok(evs.some((e) => e.op === 'delete'), '应有删除输家的墓碑事件')
    assert.ok(evs.some((e) => e.op === 'update'), '应有保留卡的全量事件')
    appendRemoteEvents(a, evs)
    appendRemoteEvents(b, evs)
    // 三端 digest 一致；A/B 都只剩保留卡
    assert.equal(digestOf(a).digest, digestOf(c).digest, 'A 应与云端一致')
    assert.equal(digestOf(b).digest, digestOf(c).digest, 'B 应与云端一致')
    assert.equal(getDb(a).prepare('SELECT COUNT(*) n FROM quarantine').get().n, 1)
    assert.equal(getDb(b).prepare('SELECT COUNT(*) n FROM quarantine').get().n, 1)
  } finally { await clean(a, b, c) }
})

test('P3a：云端对账事件必须发布（server_seq），否则 pull 收不到', async () => {
  const a = tmp(); const c = tmp()
  try {
    useDevice('devA'); await ensureVault(a)
    useDevice('devC'); await ensureVault(c)
    useDevice('devA')
    await writeCard(a, { kind: 'knowledge', title: '发布测试', body: '同样内容', status: 'pending' }, { dedup: false })
    await writeCard(a, { kind: 'knowledge', title: '发布测试', body: '同样内容', status: 'pending' }, { dedup: false })
    appendRemoteEvents(c, pendingEvents(a, 'devA'))
    useDevice('devC')
    const rec = reconcileContentDuplicates(c, 'devC', { publish: true })
    assert.equal(rec.removed, 1)
    const pull = pullEvents(c, 0)
    assert.ok(pull.events.some((e) => e.op === 'delete'), '墓碑事件应已发布')
    assert.ok(pull.events.some((e) => e.op === 'update'), '保留卡全量事件应已发布')
    assert.ok(pull.events.every((e) => Number(e.server_seq) > 0), 'server_seq 必须已分配')
  } finally { await clean(a, c) }
})

test('P4a：新设备空库用快照种子，digest 与源库一致（含分页）', async () => {
  const a = tmp(); const b = tmp()
  try {
    useDevice('devA'); await ensureVault(a)
    useDevice('devA')
    const w1 = await writeCard(a, { kind: 'knowledge', title: 'Seed 1', body: '正文一', status: 'pending' }, { dedup: false })
    await setCardStatus(a, w1.path, 'approved', { changedBy: 'test' })
    await writeCard(a, { kind: 'knowledge', title: 'Seed 2', body: '正文二', status: 'pending' }, { dedup: false })
    assert.equal(vaultCardCount(a), 2)
    // 分页遍历快照
    let cursor = ''; const items = []
    for (let i = 0; i < 10; i++) {
      const page = snapshotOf(a, cursor, 1)
      items.push(...page.items)
      cursor = page.nextCursor
      if (!page.hasMore) break
    }
    assert.equal(items.length, 2)
    // 应用到空设备
    useDevice('devB'); await ensureVault(b)
    assert.equal(vaultCardCount(b), 0)
    for (const item of items) applyEvent(b, item)
    assert.equal(vaultCardCount(b), 2)
    assert.equal(digestOf(a).digest, digestOf(b).digest, '新设备 digest 应与源库一致')
  } finally { await clean(a, b) }
})

test('P3b：同字段并发编辑 → LWW + 输家进审核（冲突副本）', async () => {
  const { a, b } = setup()
  try {
    useDevice('devA'); await ensureVault(a)
    useDevice('devB'); await ensureVault(b)
    useDevice('devA')
    const w = await writeCard(a, { kind: 'knowledge', title: '并发卡', body: 'base 正文', status: 'pending' }, { dedup: false })
    pushTo(b, eventsOf(a, 'devA'))
    markEventsSynced(a, eventsOf(a, 'devA').map((e) => e.id), 1)
    // A 改正文
    useDevice('devA'); await updateCardContent(a, w.path, { body: 'A 的版本' })
    const aUpd = eventsOf(a, 'devA').filter((e) => e.op === 'update'); markEventsSynced(a, aUpd.map((e) => e.id), 2)
    // B 改同一字段（同一 base）
    useDevice('devB'); const pathB = getDb(b).prepare('SELECT path FROM quarantine WHERE uid = ?').get(w.uid).path
    await updateCardContent(b, pathB, { body: 'B 的版本' })
    const bUpd = eventsOf(b, 'devB').filter((e) => e.op === 'update')
    // 互相推送：双方都应保留 LWW 赢家 + 一张冲突待审
    pushTo(b, aUpd)
    pushTo(a, bUpd)
    const winnerB = getDb(b).prepare('SELECT body FROM quarantine WHERE uid = ?').get(w.uid)
    const conflictsB = getDb(b).prepare("SELECT uid, title, body, status, source FROM quarantine WHERE source = 'sync-conflict'").all()
    assert.equal(conflictsB.length, 1, 'B 应有 1 张冲突副本')
    assert.equal(conflictsB[0].status, 'pending')
    assert.match(conflictsB[0].title, /冲突副本/)
    assert.notEqual(winnerB.body, conflictsB[0].body, '赢家与输家内容应不同')
    const conflictsA = getDb(a).prepare("SELECT uid, body FROM quarantine WHERE source = 'sync-conflict'").all()
    assert.equal(conflictsA.length, 1, 'A 也应有 1 张冲突副本')
    assert.notEqual(winnerB.body, '', '赢家正文不能为空')
  } finally { await clean(a, b) }
})
