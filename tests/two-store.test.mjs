// 记忆核心 · 两套存储测试（v0.10 存储重构）
//
// 设计：cards（主库/正常区）只存 approved；quarantine（隔离区/异常区）存 pending/rejected/deleted。
// 这样「agent 能不能看到未审核内容」不再依赖每处 SQL 都记得写状态条件 —— 主库物理上就没有。
//
// 本文件锁定四件事：
//   1. 写入按状态落到正确的表；
//   2. 读路径（search / readCard / dedup / 导出）绝不泄漏隔离区内容；
//   3. 审核流转 = 跨表搬家，搬家不丢 id / 更新记录 / 审计日志；
//   4. 存量迁移幂等，且主库不变量恒成立（主库永不含非 approved）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ensureVault, writeCard, readCard, search, listCards, countCards, auditQueue, recycleList,
  setCardStatus, deleteCard, restoreCard, appendUpdate, dedupCheck, exportCards,
  stats, overview, mergeCards, purgeExpired,
} from '../lib/vault.js'
import { getDb, closeAllDb, checkMainStoreInvariant, migrateToQuarantine, MAIN_STATUS } from '../lib/db.js'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-two-store-'))
after(async () => {
  closeAllDb()
  try { await fs.rm(tmpRoot, { recursive: true, force: true }) } catch { /* Windows 句柄未释放时忽略 */ }
})

let n = 0
const freshRoot = async () => {
  const root = path.join(tmpRoot, `vault-${n++}`)
  await ensureVault(root)
  return root
}

// 每张卡的正文必须**互不相同**，否则会被词法去重（Jaccard bigram，阈值 0.62）拦成 duplicate。
// 注意：只换几个字不够 —— 相同模板的公共 bigram 就能把相似度顶到 0.65。这里给每张卡一段
// 200 字随机正文，bigram 几乎不重叠，保证测的是「存储隔离」而不是「去重」。
let cardSeq = 0
const CJK_START = 0x4e00
const CJK_RANGE = 0x20bf // 到 0x6ebf，避开生僻/代理区
const randCJK = (len) => Array.from({ length: len }, () => String.fromCharCode(CJK_START + Math.floor(Math.random() * CJK_RANGE))).join('')
// 检索用的「唯一标记」必须**没有公共前缀/后缀**：search 按 CJK bigram 计分，
// 两个 marker 共享「唯一标记」这种前缀就会互相假命中（实测踩过）。
const randMark = () => 'MK' + Math.random().toString(36).slice(2, 12)
const body = (tag, mark = randMark()) => `# ${tag}-${++cardSeq}\n\n${mark}。${randCJK(200)}`

/** 直接问数据库：某张卡现在住在哪张表。 */
const storeOf = (root, rel) => {
  const db = getDb(root)
  if (db.prepare('SELECT 1 FROM cards WHERE path = ?').get(rel)) return 'main'
  if (db.prepare('SELECT 1 FROM quarantine WHERE path = ?').get(rel)) return 'quarantine'
  return '(不存在)'
}

// -- 1. 写入路由 -------------------------------------------------------------

test('写入按状态落表：approved → 主库，pending → 隔离区', async () => {
  const root = await freshRoot()
  const ok = await writeCard(root, { kind: 'knowledge', title: '已审核卡', body: body('已审核'), status: 'approved' })
  const wait = await writeCard(root, { kind: 'knowledge', title: '待审卡', body: body('待审'), status: 'pending' })
  assert.equal(storeOf(root, ok.path), 'main')
  assert.equal(storeOf(root, wait.path), 'quarantine')
  assert.equal(checkMainStoreInvariant(root).ok, true, '主库不变量应成立')
})

test('隔离区不发号重复 path：主库已有同名卡时，隔离区的卡另取 -2', async () => {
  const root = await freshRoot()
  const a = await writeCard(root, { kind: 'knowledge', title: '同名卡', body: body('A'), status: 'approved' })
  const b = await writeCard(root, { kind: 'knowledge', title: '同名卡', body: body('B'), status: 'pending' })
  assert.notEqual(a.path, b.path, '两张表共享 path 命名空间，必须避让')
  assert.ok(b.path.includes('-2'), `期望 -2 后缀，实际 ${b.path}`)
})

// -- 2. 读路径隔离 -----------------------------------------------------------

