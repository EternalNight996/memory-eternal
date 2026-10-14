// issue #31 的现实出路：**WAL 头一旦损坏，代码修不了数据，只能用备份重建**。
// 这里守住恢复流程的安全边界：不删任何东西（现场改名留证）、先校验备份、当前库完好时要显式 --force、
// 恢复后复核（写探针 + 卡片数）。宁可拒绝，也不破坏现场。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeCard, setCardStatus, listCards } from '../lib/vault.js'
import { backupDb, restoreFromBackup, probeDbFile, closeDb, getDb, checkDbHealth } from '../lib/db.js'

const body = (n) => '# 发布流程备忘\n' + ('- 步骤 ' + n + '：先 build 再 publish，最后打 tag 并核对两端 tag 指向。\n').repeat(5)

async function makeVaultWithBackup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-restore-'))
  const titles = ['发布流程备忘 A', '发布流程备忘 B']
  for (let i = 0; i < titles.length; i++) {
    const r = await writeCard(root, { kind: 'knowledge', title: titles[i], tags: [], body: body(i), status: 'pending', submittedBy: 'test' }, { dedup: false })
    await setCardStatus(root, r.path, 'approved')
  }
  const b = await backupDb(root)
  return { root, backup: b.path, cards: 2, cleanup: () => { try { closeDb(root) } catch {} try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) } catch {} } }
}

test('从备份重建：坏库被留证、备份的卡片回来了、写探针恢复 OK', async () => {
  const v = await makeVaultWithBackup()
  try {
    assert.equal(probeDbFile(v.backup).ok, true, '备份本身要能通过 quick_check')
    assert.equal(probeDbFile(v.backup).cards, 2)
    // 把现场弄坏（模拟 WAL 头损坏 / 文件被写坏）：先关连接，再写垃圾
    closeDb(v.root)
    fs.writeFileSync(path.join(v.root, 'memory-eternal.db'), 'this is not a sqlite database')
    assert.equal(probeDbFile(path.join(v.root, 'memory-eternal.db')).ok, false, '坏库应当被当场探测判为不可用')

    const out = await restoreFromBackup(v.root, { from: 'latest' })
    assert.equal(out.ok, true, '坏库场景应当直接允许恢复（无需 --force）：' + (out.error || ''))
    assert.equal(out.cards, 2, '恢复后卡片数与备份一致')
    assert.equal(out.health.writable, true, '恢复后写探针必须通过')
    assert.ok(out.movedAside.some((f) => f.includes('.corrupt-')), '原现场必须改名留证（不能删）')
    for (const f of out.movedAside) assert.ok(fs.existsSync(f), '留证文件要真的存在：' + f)
    assert.equal((await listCards(v.root, { status: ['approved'] })).length, 2, '卡片真的回来了')
  } finally { v.cleanup() }
})

test('当前库完好时必须显式 force（防手滑），dryRun 一个文件都不动', async () => {
  const v = await makeVaultWithBackup()
  try {
    const dbFile = path.join(v.root, 'memory-eternal.db')
    const before = fs.readFileSync(dbFile).toString('base64').slice(0, 200)
    const refused = await restoreFromBackup(v.root, { from: 'latest' })
    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'DB_HEALTHY')
    assert.match(refused.error, /--force/)
    const dry = await restoreFromBackup(v.root, { from: 'latest', dryRun: true, force: true })
    assert.equal(dry.ok, true)
    assert.equal(dry.dryRun, true)
    assert.equal(fs.readFileSync(dbFile).toString('base64').slice(0, 200), before, '演练不许改动库文件')
    assert.deepEqual(fs.readdirSync(v.root).filter((f) => f.includes('.corrupt-')), [], '演练不许产生留证文件')
  } finally { v.cleanup() }
})

test('拒绝危险的恢复来源：不存在的备份 / 不是 SQLite 的文件 / 库自己', async () => {
  const v = await makeVaultWithBackup()
  try {
    const missing = await restoreFromBackup(v.root, { from: 'no-such-backup.db' })
    assert.equal(missing.ok, false)
    assert.match(missing.error, /不存在/)
    const junk = path.join(v.root, 'backups', 'junk.db')
    fs.writeFileSync(junk, 'nope')
    const bad = await restoreFromBackup(v.root, { from: 'junk.db' })
    assert.equal(bad.ok, false)
    assert.match(bad.error, /备份不可用/)
    const self = await restoreFromBackup(v.root, { from: path.join(v.root, 'memory-eternal.db') })
    assert.equal(self.ok, false)
    assert.match(self.error, /不能是正在使用的库本身/)
    const none = await restoreFromBackup(v.root, {})
    assert.equal(none.ok, false)
  } finally { v.cleanup() }
})

test('恢复后「打开即体检」的结论会更新（不是旧缓存）', async () => {
  const v = await makeVaultWithBackup()
  try {
    closeDb(v.root)
    fs.writeFileSync(path.join(v.root, 'memory-eternal.db'), 'broken')
    const out = await restoreFromBackup(v.root, { from: 'latest' })
    assert.equal(out.ok, true)
    const health = checkDbHealth(getDb(v.root))
    assert.equal(health.writable, true)
    assert.equal(health.corrupt, false)
  } finally { v.cleanup() }
})
