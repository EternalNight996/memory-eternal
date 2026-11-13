// 大批量记忆的导入与垃圾处置。守四组：
//   A. 内容哈希：归一化只做安全的空白处理，不同内容不能撞 hash
//   B. 分片导入：哈希去重 O(1)、片内不自相残杀、计数语义正确、事务回滚
//   C. 垃圾扫描：五类规则 + **必须覆盖隔离区**（enforceAudit 把新卡变 pending，
//      只扫主库会得到"一切正常"的假象）
//   D. 批量处置：默认 dryRun；真执行后候选数下降
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { contentHash, normalizeForHash } from '../lib/card-hash.js'
import { importChunk, extractCards, CHUNK_SIZE } from '../lib/import-batch.js'
import { scanJunk, pickByFilter } from '../lib/junk.js'
import { createApi } from '../lib/api.js'

function tmpVault() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'me-bulk-'))
}

/** 先关掉该库的 SQLite 连接再删目录 —— Windows 上句柄没释放会 EPERM。 */
async function cleanup(root) {
  try {
    const { closeDb } = await import('../lib/db.js')
    closeDb(root)
  } catch { /* 忽略 */ }
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
}

function withApi(root, fn) {
  const handler = createApi({ vaultDir: () => root, vaultRoots: () => [{ name: 'v', root }], getSettings: () => ({}) })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  return new Promise((resolve, reject) => {
    srv.listen(0, '127.0.0.1', async () => {
      let err = null
      try {
        await fn(`http://127.0.0.1:${srv.address().port}/memory-eternal/api`)
      } catch (e) {
        err = e // 断言失败必须传出去，否则会被 finally 吞掉变成"测试结束后才有异常"
      }
      // srv.close 是异步的：必须等它真的关完，否则还有 keep-alive 连接在活动
      await new Promise((r) => srv.close(r))
      if (err) reject(err)
      else resolve()
    })
  })
}

const body = (i) => `# 卡 ${i}\n\n这是第 ${i} 条测试正文，长度足够避免被短文本规则误判，主题 ${i % 7}，用于验证批量导入与垃圾扫描。`

// ── A. 内容哈希 ────────────────────────────────────────────
test('哈希：相同内容稳定、不同内容不撞', () => {
  assert.equal(contentHash('t', 'abc'), contentHash('t', 'abc'))
  assert.notEqual(contentHash('t', 'abc'), contentHash('t', 'abd'))
  assert.notEqual(contentHash('t1', 'abc'), contentHash('t2', 'abc'), '标题不同 hash 应不同')
})

test('哈希：只做安全的空白归一化（不许去标点/小写化）', () => {
  assert.equal(normalizeForHash('a  \r\nb'), 'a\nb', '行尾空格与 CRLF 应归一')
  assert.equal(contentHash('t', 'a\r\nb'), contentHash('t', 'a\nb'), '换行差异不该算不同卡')
  assert.notEqual(contentHash('t', 'Hello'), contentHash('t', 'hello'), '大小写是语义，不能归一')
  assert.notEqual(contentHash('t', 'a.b'), contentHash('t', 'ab'), '标点不能抹掉')
  assert.equal(contentHash('', ''), '', '全空返回空 hash（不参与去重）')
})

// ── B. 分片导入 ────────────────────────────────────────────
test('extractCards 认两种备份形状', () => {
  assert.equal(extractCards([{ a: 1 }]).length, 1, '顶层数组')
  assert.equal(extractCards({ cards: [{ a: 1 }, { b: 2 }] }).length, 2, '信封对象')
  assert.equal(extractCards({ foo: 1 }), null, '认不出返回 null')
})

test('分片导入：重复跳过、计数语义正确', async () => {
  const root = tmpVault()
  const cards = [
    { kind: 'knowledge', title: '卡 1', text: body(1) },
    { kind: 'knowledge', title: '卡 2', text: body(2) },
    { kind: 'knowledge', title: '卡 1', text: body(1) },   // 片内重复
    { kind: 'knowledge', title: '空', text: '' },          // 空正文
  ]
  const r = await importChunk(root, cards)
  assert.equal(r.imported, 2, '应导入 2 张唯一卡')
  assert.equal(r.duplicate, 1, '片内重复应被识别')
  assert.equal(r.bad, 1, '空正文算 bad')
  assert.equal(r.skipped, r.duplicate + r.bad, 'skipped = duplicate + bad')
  assert.equal(r.imported + r.skipped, cards.length, '导入+跳过 = 总数')
  await cleanup(root)
})