test('search 只读主库：隔离区里的内容一个都召回不到', async () => {
  const root = await freshRoot()
  const markMain = randMark(), markPending = randMark(), markRejected = randMark(), markDeleted = randMark()
  await writeCard(root, { kind: 'knowledge', title: '可召回卡', body: body('可召回卡', markMain), status: 'approved' })
  await writeCard(root, { kind: 'knowledge', title: '待审卡', body: body('待审卡', markPending), status: 'pending' })
  const rejected = await writeCard(root, { kind: 'knowledge', title: '驳回卡', body: body('驳回卡', markRejected), status: 'pending' })
  await setCardStatus(root, rejected.path, 'rejected')
  const deletedPath = (await writeCard(root, { kind: 'knowledge', title: '删除卡', body: body('删除卡', markDeleted), status: 'approved' })).path
  await deleteCard(root, deletedPath)

  for (const [label, marker] of [['待审', markPending], ['驳回', markRejected], ['回收站', markDeleted]]) {
    assert.equal((await search(root, marker)).length, 0, `${label}内容不该被召回`)
  }
  assert.equal((await search(root, markMain)).length, 1, '主库内容必须能召回')
})
test('readCard 默认拒绝隔离区内容，且错误码区分「不存在」与「未审核」', async () => {
  const root = await freshRoot()
  const pending = await writeCard(root, { kind: 'knowledge', title: '待审卡', body: body('待审'), status: 'pending' })
  await assert.rejects(() => readCard(root, pending.path), (e) => e.code === 'CARD_NOT_APPROVED')
  await assert.rejects(() => readCard(root, 'nothing/here.md'), (e) => e.code === 'CARD_NOT_FOUND')
  const preview = await readCard(root, pending.path, { allowUnapproved: true })
  assert.equal(preview.store, 'quarantine')
  assert.equal(preview.status, 'pending')
  assert.ok(preview.text.includes('待审'))
})

test('去重只在主库内进行：隔离区里的待审卡不会吸走新知识', async () => {
  const root = await freshRoot()
  const junkBody = body('垃圾待审内容')
  const junk = await writeCard(root, { kind: 'content', title: '垃圾待审卡', body: junkBody, status: 'pending' })
  assert.equal(junk.ok, true)
  assert.equal(storeOf(root, junk.path), 'quarantine')
  // 与待审卡几乎同文的新卡：不该被判重复，更不该被追加进那张待审卡
  const nearDup = junkBody + '补充：这是主库里的正规内容。'
  const fresh = await writeCard(root, { kind: 'knowledge', title: '新知识卡', body: nearDup, status: 'approved' })
  assert.equal(fresh.ok, true, '新卡必须能正常写入（旧实现会把内容追加进待审卡）')
  assert.equal(storeOf(root, fresh.path), 'main')
  assert.equal((await dedupCheck(root, nearDup)).path, fresh.path, '去重池里只应有主库卡')
  const preview = await readCard(root, junk.path, { allowUnapproved: true })
  assert.ok(!preview.text.includes('补充：这是主库里的正规内容'), '待审卡不该被追加内容')
})

test('导出含隔离区内容，但带 status / store 标记', async () => {
  const root = await freshRoot()
  await writeCard(root, { kind: 'knowledge', title: '主库卡', body: body('主库'), status: 'approved' })
  await writeCard(root, { kind: 'knowledge', title: '待审卡', body: body('待审'), status: 'pending' })
  const out = await exportCards(root)
  assert.equal(out.length, 2, '用户备份不该只拿到主库')
  const q = out.find((c) => c.store === 'quarantine')
  assert.ok(q && q.status === 'pending')
})

// -- 3. 审核流转 = 跨表搬家 --------------------------------------------------

