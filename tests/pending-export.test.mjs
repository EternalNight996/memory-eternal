// 导出可包含待审卡；导入时 pending 必须落隔离区而不是主库。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { ensureVault, writeCard } from '../lib/vault.js'
import { getDb, closeDb } from '../lib/db.js'
import { createApi } from '../lib/api.js'

function tmpPair() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'me-pending-'))
  return { parent, a: path.join(parent, 'a'), b: path.join(parent, 'b') }
}

test('导出 includePending：待审卡进导出；导入后落隔离区，主库只有 approved', async () => {
  const { parent, a, b } = tmpPair()
  await ensureVault(a); await ensureVault(b)
  const handler = createApi({ vaultDir: () => a, vaultRoots: () => [{ name: 'v', root: a }], getSettings: () => ({}) })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/memory-eternal/api`
  try {
    const ok = await writeCard(a, { kind: 'knowledge', title: '已批准', body: 'A', status: 'approved' }, { dedup: false })
    const pend = await writeCard(a, { kind: 'knowledge', title: '待审卡', body: 'B', status: 'pending' }, { dedup: false })
    const without = await fetch(base + '/vaults/export').then((r) => r.json())
    assert.equal(without.cards.length, 1, '默认导出不含待审')
    const withPending = await fetch(base + '/vaults/export?includePending=1').then((r) => r.json())
    assert.equal(withPending.cards.length, 2, 'includePending 应包含待审')
    assert.ok(withPending.cards.some((c) => c.status === 'pending' && c.title === '待审卡'))
    // 导入到 b：approved 进 cards，pending 进 quarantine
    const imp = await fetch(base + '/vaults/import-into', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: b, cards: withPending.cards }) }).then((r) => r.json())
    assert.equal(imp.ok, true, JSON.stringify(imp))
    const db = getDb(b)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM cards').get().n, 1, '主库只应有 approved')
    assert.equal(db.prepare("SELECT COUNT(*) n FROM quarantine WHERE status = 'pending'").get().n, 1, '待审应进隔离区')
    assert.equal(db.prepare("SELECT COUNT(*) n FROM quarantine WHERE status = 'pending' AND title = '待审卡'").get().n, 1)
    void ok; void pend
  } finally {
    await new Promise((r) => srv.close(r))
    try { closeDb(a); closeDb(b) } catch { /* 忽略 */ }
    fs.rmSync(parent, { recursive: true, force: true })
  }
})
