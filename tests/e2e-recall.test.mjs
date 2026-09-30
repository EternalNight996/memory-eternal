// 记忆核心 · 端到端「记忆三步骤」验证（写入 → 新会话召回 → 实际使用）
//
// 这是官方文档「记忆三步骤验证」的代码化：把文档里的手工步骤变成可重复运行的断言，
// 覆盖写入审批、召回命中、未审核/驳回/软删隔离、跨库聚合，以及去重的状态边界。
//
// 运行方式（两种等价）：
//   node tests/e2e-recall.test.mjs
//   node --test tests/e2e-recall.test.mjs
//
// 本文件只读产品代码、不修改 lib/**：所有 vault 都建在 os.tmpdir() 下，绝不碰 ~/.dsh/memory-vault。
//
// ── 写作时需要知道的实现约定（已逐条核对代码，别再凭想象写）──────────────────
// 1) lib/db.js enforceAudit()：config 表**没有** auditMode 记录时返回 fallback，即调用方
//    传入的 status 原样生效。所以空库里 writeCard({status:'approved'}) 就是 approved，
//    不需要（也不应该）用 setCardStatus 去「补批准」。下面每个用例都显式断言落库状态。
// 2) lib/vault.js readCard() 返回**对象** { path, status, text }（不再是字符串），
//    且默认只放行 approved：读 pending/rejected/deleted 会抛 code='CARD_NOT_APPROVED'。
//    lib/api.js 用 { allowUnapproved: true } 给审核中心/回收站预览开洞。
// 3) lib/vault.js dedupCheck() 只比对 status='approved' 的卡（P0 修复）：未审核卡既不参与
//    去重、也不会成为 appendUpdate 的目标。下面的「去重状态边界」用例固化这条语义。
// 4) 去重是**字符 bigram**（Jaccard 0.62）：唯一标记务必用「无分隔符的十六进制/字母数字」，
//    别用带 `-` 的 UUID 字样 —— `aaa-b` 与 `aaa-c` 会共享 bigram，造成假命中（本文件踩过）。
//
// 唯一标记统一由 unique(tag) 生成（时间戳 + 随机十六进制），跨 vault 的标记必然不同。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {
  ensureVault, writeCard, setCardStatus, deleteCard, search, listCards, readCard, searchAll,
} from '../lib/vault.js'
import { runStandaloneCapture } from '../lib/capture-run.js'
import { closeAllDb } from '../lib/db.js'

// 测试级临时根：所有 vault 都是它的子目录，结束时一次性（尽力）清理。
// Windows 上 SQLite 句柄可能仍持有 .db/-wal/-shm → 删除失败必须忽略，不能让测试变红。
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-e2e-recall-'))
after(async () => {
  closeAllDb() // 关掉 per-root 单例连接，尽量让目录可删
  try { await fs.rm(tmpRoot, { recursive: true, force: true }) } catch { /* EBUSY：忽略，系统临时目录会自动回收 */ }
})

let vaultSeq = 0
/** 新建一个独立临时 vault（含 SQLite 库文件），返回绝对路径。 */
async function freshVault(label = 'vault') {
  const root = path.join(tmpRoot, `${label}-${vaultSeq++}`)
  await fs.mkdir(root, { recursive: true })
  await ensureVault(root)
  return root
}

/** 每个用例自己登记清理：先关连接再删目录，删不动就忽略（Windows EBUSY）。 */
function cleanup(t, root) {
  t.after(async () => {
    closeAllDb()
    try { await fs.rm(root, { recursive: true, force: true }) } catch { /* 忽略：不污染 ~/.dsh，也不让测试失败 */ }
  })
}

/**
 * 贯穿单个用例的唯一标记。
 * 只用十六进制（无分隔符）→ 与其它标记不共享 bigram，避免 CJK 检索/去重的假命中。
 */
const unique = (tag) => `${tag}${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`

