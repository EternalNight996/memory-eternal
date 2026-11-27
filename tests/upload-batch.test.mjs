// 上传批次：先登记标题/类型清单，导入销账；中断可见未完成。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { ensureVault } from '../lib/vault.js'
import { getDb, closeDb } from '../lib/db.js'
import { createApi } from '../lib/api.js'

function tmpPair() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ub-'))
  const a = path.join(parent, 'a')
  const b = path.join(parent, 'b')
  return { parent, a, b }
}

test('上传批次：先登记清单，导入按条销账；未完成可见、补齐后批次 done', async () => {
  const { parent, a, b } = tmpPair()
  await ensureVault(a); await ensureVault(b)
  const handler = createApi({ vaultDir: () => a, vaultRoots: () => [{ name: 'v', root: a }], getSettings: () => ({}) })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/memory-eternal/api`
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json())
  const get = (p) => fetch(base + p).then((x) => x.json())
  try {
    const begin = await post('/vaults/upload/begin', { target: b, items: [{ title: '批次甲' }, { title: '批次乙' }] })
    assert.equal(begin.ok, true)
    assert.equal(begin.total, 2)
    // 只传第一张 → 批次未完成
    await post('/vaults/import-into', { target: b, batchId: begin.id, cards: [{ title: '批次甲', body: '甲', text: '---\ntitle: 批次甲\n---\n\n甲' }] })
    let list = await get('/vaults/upload/batches?state=pending&target=' + encodeURIComponent(b))
    assert.equal(list.batches.length, 1)
    assert.equal(list.batches[0].doneCount, 1)
    assert.equal(list.batches[0].totalCount, 2)
    assert.deepEqual(list.batches[0].remaining.map((x) => x.title), ['批次乙'])
    // 补齐第二张 → 批次 done
    await post('/vaults/import-into', { target: b, batchId: begin.id, cards: [{ title: '批次乙', body: '乙', text: '---\ntitle: 批次乙\n---\n\n乙' }] })
    list = await get('/vaults/upload/batches?target=' + encodeURIComponent(b))
    assert.equal(list.batches[0].state, 'done')
    assert.equal(list.batches[0].doneCount, 2)
    // 取消
    const begin2 = await post('/vaults/upload/begin', { target: b, items: [{ title: '取消批次' }] })
    await post('/vaults/upload/cancel', { id: begin2.id, target: b })
    const canceled = await get('/vaults/upload/batches?state=canceled&target=' + encodeURIComponent(b))
    assert.ok(canceled.batches.some((x) => x.id === begin2.id))
  } finally {
    await new Promise((r) => srv.close(r))
    try { closeDb(a); closeDb(b) } catch { /* 忽略 */ }
    fs.rmSync(parent, { recursive: true, force: true })
  }
})
test('上传批次：同名不同 hash 的两张卡都能各自销账；重复 begin 复用同一批次', async () => {
  const { parent, a, b } = tmpPair()
  await ensureVault(a); await ensureVault(b)
  const handler = createApi({ vaultDir: () => a, vaultRoots: () => [{ name: 'v', root: a }], getSettings: () => ({}) })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/memory-eternal/api`
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((x) => x.json())
  const get = (p) => fetch(base + p).then((x) => x.json())
  try {
    const items = [{ title: '重复标题', hash: 'h1' }, { title: '重复标题', hash: 'h2' }]
    const b1 = await post('/vaults/upload/begin', { target: b, items })
    const b2 = await post('/vaults/upload/begin', { target: b, items })
    assert.equal(b2.id, b1.id, '同目标同清单应复用批次')
    await post('/vaults/import-into', { target: b, batchId: b1.id, cards: [{ title: '重复标题', body: '甲', content_hash: 'h1' }, { title: '重复标题', body: '乙', content_hash: 'h2' }] })
    const list = await get('/vaults/upload/batches?target=' + encodeURIComponent(b))
    assert.equal(list.batches[0].doneCount, 2, '两张同名卡都应销账')
    assert.equal(list.batches[0].state, 'done')
    // 不传 target：聚合到同级其他库的批次（这里 a 库自身没有批次，b 库有）
    const agg = await get('/vaults/upload/batches')
    assert.ok(Array.isArray(agg.batches), '聚合接口应返回数组')
  } finally {
    await new Promise((r) => srv.close(r))
    try { closeDb(a); closeDb(b) } catch { /* 忽略 */ }
    fs.rmSync(parent, { recursive: true, force: true })
  }
})
