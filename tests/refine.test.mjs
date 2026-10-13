// issue #36 的落地守卫：**相似可以合并，矛盾必须人判断**。
//
// 背景：现有 /optimize 只按相似度（>=0.55）盲合并，而两张语义相近、结论互斥的卡相似度同样很高 ——
// 盲合并会把冲突悄悄"和解"掉（且 mergeCards 会永久删除源卡）。这里守住四件事：
//   ① 宽召回候选对（含近重复那一段）；② 判别结果只做建议，扫描绝不写库；
//   ③ apply 只做可恢复动作（进回收站），并记录决策避免重复打扰；
//   ④ 被判为矛盾的对，**绝不参与一键优化**。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeCard, setCardStatus, listCards, optimizeApply } from '../lib/vault.js'
import { refineCandidates, refineApply, refineScan, readDecisions, parseJudge } from '../lib/refine.js'
import { stripRuntimeNoise } from '../lib/capture.js'

const body = (n) => '# SQLite 并发写入注意点\n' + ('- 要点 ' + n + '：WAL 模式下多进程可写，但长事务会阻塞检查点。建议忙等超时并避免长写事务。\n').repeat(8)

async function makeVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-refine-'))
  const titles = ['SQLite WAL 并发写建议', 'SQLite WAL 写并发注意事项']
  const paths = []
  for (let i = 0; i < titles.length; i++) {
    const r = await writeCard(root, { kind: 'knowledge', title: titles[i], tags: ['sqlite'], body: body(i), status: 'pending', submittedBy: 'test' }, { dedup: false })
    if (r && r.path) { await setCardStatus(root, r.path, 'approved'); paths.push(r.path) }
  }
  return { root, paths, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) } catch {} } }
}

const fakeLlm = (json) => ({
  listProviders: () => [{ id: 'p' }],
  listModels: async () => [{ id: 'm' }],
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: json }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})

test('① 宽召回：近重复（相似度 0.9+）也要进候选 —— 那正是盲合并最危险的区间', async () => {
  const v = await makeVault()
  try {
    const cands = await refineCandidates(v.root)
    assert.equal(cands.length, 1, '两张高度相似的卡必须成为候选')
    assert.ok(cands[0].sim > 0.6, '相似度上限不该把近重复排除掉（默认 maxSim=1.0）')
    assert.deepEqual([cands[0].a.path, cands[0].b.path].sort(), [...v.paths].sort())
  } finally { v.cleanup() }
})

test('② 判别解析容错 + 扫描只读（不写库、不改卡）', async () => {
  assert.deepEqual(parseJudge('前言\n\`\`\`json\n{"relation":"conflict","conflict":"互斥","keep":"both","reason":"r"}\n\`\`\`')?.relation, 'conflict', '裹代码块也能解析')
  assert.equal(parseJudge('{"relation":"conflict"}')?.keep, 'both', '缺字段走安全默认')
  assert.equal(parseJudge('{"relation":"胡说八道"}')?.relation, 'unrelated', '非法枚举收敛到 unrelated')
  assert.equal(parseJudge('完全不是 JSON'), null)

  const v = await makeVault()
  try {
    const before = (await listCards(v.root, { status: ['approved'] })).length
    const out = await refineScan(v.root, { llm: fakeLlm('{"relation":"conflict","conflict":"两者对长事务的说法互斥","keep":"both","reason":"前提不同"}'), limit: 5 })
    assert.equal(out.ok, true)
    assert.equal(out.findings.length, 1)
    assert.equal(out.findings[0].relation, 'conflict')
    assert.equal(out.findings[0].conflict, '两者对长事务的说法互斥')
    assert.equal((await listCards(v.root, { status: ['approved'] })).length, before, '扫描**绝不能**动数据')
    // 判定为 unrelated 的对不算"发现"，只记 skipped
    const out2 = await refineScan(v.root, { llm: fakeLlm('{"relation":"unrelated","conflict":"","keep":"both","reason":"无关"}'), limit: 5 })
    assert.equal(out2.findings.length, 0)
    assert.equal(out2.skipped.length, 1)
    // 拿不到 llm（独立进程/CLI）要如实说，而不是假装扫完
    const noLlm = await refineScan(v.root, {})
    assert.equal(noLlm.ok, false)
    assert.match(noLlm.error, /llm/)
  } finally { v.cleanup() }
})

