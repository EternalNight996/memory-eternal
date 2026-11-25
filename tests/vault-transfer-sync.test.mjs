// 跨库显式搬运：必须携带同步身份（uid/field_hlc/vv）并补事件，否则设备 pull 不到。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { ensureVault, writeCard } from '../lib/vault.js'
import { getDb, closeDb } from '../lib/db.js'
import { digestOf } from '../lib/sync.js'
import { createApi } from '../lib/api.js'

function tmpPair() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'me-xfer-'))
  const a = path.join(parent, 'a')
  const b = path.join(parent, 'b')
  return { parent, a, b }
}
function withApi(root, fn) {
  const handler = createApi({ vaultDir: () => root, vaultRoots: () => [{ name: 'v', root }], getSettings: () => ({}) })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  return new Promise((resolve, reject) => {
    srv.listen(0, '127.0.0.1', async () => {
      let err = null
      try { await fn(`http://127.0.0.1:${srv.address().port}/memory-eternal/api`) } catch (e) { err = e }
      await new Promise((r) => srv.close(r))
      if (err) reject(err); else resolve()
    })
  })
}
async function cleanup(...roots) {
  for (const r of roots) { try { closeDb(r) } catch { /* 忽略 */ } }
  try { fs.rmSync(roots[0] && path.dirname(roots[0]), { recursive: true, force: true }) } catch { /* 忽略 */ }
}

test('跨库搬运：携带 uid/field_hlc/vv，补事件，digest 一致', async () => {
  const { a, b } = tmpPair()
  try {
    await ensureVault(a)
    await ensureVault(b)
    process.env.MEMORY_ETERNAL_DEVICE = 'devX'
    const w = await writeCard(a, { kind: 'knowledge', title: '搬运卡', body: '搬运正文', status: 'approved' }, { dedup: false })
    const wp = await writeCard(a, { kind: 'knowledge', title: '待审搬运', body: '待审正文', status: 'pending' }, { dedup: false })
    assert.ok(w.uid); assert.ok(wp.uid)
    await withApi(a, async (base) => {
      const dry = await fetch(base + '/vaults/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: a, target: b, dryRun: true }) }).then((r) => r.json())
      assert.equal(dry.ok, true, JSON.stringify(dry))
      assert.equal(dry.imported, 2)
      const real = await fetch(base + '/vaults/transfer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: a, target: b }) }).then((r) => r.json())
      assert.equal(real.ok, true, JSON.stringify(real))
      assert.equal(real.imported, 2)
      assert.equal(real.events, 2, '必须补同步事件')
    })
    const db = getDb(b)
    const row = db.prepare('SELECT uid, field_hlc, vv, content_hash FROM cards').get()
    const qrow = db.prepare('SELECT uid, status FROM quarantine').get()
    assert.equal(qrow.status, 'pending', '待审卡也要搬过去')
    assert.equal(qrow.uid, wp.uid)
    assert.equal(row.uid, w.uid, '搬运后 uid 必须保留')
    assert.ok(row.field_hlc && row.field_hlc !== '{}', 'field_hlc 必须保留')
    assert.ok(row.vv && row.vv !== '{}', 'vv 必须保留')
    const ev = db.prepare('SELECT uid, op FROM card_events').all()
    assert.ok(ev.some((e) => e.uid === w.uid && e.op === 'update'), '目标库应有该卡事件')
    assert.equal(digestOf(b).digest, digestOf(a).digest, '搬运后两库摘要应一致')
  } finally { await cleanup(a, b) }
})