/** 读卡正文的便捷包装（readCard 现在返回 { path, status, text }）。 */
const bodyOf = async (root, rel, opts) => (await readCard(root, rel, opts)).text

/**
 * 断言式写卡：失败时重试一次。
 *
 * 为什么需要：本仓库有时会被别的进程/会话并行改动 lib/**（一次 npm test 正在进行、同时有人写文件），
 * 极少数情况下会看到一次性的写入失败（文件被占用 / 模块被改到一半）。这类抖动不是产品行为，
 * 不该让端到端用例变红；真正的失败仍然会抛出来。
 */
async function writeCardOrRetry(root, card, opts) {
  const first = await writeCard(root, card, opts)
  if (first.ok) return first
  return writeCard(root, card, opts)
}

// ---------------------------------------------------------------------------
// 步骤 1-3：写入 → 新会话召回 → 实际使用
// ---------------------------------------------------------------------------
test('e2e 三步骤：写入 approved 卡 → search 召回 → 召回内容可支撑推断', async (t) => {
  const root = await freshVault('recall')
  cleanup(t, root)

  const uniq = unique('lapsang')
  const keyword = `正山小种${uniq}` // 同时出现在标题与正文，保证标题/正文任一路径都能召回

  // ---- 步骤 1：写入 ----
  // 见文件头约定 1：空库无 auditMode 配置 → enforceAudit 返回 fallback（approved）原样生效。
  // 若库里已写入 auditMode（例如 'all'），同一调用会被强制降为 pending，那时才必须显式审核；
  // 本用例用空库，因此下面**显式断言**写入态确实是 approved（守卫存在但未触发），而不是靠运气。
  const written = await writeCardOrRetry(root, {
    kind: 'knowledge',
    title: `记忆三步骤验证-${keyword}`,
    tags: ['e2e', uniq],
    body: `# ${keyword}\n\n本卡用于验证「写入 → 新会话召回 → 实际使用」全链路。\n唯一标记：${uniq}\n结论：该标记必须能被 search() 召回。`,
    source: 'session:e2e-test',
    status: 'approved',
  })
  assert.equal(written.ok, true, '写卡应成功')
  assert.ok(written.path, '写卡应返回 path')
  assert.match(written.path, /^03-Knowledge\//, 'knowledge 卡应落在 03-Knowledge/')

  const stored = await bodyOf(root, written.path)
  assert.ok(stored.includes(uniq), '库里的卡必须真的含唯一标记（不是空壳）')

  // 若审核守卫把状态降级成了 pending，这里会失败并提示改用 setCardStatus 显式批准。
  const approvedNow = await listCards(root) // listCards 默认只返回 approved
  assert.equal(approvedNow.length, 1, '空库 + 无 auditMode 配置时 approved 应原样保留（被降级则此处为 0，需 setCardStatus 显式批准）')
  assert.equal(approvedNow[0].path, written.path)
  assert.equal((await readCard(root, written.path)).status, 'approved', 'readCard 也应报出 approved')

  // ---- 步骤 2：新会话召回（模拟另一个会话按需检索同一个库）----
  const hits = await search(root, uniq)
  assert.ok(hits.length >= 1, `search(${uniq}) 必须命中刚写入的卡`)

  const hit = hits.find((h) => h.path === written.path)
  assert.ok(hit, '召回结果的 path 必须与写入返回的 path 一致')
  assert.equal(hit.title, `记忆三步骤验证-${keyword}`)
  assert.equal(hit.status, 'approved', '召回只应返回 approved 卡')
  assert.ok(hit.excerpt.includes(uniq), '召回 excerpt 必须包含唯一标记（供 agent 直接引用）')
  assert.ok(hit.summary.includes(uniq), '召回 summary 必须包含唯一标记')
  assert.ok(hit.score > 0, '命中必须有正分（非空壳命中）')

  // ---- 步骤 3：实际使用（用召回文本做一次推断，确保内容可用而不是空壳）----
  const recalledText = `${hit.title}\n${hit.summary}\n${hit.excerpt}`
  const inferred = recalledText.includes(uniq) ? `命中记忆：${uniq}` : ''
  assert.notEqual(inferred, '', 'agent 应能从召回文本中读出唯一标记')
  assert.ok(recalledText.includes('记忆三步骤验证'), '召回文本应含可读标题，而不只是分数与路径')
  assert.ok(recalledText.length > 40, '召回文本应有足够上下文支撑一次推断')

  // 对照：库外的无关查询不应产生假命中（召回面不是「什么都返回」）
  assert.equal((await search(root, unique('quantum'))).length, 0, '无关查询不应命中')
})

// ---------------------------------------------------------------------------
// 步骤 4：跨库聚合
// ---------------------------------------------------------------------------
test('e2e 跨库聚合：searchAll([vaultA, vaultB]) 同时命中两个库', async (t) => {
  const vaultA = await freshVault('agg-a')
  const vaultB = await freshVault('agg-b')
  cleanup(t, vaultA)
  cleanup(t, vaultB)

  const uniqA = unique('agga')
  const uniqB = unique('aggb')
  const shared = '跨库聚合关键词'

  const a = await writeCardOrRetry(vaultA, {
    kind: 'knowledge',
    title: `A 库记忆-${uniqA}`,
    body: `${shared}：这是 A 库独有的正文。唯一标记 ${uniqA}，用于确认命中来自 A 库。`,
    status: 'approved',
  })
  const b = await writeCardOrRetry(vaultB, {
    kind: 'knowledge',
    title: `B 库记忆-${uniqB}`,
    body: `${shared}：这是 B 库独有的正文。唯一标记 ${uniqB}，用于确认命中来自 B 库。`,
    status: 'approved',
  })
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)

  // 形状按 lib/vault.js searchAll 实现：name 非空时 path 会被加上 `${name}::` 前缀，并附加 profile 字段。
  const roots = [{ name: '', root: vaultA }, { name: 'profile-b', root: vaultB }]
  const hits = await searchAll(roots, shared, { limit: 10 })

  const hitA = hits.find((h) => h.path === a.path && h.profile === '')
  const hitB = hits.find((h) => h.path === `profile-b::${b.path}` && h.profile === 'profile-b')
  assert.ok(hitA, 'searchAll 必须返回 A 库命中（无名库 path 不加前缀，profile 为空串）')
  assert.ok(hitB, 'searchAll 必须返回 B 库命中（有名库 path 加 `profile-b::` 前缀，profile=名称）')
  assert.ok(hitA.excerpt.includes(uniqA), 'A 库命中的 excerpt 应含 A 的唯一标记')
  assert.ok(hitB.excerpt.includes(uniqB), 'B 库命中的 excerpt 应含 B 的唯一标记')
  assert.ok(hitB.path.startsWith('profile-b::'), '跨库 path 前缀是区分来源的唯一依据')

  // 各库自身的 search 不应串库（聚合是叠加，不是混库）
  assert.equal((await search(vaultA, uniqB)).length, 0, 'A 库不应召回 B 库内容')
  assert.equal((await search(vaultB, uniqA)).length, 0, 'B 库不应召回 A 库内容')
})