test('分片导入：跨片去重（第二片重复第一片的内容 → 跳过）', async () => {
  const root = tmpVault()
  const first = [{ kind: 'knowledge', title: '唯一卡', text: body(42) }]
  const second = [{ kind: 'knowledge', title: '唯一卡', text: body(42) }]
  const r1 = await importChunk(root, first)
  const r2 = await importChunk(root, second)
  assert.equal(r1.imported, 1)
  assert.equal(r2.imported, 0, '跨片应判重')
  assert.equal(r2.duplicate, 1)
  await cleanup(root)
})

test('分片导入：CHUNK_SIZE 有界，且不吞掉同一批里的不同卡', async () => {
  assert.ok(CHUNK_SIZE >= 100 && CHUNK_SIZE <= 5000, 'CHUNK_SIZE 应在合理区间，实际 ' + CHUNK_SIZE)
  const root = tmpVault()
  const cards = []
  for (let i = 0; i < 200; i++) cards.push({ kind: 'knowledge', title: `卡 ${i}`, text: body(i) })
  const r = await importChunk(root, cards)
  assert.equal(r.imported, 200, '200 张都不同，应全部导入')
  assert.equal(r.duplicate, 0)
  await cleanup(root)
})

// ── C. 垃圾扫描 ────────────────────────────────────────────
test('扫描：识别重复/过短/占位标题/陈旧/待审积压', async () => {
  const root = tmpVault()
  const db = (await import('../lib/db.js')).getDb(root)
  // 直接造数据（绕过审核闸门，测扫描规则本身）
  const insert = db.prepare(`
    INSERT INTO cards (id, path, kind, title, tags, body, summary, status, source, created_at, updated_at, content_hash)
    VALUES (?, ?, 'knowledge', ?, '[]', ?, '', 'approved', '', ?, ?, ?)
  `)
  const old = '2024-01-01 00:00:00'
  const now = new Date().toISOString()
  insert.run(1, 'a.md', '正常卡', body(1), now, now, contentHash('正常卡', body(1)))
  insert.run(2, 'b.md', '重复卡', body(2), now, now, contentHash('重复卡', body(2)))
  insert.run(3, 'b-2.md', '重复卡', body(2), now, now, contentHash('重复卡', body(2))) // 与 2 重复
  insert.run(4, 'c.md', '碎片', '短', now, now, contentHash('碎片', '短'))
  insert.run(5, 'd.md', '导入记忆', body(5), now, now, contentHash('导入记忆', body(5)))
  insert.run(6, 'e.md', '老卡', body(6), old, old, contentHash('老卡', body(6)))

  const r = scanJunk(root)
  assert.equal(r.summary.duplicate, 1, '应有 1 张重复可删')
  assert.ok(r.summary.tooShort >= 1, '应识别过短')
  assert.ok(r.summary.blankTitle >= 1, '应识别占位标题')
  assert.ok(r.summary.stale >= 1, '应识别陈旧')
  const dupC = r.candidates.find((c) => c.reason === 'duplicate')
  assert.equal(dupC.keep, 'b.md', '重复组应保留最早创建的那张')
  await cleanup(root)
})

test('扫描：**必须覆盖隔离区**（enforceAudit 会把导入卡变 pending）', async () => {
  const root = tmpVault()
  const db = (await import('../lib/db.js')).getDb(root)
  // 直接往隔离区造数据（绕过导入去重，专测"扫描是否看得见隔离区"）
  const ins = db.prepare(`
    INSERT INTO quarantine (id, path, kind, title, tags, body, summary, status, source, created_at, updated_at, quarantined_at, quarantine_reason, content_hash)
    VALUES (?, ?, 'knowledge', ?, '[]', ?, '', ?, '', ?, ?, datetime('now'), '待审', ?)
  `)
  const now = new Date().toISOString()
  ins.run(1, 'q-a.md', '待审 A', body(101), 'pending', now, now, contentHash('待审 A', body(101)))
  ins.run(2, 'q-a2.md', '待审 A', body(101), 'pending', now, now, contentHash('待审 A', body(101))) // 与 1 完全重复
  ins.run(3, 'q-short.md', '碎片', '短', 'pending', now, now, contentHash('碎片', '短'))
  ins.run(4, 'q-old.md', '老待审', body(104), 'pending', '2020-01-01 00:00:00', '2020-01-01 00:00:00', contentHash('老待审', body(104)))

  const r = scanJunk(root)
  assert.equal(r.summary.main, 0, '主库此时为空')
  assert.ok(r.summary.quarantine >= 4, '隔离区应有 4 张，实际 ' + r.summary.quarantine)
  assert.ok(r.summary.duplicate >= 1, '隔离区内部的重复也要扫出来（只扫主库会漏）')
  assert.ok(r.summary.tooShort >= 1, '隔离区的过短卡也要扫出来')
  assert.ok(r.summary.quarantineStale >= 1, '2020 年的待审卡应算积压')
  assert.ok(r.candidates.every((c) => c.store === 'quarantine' || c.store === 'cards'), '候选要标出所在表')
  await cleanup(root)
})

