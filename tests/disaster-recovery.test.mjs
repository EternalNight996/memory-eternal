// 端到端灾备演练（与 db-restore 的区别：那边测"函数行为"，这里测"真灾难现场"）：
// 建卡 → 备份 → 备份后又写新卡 → 把主库写成垃圾 → 走 CLI 的 dry-run/真还原 → 数据回来、可写、留证齐全。
// 这条链路是「定期备份 + 容灾」的验收标准：备份文件必须在真坏掉的时候真的能救回来。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function setup() {
  const { writeCard, setCardStatus } = await import('../lib/vault.js')
  const dbf = await import('../lib/db.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-drill-'))
  for (let i = 0; i < 4; i++) {
    const r = await writeCard(root, { kind: 'knowledge', title: '灾备演练 ' + i, tags: ['drill'], body: '# 演练\n- ' + i, status: 'pending', submittedBy: 'drill' }, { dedup: false })
    await setCardStatus(root, r.path, 'approved')
  }
  dbf.closeAllDb()
  const b = await dbf.backupDb(root)
  dbf.closeAllDb()
  return { root, backups: b, dbf }
}

const countCards = (dbf, root) => {
  const db = dbf.getDb(root)
  const n = Number(db.prepare('SELECT count(*) AS n FROM cards').get().n)
  dbf.closeAllDb()
  return n
}

test('真灾难：主库被写成垃圾 → CLI 还原 → 卡片回来、可写、现场留证', async () => {
  const { root, backups, dbf } = await setup()
  const cli = path.join(REPO, 'bin', 'dsh-memory.mjs')
  try {
    assert.equal(backups.ok, true, backups.error)
    assert.equal(backups.cards, 4)
    // 备份之后又写 2 张（这部分按 RPO 语义会丢，属于预期）
    const { writeCard, setCardStatus } = await import('../lib/vault.js')
    for (let i = 0; i < 2; i++) {
      const r = await writeCard(root, { kind: 'knowledge', title: '备份后 ' + i, tags: ['drill'], body: '# 后\n- ' + i, status: 'pending', submittedBy: 'drill' }, { dedup: false })
      await setCardStatus(root, r.path, 'approved')
    }
    dbf.closeAllDb()
    assert.equal(countCards(dbf, root), 6)

    // 灾难现场
    const dbFile = path.join(root, 'memory-eternal.db')
    fs.writeFileSync(dbFile, 'NOT A SQLITE FILE')
    dbf.closeAllDb()
    assert.equal(dbf.probeDbFile(dbFile).ok, false)

    // ① 演练模式：一个文件都不许动
    const before = fs.readFileSync(dbFile).toString('base64')
    let dry = ''
    try { dry = execFileSync(process.execPath, [cli, 'doctor', '--restore', 'latest', '--vault', root], { encoding: 'utf8' }) } catch (e) { dry = String(e.stdout || '') + String(e.stderr || '') }
    assert.match(dry, /演练/, '不带 --yes 必须只演练：' + dry.slice(0, 200))
    assert.equal(fs.readFileSync(dbFile).toString('base64'), before, '演练不许改库文件')
    assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes('.corrupt-')), [], '演练不许产生留证')

    // ② 真还原
    let out = ''
    try { out = execFileSync(process.execPath, [cli, 'doctor', '--restore', 'latest', '--yes', '--vault', root], { encoding: 'utf8' }) } catch (e) { out = String(e.stdout || '') + String(e.stderr || '') }
    assert.match(out, /已用备份重建/, '还原应当成功：' + out.slice(0, 400))

    const probe = dbf.probeDbFile(dbFile)
    dbf.closeAllDb()
    assert.equal(probe.ok, true)
    assert.equal(probe.cards, 4, '回到备份时点的 4 张（备份后的 2 张按 RPO 预期丢失）')
    const aside = fs.readdirSync(root).filter((f) => f.includes('.corrupt-'))
    assert.ok(aside.length >= 1, '坏库必须改名留证')
    assert.equal(countCards(dbf, root), 4)

    // ③ 还原后还能继续写
    const r2 = await writeCard(root, { kind: 'knowledge', title: '还原后新卡', tags: ['drill'], body: '# 还原后', status: 'pending', submittedBy: 'drill' }, { dedup: false })
    assert.equal(r2.ok, true)
    await setCardStatus(root, r2.path, 'approved')
    dbf.closeAllDb()
    assert.equal(countCards(dbf, root), 5)
  } finally {
    try { dbf.closeAllDb() } catch {}
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  }
})

test('隔离 vault 的渲染不会被无关的常驻看门狗挡住（看门狗只对同一 vault 生效）', async () => {
  const { root, dbf } = await setup()
  const cli = path.join(REPO, 'bin', 'dsh-memory.mjs')
  try {
    const dbFile = path.join(root, 'memory-eternal.db')
    fs.writeFileSync(dbFile, 'NOT A SQLITE FILE')
    dbf.closeAllDb()
    // 不带 --force：若实现按「有活着的看门狗」一刀切就会失败
    let out = ''
    try { out = execFileSync(process.execPath, [cli, 'doctor', '--restore', 'latest', '--yes', '--vault', root], { encoding: 'utf8' }) } catch (e) { out = String(e.stdout || '') + String(e.stderr || '') }
    assert.match(out, /已用备份重建/, '别的 vault 的看门狗不该阻断本次还原：' + out.slice(0, 400))
  } finally {
    try { dbf.closeAllDb() } catch {}
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) } catch {}
  }
})