// ---------------------------------------------------------------------------
// 步骤 5：未审核卡隔离（重点）
// ---------------------------------------------------------------------------
test('e2e 未审核卡隔离：status=pending 不进入 search 召回面，也读不出正文', async (t) => {
  const root = await freshVault('pending')
  cleanup(t, root)

  const uniq = unique('pending')
  const out = await writeCard(root, {
    kind: 'knowledge',
    title: `未审核草稿-${uniq}`,
    body: `这是一张等待人工审核的草稿卡，唯一标记 ${uniq}，在批准前不得进入 agent 召回面。`,
  })
  assert.equal(out.ok, true, '默认写入应成功')

  // 默认 status = pending；这里同时验证审核守卫没有把它悄悄改成 approved。
  const all = await listCards(root, { status: ['approved', 'pending', 'rejected'] })
  assert.equal(all.length, 1)
  assert.equal(all[0].status, 'pending', '默认写入必须是 pending（审核红线：不自动入库）')

  assert.equal((await search(root, uniq)).length, 0, '未审核卡绝不能被 search 召回')
  assert.equal((await search(root, '未审核草稿')).length, 0, '按标题也召回不到未审核卡')
  assert.equal((await listCards(root)).length, 0, 'listCards 默认也不应返回未审核卡')

  // path 直读同样拿不到正文（P0 修复：不再「猜到 path 即可读未审核内容」）——
  // 只有显式 allowUnapproved（审核中心/回收站预览）才放行。
  await assert.rejects(() => readCard(root, out.path), (e) => e.code === 'CARD_NOT_APPROVED', '默认 readCard 应拒绝未审核卡')
  const preview = await readCard(root, out.path, { allowUnapproved: true })
  assert.equal(preview.status, 'pending')
  assert.ok(preview.text.includes(uniq), '显式放行时（审核中心预览）才应读到正文')
})