test('③ apply 只做可恢复动作 + 决策被记住（不再重复打扰）', async () => {
  const v = await makeVault()
  try {
    const c = (await refineCandidates(v.root))[0]
    assert.equal((await refineApply(v.root, { a: 'x', b: 'y', action: 'nope' })).ok, false, '未知动作必须拒绝')

    const kept = await refineApply(v.root, { a: c.a.path, b: c.b.path, action: 'keepBoth', relation: 'conflict' })
    assert.equal(kept.ok, true)
    assert.equal((await listCards(v.root, { status: ['approved'] })).length, 2, 'keepBoth 不动数据')
    assert.equal(Object.keys(readDecisions(v.root)).length, 1, '决策要记下来')
    assert.equal((await refineCandidates(v.root)).length, 0, '已裁决的对不再出现在候选里')

    const dropB = c.b.path
    const r = await refineApply(v.root, { a: c.a.path, b: c.b.path, action: 'keepA', relation: 'conflict' })
    assert.equal(r.ok, true)
    assert.equal(r.removed, dropB)
    assert.equal(r.recoverable, true, 'keepA/keepB 必须是可恢复动作')
    const approved = (await listCards(v.root, { status: ['approved'] })).map((x) => x.path)
    assert.equal(approved.length, 1)
    const recycled = (await listCards(v.root, { status: ['deleted'] })).map((x) => x.path)
    assert.deepEqual(recycled, [dropB], '被让位的那张要进回收站，而不是被永久删除')
  } finally { v.cleanup() }
})

test('④ 安全联锁：被判为矛盾的对，绝不参与「一键优化」的盲合并', async () => {
  const v = await makeVault()
  try {
    const c = (await refineCandidates(v.root))[0]
    const withoutDecision = await optimizeApply(v.root, { dryRun: true })
    assert.equal(withoutDecision.plan.merged, 1, '（对照组）默认情况下这两张会被当相似卡合并')
    await refineApply(v.root, { a: c.a.path, b: c.b.path, action: 'keepBoth', relation: 'conflict' })
    const after = await optimizeApply(v.root, { dryRun: true })
    assert.equal(after.plan.merged, 0, '判为矛盾后必须跳过 —— 否则冲突会被"和解"掉')
  } finally { v.cleanup() }
})