test('审核通过：pending 从隔离区搬进主库，更新记录跟着走', async () => {
  const root = await freshRoot()
  const card = await writeCard(root, { kind: 'knowledge', title: '待审搬家主库', body: body('待审搬家主库'), status: 'pending' })
  const idBefore = getDb(root).prepare('SELECT id FROM quarantine WHERE path = ?').get(card.path).id
  await appendUpdate(root, card.path, '审核前追加的一条更新记录')

  await setCardStatus(root, card.path, MAIN_STATUS, { changedBy: 'user', reason: '看起来有用' })
  assert.equal(storeOf(root, card.path), 'main')
  // 两张表 id 由 card_sequence 单一发号器分配（全库唯一），搬家时重新领号，
  // 但 card_updates 会按新 id 改绑 → 用户视角「更新记录还在」。
  const idAfter = getDb(root).prepare('SELECT id FROM cards WHERE path = ?').get(card.path).id
  assert.notEqual(idAfter, idBefore, '搬家应领新号（否则会撞已占用的 id）')
  const rebinds = getDb(root).prepare('SELECT COUNT(*) n FROM card_updates WHERE card_id = ?').get(idAfter).n
  assert.equal(rebinds, 1, '更新记录必须改绑到新 id')

  const read = await readCard(root, card.path)
  assert.ok(read.text.includes('更新记录'), '搬家后更新记录必须还在')
  assert.ok(read.text.includes('审核前追加的一条更新记录'))
  const log = getDb(root).prepare('SELECT * FROM audit_log WHERE card_path = ? ORDER BY id DESC LIMIT 1').get(card.path)
  assert.equal(log.new_status, 'approved')
  assert.equal(log.changed_by, 'user')
})

test('驳回：主库卡被搬进隔离区，随后补审可通过', async () => {
  const root = await freshRoot()
  const card = await writeCard(root, { kind: 'knowledge', title: '先通过后驳回', body: body('流转'), status: 'approved' })
  await setCardStatus(root, card.path, 'rejected', { changedBy: 'user', reason: '内容不对' })
  assert.equal(storeOf(root, card.path), 'quarantine')
  assert.equal((await search(root, '流转')).length, 0, '驳回后不该再被召回')
  const q = await auditQueue(root)
  assert.ok(q.rejected.some((c) => c.path === card.path))
  await setCardStatus(root, card.path, MAIN_STATUS, { changedBy: 'user' })
  assert.equal(storeOf(root, card.path), 'main')
})

test('软删 → 回收站 → 恢复：全程跨表搬迁且保留内容', async () => {
  const root = await freshRoot()
  const card = await writeCard(root, { kind: 'knowledge', title: '回收站往返', body: body('往返'), status: 'approved' })
  await deleteCard(root, card.path)
  assert.equal(storeOf(root, card.path), 'quarantine')
  assert.ok((await recycleList(root)).some((c) => c.path === card.path))
  await restoreCard(root, card.path)
  assert.equal(storeOf(root, card.path), 'main')
  assert.ok((await readCard(root, card.path)).text.includes('往返'))
  assert.equal((await search(root, '往返')).length, 1)
})

test('永久删除：两张表都清干净，含更新记录', async () => {
  const root = await freshRoot()
  const card = await writeCard(root, { kind: 'knowledge', title: '永久删除', body: body('删除'), status: 'pending' })
  await appendUpdate(root, card.path, '一条更新记录')
  const id = getDb(root).prepare('SELECT id FROM quarantine WHERE path = ?').get(card.path).id
  await deleteCard(root, card.path, { permanent: true })
  assert.equal(storeOf(root, card.path), '(不存在)')
  assert.equal(getDb(root).prepare('SELECT COUNT(*) n FROM card_updates WHERE card_id = ?').get(id).n, 0)
})

test('purgeExpired 只清隔离区里过期的回收卡', async () => {
  const root = await freshRoot()
  const keep = await writeCard(root, { kind: 'knowledge', title: '保留的主库卡', body: body('保留'), status: 'approved' })
  const old = await writeCard(root, { kind: 'knowledge', title: '过期回收卡', body: body('过期'), status: 'pending' })
  await deleteCard(root, old.path)
  // 手动把 deleted_at 改到 60 天前，模拟超期
  getDb(root).prepare('UPDATE quarantine SET deleted_at = ? WHERE path = ?').run(new Date(Date.now() - 60 * 86400000).toISOString(), old.path)
  const r = await purgeExpired(root, 30)
  assert.equal(r.purged, 1)
  assert.equal(storeOf(root, old.path), '(不存在)')
  assert.equal(storeOf(root, keep.path), 'main', '主库卡不受回收清理影响')
})

// -- 4. 迁移与不变量 ---------------------------------------------------------