// ---------------------------------------------------------------------------
// 步骤 6：驳回卡隔离
// ---------------------------------------------------------------------------
test('e2e 驳回卡隔离：setCardStatus → rejected 后不进入召回面', async (t) => {
  const root = await freshVault('rejected')
  cleanup(t, root)

  const uniq = unique('rejected')
  const out = await writeCardOrRetry(root, {
    kind: 'knowledge',
    title: `将被驳回-${uniq}`,
    body: `这张卡先以 approved 写入以便演示审核驳回，唯一标记 ${uniq}。驳回后必须从召回面消失。`,
    status: 'approved',
  })
  assert.equal(out.ok, true)
  assert.equal((await search(root, uniq)).length, 1, '驳回前应能召回（前提校验）')

  const r = await setCardStatus(root, out.path, 'rejected', { changedBy: 'e2e-test', reason: '端到端验证' })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'rejected')

  assert.equal((await search(root, uniq)).length, 0, '驳回卡不得被 search 召回')
  assert.equal((await search(root, '将被驳回')).length, 0, '按标题也召回不到驳回卡')
  const all = await listCards(root, { status: ['approved', 'pending', 'rejected'] })
  assert.equal(all[0].status, 'rejected', '卡片本身仍在审核队列里（隔离 ≠ 删除）')
  assert.equal(all.length, 1, '驳回不删卡')

  // 审核队列仍能看到它（人工复核入口），但正文要走显式放行。
  await assert.rejects(() => readCard(root, out.path), (e) => e.code === 'CARD_NOT_APPROVED', '驳回卡默认不可读正文')
})

// ---------------------------------------------------------------------------
// 步骤 7：软删卡隔离
// ---------------------------------------------------------------------------
test('e2e 软删卡隔离：deleteCard（软删）后不进入召回面', async (t) => {
  const root = await freshVault('deleted')
  cleanup(t, root)

  const uniq = unique('deleted')
  const out = await writeCardOrRetry(root, {
    kind: 'knowledge',
    title: `将被软删-${uniq}`,
    body: `这张卡先以 approved 写入以便演示软删，唯一标记 ${uniq}。软删后必须从召回面消失但仍可恢复。`,
    status: 'approved',
  })
  assert.equal(out.ok, true)
  assert.equal((await search(root, uniq)).length, 1, '软删前应能召回（前提校验）')

  const d = await deleteCard(root, out.path)
  assert.equal(d.ok, true)
  assert.equal(d.soft, true, 'deleteCard 默认是软删（写 deleted_at，不物理删除）')

  assert.equal((await search(root, uniq)).length, 0, '软删卡不得被 search 召回')
  assert.equal((await search(root, '将被软删')).length, 0, '按标题也召回不到软删卡')
  // 软删不是物理删：卡还在库里（status=deleted），只是离开了召回面
  const all = await listCards(root, { status: ['approved', 'pending', 'rejected', 'deleted'] })
  assert.equal(all.length, 1)
  assert.equal(all[0].status, 'deleted')
  await assert.rejects(() => readCard(root, out.path), (e) => e.code === 'CARD_NOT_APPROVED', '软删卡默认不可读正文（走回收站预览）')
})

