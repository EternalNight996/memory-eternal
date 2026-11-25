// 同源技能卡合并：cards.source 对 approved 的 skill 卡有唯一索引，第二份不能 INSERT。
// 技能卡写入时一律进待审（enforceAudit 强制），真实链路是「批准时合并」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureVault, writeCard, setCardStatus, listCards, countCards } from '../lib/vault.js'
import { closeDb } from '../lib/db.js'

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'me-skillmerge-')) }
function cleanup(root) {
  try { closeDb(root) } catch { /* 忽略 */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* Windows 句柄延迟 */ }
}

test('待审的同源技能卡：批准时合并到已有卡，不抛 UNIQUE', async () => {
  const root = tmp()
  try {
    await ensureVault(root)
    const p1 = await writeCard(root, { kind: 'skill', title: 'Skill Bar', body: '第一版', source: 'skill:bar', status: 'pending' }, { dedup: false })
    assert.equal(p1.ok, true, JSON.stringify(p1))
    const r1 = await setCardStatus(root, p1.path, 'approved', { changedBy: 'test' })
    assert.equal(r1.ok, true, JSON.stringify(r1))
    assert.equal(await countCards(root, {}), 1)

    const p2 = await writeCard(root, { kind: 'skill', title: 'Skill Bar', body: '第二版（新）', source: 'skill:bar', status: 'pending' }, { dedup: false })
    assert.equal(p2.ok, true, JSON.stringify(p2))
    const r2 = await setCardStatus(root, p2.path, 'approved', { changedBy: 'test' })
    assert.equal(r2.ok, true, JSON.stringify(r2))
    assert.equal(r2.merged, true, '应合并而不是插入')
    assert.equal(r2.path, p1.path, '合并到已批准的卡')
    assert.equal(await countCards(root, {}), 1, '主库只应有一张')
    const cards = await listCards(root, { status: 'approved' })
    assert.match(String(cards[0].summary || cards[0].body || ''), /第二版/, '较新内容应覆盖')
  } finally { cleanup(root) }
})

test('不同 source 的技能卡互不影响', async () => {
  const root = tmp()
  try {
    await ensureVault(root)
    const a = await writeCard(root, { kind: 'skill', title: 'Skill A', body: 'A', source: 'skill:a', status: 'pending' }, { dedup: false })
    const b = await writeCard(root, { kind: 'skill', title: 'Skill B', body: 'B', source: 'skill:b', status: 'pending' }, { dedup: false })
    await setCardStatus(root, a.path, 'approved', { changedBy: 'test' })
    const rb = await setCardStatus(root, b.path, 'approved', { changedBy: 'test' })
    assert.equal(rb.ok, true, JSON.stringify(rb))
    assert.equal(rb.merged, undefined, '不同 source 不应合并')
    assert.equal(await countCards(root, {}), 2)
  } finally { cleanup(root) }
})
