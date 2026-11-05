// 记忆核心 · API 层集成测试：直接调用 handleApi 逻辑对应的 vault 函数，
// 覆盖 client 会用到的 overview / cards / search / graph / card 数据形状。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureVault, writeCard, listCards, readCard, search, graph, overview, stats, optimizeCandidates, graphAll, searchAll, updateCardContent, reviseCard, setCardStatus, auditQueue } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-api-'))
const root = path.join(tmpRoot, 'vault')
after(async () => {
  closeAllDb()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('API data shapes: overview', async () => {
  await ensureVault(root)
  await writeCard(root, { kind: 'knowledge', title: 'A', tags: ['t1'], body: '内容A足够长以便写入知识库文件。这是关于知识卡片的内容，用于验证数据形状。', status: 'approved' })
  await writeCard(root, { kind: 'project', title: 'B', tags: ['t1'], body: '项目B的进展与里程碑规划，包括团队分工和交付时间表，用于验证项目类卡片的写入。', status: 'approved' })
  const ov = await overview(root)
  assert.equal(ov.total, 2)
  assert.equal(ov.byKind.knowledge, 1)
  assert.equal(ov.byKind.project, 1)
  assert.equal(ov.roots.knowledge, '03-Knowledge/')
  assert.equal(ov.roots.project, '02-Projects/')
})

test('API data shapes: cards list with filter', async () => {
  const cards = await listCards(root)
  assert.equal(cards.length, 2)
  const knowledgeOnly = cards.filter((c) => c.kind === 'knowledge')
  assert.equal(knowledgeOnly.length, 1)
  for (const c of cards) {
    assert.equal(typeof c.title, 'string')
    assert.ok(Array.isArray(c.tags))
    assert.equal(typeof c.path, 'string')
    assert.equal(typeof c.mtime, 'number')
  }
})

test('API data shapes: card text', async () => {
  const cards = await listCards(root)
  const text = (await readCard(root, cards[0].path)).text
  assert.ok(text.includes('---'))
  assert.ok(text.includes('#'))
})

test('API data shapes: search hits carry score', async () => {
  const hits = await search(root, '内容A')
  assert.ok(hits.length >= 1)
  assert.ok(hits[0].score >= 1)
})

test('API data shapes: graph nodes+edges', async () => {
  const g = await graph(root)
  assert.equal(g.nodes.length, 2)
  // 共享标签 t1 → 应有 tag 边
  const tagEdge = g.edges.find((e) => e.type.startsWith('tag:'))
  assert.ok(tagEdge)
  assert.ok(g.nodes.every((n) => typeof n.id === 'string' && typeof n.title === 'string'))
})

test('API data shapes: stats (overview + todayCards + byKind)', async () => {
  const s = await stats(root)
  assert.equal(s.total, 2)
  assert.equal(s.byKind.knowledge, 1)
  assert.equal(s.byKind.project, 1)
  assert.ok(Array.isArray(s.todayCards))
  assert.equal(s.todayCards.length, 2)
  assert.equal(typeof s.week, 'number')
  assert.equal(typeof s.tags, 'number')
})

test('API data shapes: optimizeCandidates returns merge/stale arrays', async () => {
  const o = await optimizeCandidates(root)
  assert.ok(Array.isArray(o.merge))
  assert.ok(Array.isArray(o.stale))
})

test('API data shapes: cross-vault graphAll + searchAll aggregate', async () => {
  const aRoot = path.join(tmpRoot, 'a')
  const bRoot = path.join(tmpRoot, 'b')
  await ensureVault(aRoot)
  await ensureVault(bRoot)
  await writeCard(aRoot, { kind: 'knowledge', title: 'A', tags: ['t1'], body: '跨库聚合内容足够长便于写入知识库文件以验证聚合。', status: 'approved' }, { dedup: false })
  await writeCard(bRoot, { kind: 'knowledge', title: 'B', tags: ['t1'], body: '跨库聚合另一张内容足够长便于写入知识库文件以验证聚合。', status: 'approved' }, { dedup: false })
  const roots = [{ name: '', root: aRoot }, { name: 'v2', root: bRoot }]
  const g = await graphAll(roots)
  assert.ok(g.nodes.length >= 2)
  // 命名 profile 的节点 id 前缀 'name::' 防冲突；当前(active)根保持原 id
  assert.ok(g.nodes.some((n) => n.id.startsWith('v2::')), '命名 profile 节点应带 v2:: 前缀')
  const hits = await searchAll(roots, '跨库聚合', { limit: 10 })
  assert.ok(hits.length >= 2)
})

test('updateCardContent: 人工编辑只改标题/标签/正文，不动状态', async () => {
  const cards = await listCards(root)
  const target = cards.find((c) => c.title === 'A')
  assert.ok(target, '应有标题为 A 的卡片')
  const before = await readCard(root, target.path)
  const r = await updateCardContent(root, target.path, { title: 'A（已编辑）', tags: ['t1', 'edited'], body: '# 新正文\n\n人工编辑后的内容。' })
  assert.equal(r.ok, true)
  const after = await readCard(root, target.path)
  assert.match(after.text, /title: A（已编辑）/, '标题应被改写')
  assert.match(after.text, /edited/, '标签应被替换')
  assert.ok(after.text.includes('人工编辑后的内容。'), '正文应被替换')
  assert.equal(after.status, before.status, '手动编辑不得改变审核状态')
  assert.notEqual(after.text, before.text)
})

test('reviseCard: 提交修改 → 待审副本带原卡信息，原卡一个字都不变', async () => {
  const cards = await listCards(root)
  const target = cards.find((c) => c.title === 'A（已编辑）')
  assert.ok(target, '需要前一个用例留下的 A（已编辑）')
  const before = await readCard(root, target.path)
  const r = await reviseCard(root, { target: target.path, title: 'A（审核后改名）', body: '# 审核后的正文\n\n只有人工批准才生效。', reason: '内容过期', submittedBy: 'agent-test' })
  assert.equal(r.ok, true)
  assert.notEqual(r.path, target.path)
  assert.equal(r.reused, false)
  const queue = await auditQueue(root)
  const pend = queue.pending.find((c) => c.path === r.path)
  assert.ok(pend, '副本应进入待审队列')
  assert.equal(pend.revision.targetPath, target.path)
  assert.equal(pend.revision.targetTitle, target.title)
  const still = await readCard(root, target.path)
  assert.equal(still.text, before.text, '未批准前原卡不许变')
})

test('reviseCard: 同一张卡重复提交 → 就地更新待审副本，不堆重复', async () => {
  const cards = await listCards(root)
  const target = cards.find((c) => c.title === 'A（已编辑）')
  const r = await reviseCard(root, { target: target.path, body: '# 第二次修改\n\n内容再更新一版。', submittedBy: 'agent-test' })
  assert.equal(r.reused, true)
  const queue = await auditQueue(root)
  const revs = queue.pending.filter((c) => c.revision && c.revision.targetPath === target.path)
  assert.equal(revs.length, 1, '同一原卡只应有一条待审修改')
})

test('reviseCard: 批准 → 覆盖原卡、副本消失、留下更新记录', async () => {
  const cards = await listCards(root)
  const target = cards.find((c) => c.title === 'A（已编辑）')
  const queue = await auditQueue(root)
  const rev = queue.pending.find((c) => c.revision && c.revision.targetPath === target.path)
  assert.ok(rev)
  const out = await setCardStatus(root, rev.path, 'approved')
  assert.equal(out.applied, true)
  assert.equal(out.path, target.path)
  const after = await readCard(root, target.path)
  assert.match(after.text, /title: A（审核后改名）/, '第二次提交沿用了副本标题')
  assert.ok(after.text.includes('第二次修改'), '正文应被副本覆盖')
  assert.ok(after.text.includes('经审核修改'), '应留下更新记录')
  assert.equal(after.status, 'approved', '状态仍是已通过')
  assert.equal(after.path, target.path, '身份（path）不变')
  const queue2 = await auditQueue(root)
  assert.equal(queue2.pending.some((c) => c.path === rev.path), false, '副本应用后应消失')
  assert.equal((await listCards(root)).some((c) => c.path === rev.path), false)
})

test('reviseCard: 驳回 → 原卡不变，副本留在隔离区', async () => {
  const cards = await listCards(root)
  const target = cards.find((c) => c.title === 'A（审核后改名）')
  const before = await readCard(root, target.path)
  const r = await reviseCard(root, { target: target.path, body: '# 不该生效的修改', submittedBy: 'agent-test' })
  await setCardStatus(root, r.path, 'rejected', { changedBy: 'user', reason: '内容不对' })
  const after = await readCard(root, target.path)
  assert.equal(after.text, before.text, '驳回后原卡不许变')
  const queue = await auditQueue(root)
  assert.ok(queue.rejected.some((c) => c.path === r.path), '副本应留在已驳回队列')
})

test('reviseCard: 只能修改已审核通过的卡片', async () => {
  const w = await writeCard(root, { kind: 'knowledge', title: '待审卡', tags: ['x'], body: '这是待审核的内容，不允许被 agent 直接改成修改副本。', status: 'pending', submittedBy: 'agent-test' }, { dedup: false })
  await assert.rejects(() => reviseCard(root, { target: w.path, body: '改一下' }), /只能修改已审核通过的卡片/)
})