// ---------------------------------------------------------------------------
// 步骤 8：去重的状态边界（待审内容既不能被「合并进去」，也不能当去重基准）
// ---------------------------------------------------------------------------
test('e2e 去重基准：approved 卡仍参与去重（守卫本身有效）', async (t) => {
  const root = await freshVault('dedup-approved')
  cleanup(t, root)

  const uniq = unique('dedupok')
  const body = `关于${uniq}的完整结论：采用方案甲，因为延迟更低、迁移成本可控，并且团队已经熟悉这套工具链，风险最小。`
  const first = await writeCardOrRetry(root, { kind: 'knowledge', title: `去重基准-${uniq}`, body, status: 'approved' })
  assert.equal(first.ok, true)

  // 近重复（仅追加细节）→ 必须被去重守卫挡住，不产生第二张卡
  const dup = await writeCard(root, { kind: 'knowledge', title: `去重近重复-${uniq}`, body: body + '补充：灰度发布分两批，先小流量再全量。', status: 'approved' })
  assert.equal(dup.ok, false, '近重复内容应被去重拒绝')
  assert.ok(dup.duplicate, '去重命中应返回 duplicate 信息')
  assert.equal(dup.duplicate.path, first.path, 'duplicate 应指向已存在的 approved 卡')
  assert.equal((await listCards(root)).length, 1, '不应产生重复卡')
})

test('e2e 去重不跨状态：与 pending 卡高度相似的新卡不会被写入那张未审核卡', async (t) => {
  const root = await freshVault('dedup-pending')
  cleanup(t, root)

  const uniq = unique('deduppend')
  const body = `关于${uniq}的完整结论：采用方案乙，理由是吞吐更高、依赖更少，且不需要额外的运维投入。`

  // 第一张：未审核（pending）—— 按语义，它不应对后续写入产生任何去重影响。
  const pendingCard = await writeCardOrRetry(root, { kind: 'knowledge', title: `未审核基准-${uniq}`, body })
  assert.equal(pendingCard.ok, true)
  const pendingAll = await listCards(root, { status: ['pending'] })
  assert.equal(pendingAll[0].status, 'pending', '基准卡确实是未审核状态')

  // 第二张：与该 pending 卡正文高度相似（正文完全相同 + 一句补充）的新卡。
  // dedupCheck 只比对 approved → 不会命中 pending 卡，新卡应正常写入。
  const similar = await writeCard(root, {
    kind: 'knowledge',
    title: `新知识-${uniq}`,
    body: body + '补充：压测显示 P99 更稳定，后续按此结论落地。',
    status: 'approved',
  })
  assert.equal(similar.ok, true, '未审核卡不参与去重，新卡应正常写入')
  assert.ok(similar.path, '应返回新卡 path')
  assert.notEqual(similar.path, pendingCard.path, '绝不写入/复用那张未审核卡')

  // 两张卡并存，且只有 approved 的那张进入召回面。
  const all = await listCards(root, { status: ['approved', 'pending'] })
  assert.equal(all.length, 2, 'pending 与新 approved 卡并存')
  const hits = await search(root, uniq)
  assert.ok(hits.some((h) => h.path === similar.path), '新 approved 卡可被召回')
  assert.ok(hits.every((h) => h.path !== pendingCard.path), '未审核卡不在召回面')

  // 同样的相似内容再来一次 → 这次必须被**新 approved 卡**挡住（证明 approved 基准已生效）
  const dup = await writeCard(root, { kind: 'knowledge', title: `新知识二-${uniq}`, body, status: 'approved' })
  assert.equal(dup.ok, false, '与 approved 卡重复的内容应被挡住')
  assert.equal(dup.duplicate.path, similar.path, 'duplicate 目标是 approved 卡，而不是 pending 卡')
})