test('⑦ 同目标聚类：按「解决什么问题」聚合不同做法；目标抽取带缓存、扫描不写卡', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-goals-'))
  try {
    const cards = [
      ['用 7z 压缩发布包', 'knowledge', '# 用 7z 压缩发布包\n- 用 7z 把 dist 压到最小，配合 solid 压缩比 tar.gz 小 30%。'],
      ['用 tar.gz 分发发布包', 'knowledge', '# 用 tar.gz 分发发布包\n- 用 tar.gz 打包分发，保持跨平台可解压，注意排除 node_modules。'],
      ['每周周报模板', 'content', '# 每周周报模板\n- 本周进展 / 下周计划 / 风险，三段式，控制在 300 字以内。'],
    ]
    const paths = []
    for (const [title, kind, body] of cards) {
      const r = await writeCard(root, { kind, title, tags: [], body, status: 'pending', submittedBy: 'test' }, { dedup: false })
      await setCardStatus(root, r.path, 'approved')
      paths.push(r.path)
    }
    const { goalScan, markClusterKept, readGoals } = await import('../lib/refine.js')
    // 假模型：只看正文里出现了什么做法 → 给"目标"。7z / tar 两卡目标相同（这就是正文相似度抓不到的）
    const llm = {
      listProviders: () => [{ id: 'p' }], listModels: async () => [{ id: 'm' }],
      async *stream(opts) {
        const s = JSON.stringify(opts)
        const goal = (/7z|压缩/.test(s) ? '把发布包体积做小' : /tar|分发/.test(s) ? '把发布包体积做小' : '定期汇报进度')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ goal, topic: '发布' }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    const before = (await listCards(root, { status: ['approved'] })).length
    const s1 = await goalScan(root, { llm, limit: 10 })
    assert.equal(s1.ok, true)
    assert.equal(s1.calls, 3, '三张卡各抽一次目标')
    assert.equal(s1.clusters.length, 1, '7z 与 tar 应聚成一簇')
    assert.equal(s1.clusters[0].members.length, 2)
    assert.equal(s1.clusters[0].goal, '把发布包体积做小')
    assert.equal((await listCards(root, { status: ['approved'] })).length, before, '聚类**绝不能**动卡片')
    assert.equal(Object.keys(readGoals(root)).length, 3, '目标要落缓存')

    const s2 = await goalScan(root, { llm, limit: 10 })
    assert.equal(s2.calls, 0, '第二次扫描应当全走缓存（不再烧 token）')
    assert.equal(s2.clusters.length, 1)

    await markClusterKept(root, { paths: s1.clusters[0].members.map((m) => m.path) })
    const s3 = await goalScan(root, { llm, limit: 10 })
    assert.equal(s3.clusters.length, 0, '判定「都保留」后不再提示')
    assert.equal(s3.decidedClusters, 1)

    // 拿不到 llm 时如实报错
    assert.equal((await goalScan(root, {})).ok, false)
    assert.equal((await markClusterKept(root, { paths: ['only-one'] })).ok, false, '至少两张才叫「一组」')
  } finally { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('⑥ 存量注入垃圾卡：能识别、能回收（走回收站），且不误伤正常卡', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-junk-'))
  try {
    const junkBody = ['The available skills catalog changed:', '- \`code-review\`: Review the changes since a fixed point along two axes.',
      '- \`canvas\`: Use this skill when the agent produces a standalone analytical artifact.',
      '- \`hyperframes\`: Mandatory entry point: read this first for any video request.',
      '- \`media-use\`: Agent Media OS, the single skill for every media need.'].join('\n')
    const j = await writeCard(root, { kind: 'content', title: 'skills catalog', tags: [], body: junkBody, status: 'pending', submittedBy: 'test' }, { dedup: false })
    const n = await writeCard(root, { kind: 'knowledge', title: 'SQLite 并发写建议', tags: ['sqlite'], body: '# SQLite 并发写建议\n- WAL 下多进程可写，长事务会阻塞检查点；设忙等超时。\n- 避免长写事务，写前先算好。\n', status: 'pending', submittedBy: 'test' }, { dedup: false })
    await setCardStatus(root, j.path, 'approved')
    await setCardStatus(root, n.path, 'approved')

    const { findInjectedCards, purgeInjected } = await import('../lib/refine.js')
    const items = await findInjectedCards(root)
    const flagged = items.map((x) => x.path)
    assert.ok(flagged.includes(j.path), '技能目录卡要被识别出来')
    assert.ok(!flagged.includes(n.path), '正常知识卡不许误伤')
    assert.ok(items.find((x) => x.path === j.path).reasons.some((r) => /技能目录/.test(r)))

    // 提议阶段绝不写数据
    assert.equal((await listCards(root, { status: ['approved'] })).length, 2)
    const out = await purgeInjected(root, { paths: [j.path] })
    assert.equal(out.ok, true)
    assert.deepEqual(out.removed, [j.path])
    assert.equal(out.recoverable, true, '必须是可恢复动作')
    const approved = (await listCards(root, { status: ['approved'] })).map((x) => x.path)
    assert.deepEqual(approved, [n.path], '只回收被点名的那张')
    assert.deepEqual((await listCards(root, { status: ['deleted'] })).map((x) => x.path), [j.path], '进回收站而不是被删掉')
    assert.equal((await purgeInjected(root, {})).ok, false, '没给 path 要如实报错')
  } finally { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('⑤ 冗余来源：技能目录这类注入文本不该被抓成卡（#36 的垃圾卡现场）', () => {
  const injected = [
    'The available skills catalog changed. This complete catalog replaces every earlier list:',
    '- \`code-review\`: Review the changes since a fixed point (commit, PR) along two axes.',
    '- \`canvas\`: Use this skill when the agent produces a standalone analytical artifact.',
    '<available_skills>',
    '- \`hyperframes\`: Mandatory entry point: read this first for any video request.',
    '</available_skills>',
    '用户：帮我看下这个 SQLite 的并发写入要注意什么？',
  ].join('\n')
  const cleaned = stripRuntimeNoise(injected)
  assert.doesNotMatch(cleaned, /code-review/, '目录条目行要被剥掉')
  assert.doesNotMatch(cleaned, /hyperframes/, 'available_skills 块里的行也要被剥掉')
  assert.match(cleaned, /SQLite 的并发写入/, '真实对话必须留下')
})
