import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  ensureVault,
  writeCard,
  search,
  setCardStatus,
  recordRecallHits,
  createCorrection,
} from '../lib/vault.js'
import { getDb, setAuditConfig, closeAllDb } from '../lib/db.js'

const root = path.join(process.cwd(), '.tmp-correction-test')
fs.rmSync(root, { recursive: true, force: true })
fs.mkdirSync(root, { recursive: true })

const db = () => getDb(root)

try {
  await ensureVault(root)
  // 让测试写入的旧卡直接 approved；修订卡由 createCorrection 强制 pending。
  await setAuditConfig(root, { auditMode: 'all', auditExemptAgents: ['test'], auditExemptKinds: [] })

  // 1. 旧卡可召回，召回命中被记录
  const old = await writeCard(root, {
    kind: 'knowledge', title: '测试纠错卡', body: '测试事实：旧值 A', status: 'approved', submittedBy: 'test',
  }, { dedup: false })
  assert.equal(old.ok, true)
  assert.equal(old.status, 'approved')

  let hits = await search(root, '事实', { limit: 5 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].path, old.path)
  recordRecallHits(root, { session: 's1', query: '事实', hits })
  assert.equal(db().prepare('SELECT COUNT(*) AS n FROM recall_hits').get().n, 1)

  // 2. 创建修订：旧卡不动，修订卡在隔离区 pending
  const corr = await createCorrection(root, {
    path: old.path,
    body: '测试事实：新值 B（已修正）',
    cause: 'wrong',
    evidence: '用户纠正：旧值 A 是错的',
    query: '事实',
    session: 's1',
  })
  assert.equal(corr.ok, true)
  assert.equal(corr.existing, false)
  assert.equal(db().prepare('SELECT status FROM quarantine WHERE path = ?').get(corr.pending_path).status, 'pending')
  assert.equal(db().prepare('SELECT status FROM cards WHERE path = ?').get(old.path).status, 'approved')
  hits = await search(root, '事实', { limit: 5 })
  assert.equal(hits.some((h) => h.path === corr.pending_path), false)

  // 3. 批准修订：新卡进主库，旧卡进回收站，关系置 applied，回归通过
  const applied = await setCardStatus(root, corr.pending_path, 'approved', { changedBy: 'user' })
  assert.equal(applied.ok, true)
  assert.equal(applied.correction_id, corr.correction_id)
  assert.equal(applied.verify_status, 'passed')
  assert.equal(db().prepare('SELECT status FROM cards WHERE path = ?').get(corr.pending_path).status, 'approved')
  assert.equal(db().prepare('SELECT status, deleted_at FROM quarantine WHERE path = ?').get(old.path).status, 'deleted')
  assert.equal(db().prepare('SELECT status, verify_status FROM corrections WHERE id = ?').get(corr.correction_id).status, 'applied')
  assert.equal(db().prepare('SELECT status, verify_status FROM corrections WHERE id = ?').get(corr.correction_id).verify_status, 'passed')
  hits = await search(root, '事实', { limit: 5 })
  assert.equal(hits.some((h) => h.path === corr.pending_path), true)
  assert.equal(hits.some((h) => h.path === old.path), false)

  // 4. 驳回修订：旧卡保持，关系置 rejected
  const old2 = await writeCard(root, {
    kind: 'knowledge', title: '测试驳回卡', body: '测试事实：驳回前的值', status: 'approved', submittedBy: 'test',
  }, { dedup: false })
  const corr2 = await createCorrection(root, { path: old2.path, body: '测试事实：不应该生效', cause: 'outdated' })
  await setCardStatus(root, corr2.pending_path, 'rejected', { changedBy: 'user', reason: '证据不足' })
  assert.equal(db().prepare('SELECT status FROM cards WHERE path = ?').get(old2.path).status, 'approved')
  assert.equal(db().prepare('SELECT status FROM corrections WHERE id = ?').get(corr2.correction_id).status, 'rejected')
  hits = await search(root, '驳回', { limit: 5 })
  assert.equal(hits.some((h) => h.path === old2.path), true)

  // 5. 即使 auditMode=none，修订也不能被自动批准（forcePending 兜底）
  await setAuditConfig(root, { auditMode: 'none', auditExemptAgents: [], auditExemptKinds: [] })
  const old3 = await writeCard(root, {
    kind: 'knowledge', title: '测试免审卡', body: '测试事实：免审旧值', status: 'approved', submittedBy: 'test',
  }, { dedup: false })
  assert.equal(old3.status, 'approved')
  const corr3 = await createCorrection(root, { path: old3.path, body: '测试事实：免审新值', cause: 'wrong' })
  assert.equal(corr3.ok, true)
  assert.equal(db().prepare('SELECT status FROM quarantine WHERE path = ?').get(corr3.pending_path).status, 'pending')

  // 6. 卡本身没错（misused）不建修订
  const misuse = await createCorrection(root, { path: old3.path, body: '不该建', cause: 'misused' })
  assert.equal(misuse.ok, false)
  assert.equal(misuse.code, 'CARD_NOT_WRONG')

  // 7. 普通 pending 卡仍可正常批准（不经过修订分支）
  await setAuditConfig(root, { auditMode: 'all', auditExemptAgents: ['test'], auditExemptKinds: [] })
  const plain = await writeCard(root, {
    kind: 'knowledge', title: '普通待审卡', body: '普通待审内容', status: 'pending', submittedBy: 'other',
  }, { dedup: false })
  assert.equal(plain.status, 'pending')
  const plainApproved = await setCardStatus(root, plain.path, 'approved', { changedBy: 'user' })
  assert.equal(plainApproved.ok, true)
  assert.equal(db().prepare('SELECT status FROM cards WHERE path = ?').get(plain.path).status, 'approved')

  console.log('correction.test: all assertions passed')
} finally {
  closeAllDb()
  fs.rmSync(root, { recursive: true, force: true })
}