test('迁移：存量非 approved 行被搬进隔离区，approved 留在主库，且幂等', async () => {
  const root = path.join(tmpRoot, 'vault-legacy')
  await ensureVault(root)
  const db = getDb(root)
  // 手工灌一条 old-style 主库待审行（模拟 v0.9 老库）
  const now = new Date().toISOString()
  db.prepare(`INSERT INTO cards (path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('03-Knowledge/老库待审.md', 'knowledge', '老库待审卡', '[]', body('老库待审'), '', 'pending', 'legacy', 'legacy', 'info', '', now, now, null)
  db.prepare(`INSERT INTO cards (path, kind, title, tags, body, summary, status, source, submitted_by, severity, reason, created_at, updated_at, deleted_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('03-Knowledge/老库驳回.md', 'knowledge', '老库驳回卡', '[]', body('老库驳回'), '', 'rejected', 'legacy', 'legacy', 'info', '', now, now, null)

  const moved = migrateToQuarantine(db)
  assert.equal(moved, 2)
  assert.equal(storeOf(root, '03-Knowledge/老库待审.md'), 'quarantine')
  assert.equal(storeOf(root, '03-Knowledge/老库驳回.md'), 'quarantine')
  assert.equal(migrateToQuarantine(db), 0, '再跑一遍应该是 0 条（幂等）')
  assert.equal(checkMainStoreInvariant(root).ok, true)
  // 迁移不删内容：隔离区里 body 还在
  const preview = await readCard(root, '03-Knowledge/老库待审.md', { allowUnapproved: true })
  assert.ok(preview.text.includes('老库待审'))
})

test('不变量：主库永不含非 approved（搬运/合并/删除都不破）', async () => {
  const root = await freshRoot()
  const a = await writeCard(root, { kind: 'knowledge', title: '卡甲', body: body('甲'), status: 'approved' })
  const b = await writeCard(root, { kind: 'knowledge', title: '卡乙', body: body('乙'), status: 'approved' })
  await writeCard(root, { kind: 'knowledge', title: '卡丙待审', body: body('丙'), status: 'pending' })
  await setCardStatus(root, b.path, 'rejected')
  await deleteCard(root, a.path)
  // 合并产出的新卡默认 pending → 必须落隔离区
  const c = await writeCard(root, { kind: 'knowledge', title: '卡丁', body: body('丁'), status: 'approved' })
  await mergeCards(root, [c.path, (await writeCard(root, { kind: 'knowledge', title: '卡戊', body: body('戊'), status: 'approved' })).path])
  const inv = checkMainStoreInvariant(root)
  assert.equal(inv.ok, true, `主库出现非法状态：${JSON.stringify(inv.violations)}`)
})

// -- 5. 统计与列表 ----------------------------------------------------------

test('listCards / countCards：approved 走主库，pending 走隔离区，all 合并两张表', async () => {
  const root = await freshRoot()
  await writeCard(root, { kind: 'knowledge', title: '主库一', body: body('主库一'), status: 'approved' })
  await writeCard(root, { kind: 'project', title: '待审一', body: body('待审一'), status: 'pending' })
  assert.equal((await listCards(root)).length, 1, '默认只列主库')
  assert.equal((await listCards(root, { status: ['pending'] })).length, 1)
  assert.equal((await listCards(root, { status: ['approved', 'pending', 'rejected'] })).length, 2)
  assert.equal(await countCards(root), 1)
  assert.equal(await countCards(root, { status: ['pending'] }), 1)
  assert.equal(await countCards(root, { status: ['approved', 'pending', 'rejected'] }), 2)
})

test('overview / stats：主库与隔离区分开计数（审核中心徽标数据源）', async () => {
  const root = await freshRoot()
  await writeCard(root, { kind: 'knowledge', title: '主库卡', body: body('主库'), status: 'approved' })
  const p = await writeCard(root, { kind: 'knowledge', title: '待审卡', body: body('待审'), status: 'pending' })
  const r = await writeCard(root, { kind: 'knowledge', title: '驳回卡', body: body('驳回'), status: 'pending' })
  await setCardStatus(root, r.path, 'rejected')
  const d = await writeCard(root, { kind: 'knowledge', title: '回收卡', body: body('回收'), status: 'approved' })
  await deleteCard(root, d.path)

  const ov = await overview(root)
  assert.equal(ov.total, 1, 'overview.total 是主库卡数')
  assert.deepEqual(ov.status, { approved: 1 })
  assert.equal(ov.quarantine.pending, 1)
  assert.equal(ov.quarantine.rejected, 1)
  assert.equal(ov.quarantine.deleted, 1)
  assert.equal(ov.quarantine.total, 3)

  const st = await stats(root)
  assert.equal(st.total, 1)
  assert.equal(st.quarantine.pending, 1)
  assert.ok(p.path && d.path)
})