test('pickByFilter 按 reason 挑候选（两类不重叠）', async () => {
  const root = tmpVault()
  const db = (await import('../lib/db.js')).getDb(root)
  const ins = db.prepare(`
    INSERT INTO cards (id, path, kind, title, tags, body, summary, status, source, created_at, updated_at, content_hash)
    VALUES (?, ?, 'knowledge', ?, '[]', ?, '', 'approved', '', ?, ?, ?)
  `)
  const now = new Date().toISOString()
  ins.run(1, 'd1.md', '重复', body(201), now, now, contentHash('重复', body(201)))
  ins.run(2, 'd2.md', '重复', body(201), now, now, contentHash('重复', body(201)))
  ins.run(3, 's1.md', '碎片', '短', now, now, contentHash('碎片', '短'))

  const dups = pickByFilter(root, { reason: 'duplicate' })
  const shorts = pickByFilter(root, { reason: 'tooShort' })
  assert.ok(dups.length >= 1, '应有重复候选')
  assert.ok(shorts.length >= 1, '应有过短候选')
  assert.ok(dups.every((p) => !shorts.includes(p)), '两类不应重叠')
  await cleanup(root)
})

// ── D. 批量处置 ────────────────────────────────────────────
test('/cards/bulk 默认 dryRun，真执行后候选减少', async () => {
  const root = tmpVault()
  // 直接造两张内容相同的卡（导入路径会去重，造不出重复组）
  const db = (await import('../lib/db.js')).getDb(root)
  const ins = db.prepare(`
    INSERT INTO cards (id, path, kind, title, tags, body, summary, status, source, created_at, updated_at, content_hash)
    VALUES (?, ?, 'knowledge', ?, '[]', ?, '', 'approved', '', ?, ?, ?)
  `)
  const now = new Date().toISOString()
  ins.run(1, 'x1.md', 'X1', body(301), now, now, contentHash('X1', body(301)))
  ins.run(2, 'x1-2.md', 'X1', body(301), now, now, contentHash('X1', body(301)))

  await withApi(root, async (base) => {
    const before = await (await fetch(base + '/junk/scan')).json()
    assert.ok(before.summary.duplicate >= 1, '应扫出重复，实际 ' + JSON.stringify(before.summary))

    // 不传 dryRun → 默认 true，什么都不改
    const dry = await (await fetch(base + '/cards/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', filter: { reason: 'duplicate' } }),
    })).json()
    assert.equal(dry.dryRun, true, '默认必须是预演')
    assert.ok(dry.matched >= 1)
    const mid = await (await fetch(base + '/junk/scan')).json()
    assert.equal(mid.summary.duplicate, before.summary.duplicate, '预演不能改动数据')

    // 显式 dryRun:false 才真删
    const real = await (await fetch(base + '/cards/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', filter: { reason: 'duplicate' }, dryRun: false }),
    })).json()
    assert.ok(real.done >= 1, '应真的删掉')
    const after = await (await fetch(base + '/junk/scan')).json()
    assert.equal(after.summary.duplicate, 0, '删完后不该再有重复候选')
  })
  await cleanup(root)
})

test('/cards/bulk 拒绝非法 action', async () => {
  const root = tmpVault()
  await withApi(root, async (base) => {
    const r = await fetch(base + '/cards/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'drop-table' }),
    })
    assert.equal(r.status, 400)
  })
  await cleanup(root)
})

test('/import 现在走批量引擎（速度与正确性）', async () => {
  const root = tmpVault()
  const cards = []
  for (let i = 0; i < 300; i++) cards.push({ kind: 'knowledge', title: `批 ${i}`, text: body(i) })
  await withApi(root, async (base) => {
    const t0 = Date.now()
    const r = await (await fetch(base + '/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'memory-eternal', cards }),
    })).json()
    const ms = Date.now() - t0
    assert.equal(r.ok, true)
    assert.equal(r.imported, 300, '300 张应全部导入')
    assert.equal(r.duplicate, 0)
    assert.ok(ms < 8000, `300 张应远快于逐条比对，实际 ${ms}ms`)
  })
  await cleanup(root)
})