test('e2e 去重不跨状态：rejected / deleted 卡不作为去重基准', async (t) => {
  const root = await freshVault('dedup-state')
  cleanup(t, root)

  const uniqRej = unique('deduprej')
  const uniqDel = unique('dedupdel')
  const bodyRej = `关于${uniqRej}的结论：方案甲可行，需要补充上游依赖的版本锁定。`
  const bodyDel = `关于${uniqDel}的结论：方案乙可行，需要补充回滚脚本与数据校验。`

  // rejected 基准
  const rej = await writeCardOrRetry(root, { kind: 'knowledge', title: `驳回基准-${uniqRej}`, body: bodyRej, status: 'approved' })
  assert.equal(rej.ok, true)
  await setCardStatus(root, rej.path, 'rejected', { changedBy: 'e2e-test', reason: '驳回' })
  const rejAgain = await writeCard(root, { kind: 'knowledge', title: `同内容新卡-${uniqRej}`, body: bodyRej, status: 'approved' })
  assert.equal(rejAgain.ok, true, '驳回卡不应阻挡同内容的新卡写入')

  // deleted 基准
  const del = await writeCardOrRetry(root, { kind: 'knowledge', title: `软删基准-${uniqDel}`, body: bodyDel, status: 'approved' })
  assert.equal(del.ok, true)
  await deleteCard(root, del.path)
  const delAgain = await writeCard(root, { kind: 'knowledge', title: `同内容新卡二-${uniqDel}`, body: bodyDel, status: 'approved' })
  assert.equal(delAgain.ok, true, '软删卡不应阻挡同内容的新卡写入')
})

// ---------------------------------------------------------------------------
// 补充：无 LLM 降级沉淀路径（runStandaloneCapture）也必须守住审核红线
// ---------------------------------------------------------------------------
test('e2e 降级沉淀：runStandaloneCapture 默认落 pending，不进入召回面', async (t) => {
  const root = await freshVault('capture-degraded')
  cleanup(t, root)

  const uniq = unique('capture')
  // 独立进程无 DSH settings 时默认 auditMode='all' → pending。这里显式传 env 隔离，
  // 避免本机 MEMORY_AUDIT_MODE / 共享配置文件把它变成 approved 而误判。
  const text = `本轮讨论围绕记忆三步骤验证展开，唯一标记 ${uniq}。结论：写入 step 走 captureCard，召回 step 只认 approved，使用 step 由 agent 引用召回文本完成推断。`.repeat(2)
  const out = await runStandaloneCapture(root, text, {
    source: 'e2e-test',
    env: { DSH_HOME: path.join(root, 'no-such-dsh-home'), MEMORY_AUDIT_MODE: 'all' },
  })

  assert.equal(out.ok, true, '降级路径应写入成功')
  assert.equal(out.action, 'created')
  assert.equal(out.degraded, true, '无 LLM 时应标记为降级卡')

  const all = await listCards(root, { status: ['approved', 'pending', 'rejected'] })
  assert.equal(all.length, 1)
  assert.equal(all[0].status, 'pending', '降级卡默认 pending（审核红线）')
  assert.equal((await search(root, uniq)).length, 0, '未审核的降级卡不得进入召回面')

  // 显式批准后才可召回 —— 这正是「已在审核中心待批准」的语义。
  await setCardStatus(root, out.path, 'approved', { changedBy: 'user', reason: '人工批准' })
  const hits = await search(root, uniq)
  assert.equal(hits.length, 1, '批准后应可召回')
  assert.equal(hits[0].path, out.path)
  assert.ok(hits[0].excerpt.includes(uniq), '批准后的召回 excerpt 应含唯一标记')
})
