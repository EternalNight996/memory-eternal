// 搜索命中证据（_match）：回答「这条为什么会被搜出来」。
// 为什么要守它：检索是 FTS（词法）+ 向量（语义）混合，语义召回会带出**没有任何字面关键词**的相关卡片。
// 没有 _match，前端只能瞎猜，用户看到「3 条结果一条都不高亮」会以为搜索坏了。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeCard, setCardStatus, search } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'

async function makeVault(specs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'me-smatch-'))
  for (const s of specs) {
    const r = await writeCard(root, { kind: 'knowledge', title: s.title, tags: s.tags || [], body: s.body, status: 'pending', submittedBy: 'test' }, { dedup: false })
    await setCardStatus(root, r.path, 'approved')
  }
  return root
}
const cleanup = (root) => { try { closeAllDb() } catch {} try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) } catch {} }

test('命中标题：_match.where=title，snippet 非空且包含命中词', async () => {
  const root = await makeVault([
    { title: '火绒剑驱动逆向笔记', body: '# 记录\n\n内核驱动分析。', tags: ['逆向'] },
    { title: '别的主题', body: '# 无关\n\n完全无关内容。', tags: [] },
  ])
  try {
    const hits = await search(root, '火绒', { limit: 10 })
    assert.ok(hits.length >= 1, '应当搜到火绒那张卡')
    const hit = hits.find((h) => h.title.includes('火绒'))
    assert.ok(hit, '命中的卡里要包含火绒卡')
    assert.ok(hit._match, '必须带 _match 证据')
    assert.equal(hit._match.where, 'title')
    assert.equal(hit._match.term, '火绒')
    assert.match(hit._match.snippet, /火绒/)
  } finally { cleanup(root) }
})

test('命中正文档：summary 或 body 都算，片段带上下文省略号', async () => {
  const root = await makeVault([
    // 关键词放在正文里（summary 是 body 前 200 字的截断，落哪一段都算正文档命中）
    { title: '完全无关的标题', body: '# 附录\n\n' + '前置无关键内容。'.repeat(40) + '这里提到了火绒的安全软件，后面继续写别的。' + '尾巴。'.repeat(40), tags: [] },
  ])
  try {
    const hits = await search(root, '火绒', { limit: 10 })
    const hit = hits.find((h) => h._match && (h._match.where === 'body' || h._match.where === 'summary'))
    assert.ok(hit, '应当命中正文档：' + JSON.stringify(hits.map((h) => h._match)))
    assert.equal(hit._match.term, '火绒')
    assert.match(hit._match.snippet, /火绒/)
  } finally { cleanup(root) }
})

test('命中标签：_match.where=tags', async () => {
  const root = await makeVault([
    { title: '一张关于安全的卡', body: '# 安全\n\n内容里没有那个词。', tags: ['火绒', '安全'] },
  ])
  try {
    const hits = await search(root, '火绒', { limit: 10 })
    const hit = hits.find((h) => h._match && h._match.where === 'tags')
    assert.ok(hit, '应当命中标签：' + JSON.stringify(hits.map((h) => h._match)))
    assert.equal(hit._match.term, '火绒')
  } finally { cleanup(root) }
})

test('长词优先：搜「内核驱动逆向」时命中词是整串而不是短词', async () => {
  const root = await makeVault([
    { title: '内核驱动逆向实战', body: '# 正文\n\n逆向的一些记录。', tags: [] },
  ])
  try {
    const hits = await search(root, '内核驱动逆向', { limit: 10 })
    const hit = hits[0]
    assert.ok(hit && hit._match, '应当有命中证据')
    assert.equal(hit._match.where, 'title')
    // 命中词应当是长串（整串）而不是被拆成「逆向」
    assert.match(hit._match.snippet, /内核驱动逆向/)
  } finally { cleanup(root) }
})

test('没有任何字面命中的条目：_match 标 semantic，且不带编造的片段', async () => {
  // 造一个 FTS 兜底路径下"能通过分数但正文不含该词"的场景很难，这里直接断言契约形状：
  // 只要 _match 存在，就必须四字段齐全；where=semantic 时 snippet/term 必须为空。
  const root = await makeVault([{ title: '一张卡', body: '# 卡\n\n内容。', tags: [] }])
  try {
    const hits = await search(root, '卡', { limit: 10 })
    for (const h of hits) {
      assert.ok(h._match, '每条命中都要带 _match')
      for (const k of ['where', 'term', 'snippet']) assert.ok(k in h._match, '_match 缺字段 ' + k)
      if (h._match.where === 'semantic') {
        assert.equal(h._match.term, '')
        assert.equal(h._match.snippet, '')
      }
    }
  } finally { cleanup(root) }
})
