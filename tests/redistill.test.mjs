// 审核中心「重新蒸馏」：降级原文卡 → 调蒸馏模型 → 原地更新，仍为 pending。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureVault, writeCard, auditQueue, readCard } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'
import { createApi } from '../lib/api.js'

const CARD = JSON.stringify({
  save: true,
  title: '重新蒸馏后的知识卡',
  kind: 'knowledge',
  tags: ['redistill', 'test'],
  body: '这是一张经过重新蒸馏的知识卡，结论清晰。',
})

let llmPayload = CARD

function mockLlm(payload = llmPayload) {
  return {
    listProviders() { return [{ id: 'mock-provider' }] },
    async listModels() { return [{ id: 'mock-model' }] },
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      const chunks = payload.match(/.{1,50}/gs) || []
      for (const text of chunks) yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: payload } }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

let api, root, dsh, savedHome, base

before(async () => {
  dsh = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-redistill-home-'))
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dsh // 隔离，避免读本机真实 embedding 配置触发网络
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-redistill-vault-'))
  await ensureVault(root)
  api = http.createServer(createApi({
    vaultDir: () => root,
    vaultRoots: () => [{ name: '', root }],
    getSettings: () => ({}),
    getLlm: () => mockLlm(),
  }))
  await new Promise((r) => api.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + api.address().port + '/memory-eternal/api'
})

after(async () => {
  closeAllDb()
  if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome
  if (api) await new Promise((r) => api.close(r))
  try { await fsp.rm(dsh, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
  try { await fsp.rm(root, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
})

const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())

test('降级原文卡：重新蒸馏后原地更新，仍为待审', async () => {
  const w = await writeCard(root, {
    kind: 'content',
    title: '蒸汽蒸馏失败的原文',
    tags: ['raw', 'distill-failed'],
    body: '原始对话很长很长，蒸馏失败时被降级保存。' + '这里是一条可以复用的技术结论与参数说明。'.repeat(8),
    status: 'pending',
    submittedBy: 'agent',
    reason: 'AI 自动沉淀（蒸馏无输出 → 原文卡兜底；主因：UNPARSEABLE_OUTPUT）',
  })
  assert.equal(w.ok, true)
  const r = await post('/audit/redistill', { path: w.path })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.title, '重新蒸馏后的知识卡')
  assert.equal(r.kind, 'knowledge')

  const q = await auditQueue(root)
  const card = q.pending.find((c) => c.path === w.path)
  assert.ok(card, '重新蒸馏后必须仍在待审队列')
  assert.equal(card.title, '重新蒸馏后的知识卡')
  assert.equal(card.kind, 'knowledge')
})

test('非降级卡拒绝重新蒸馏', async () => {
  const w = await writeCard(root, {
    kind: 'knowledge',
    title: '普通待审卡',
    body: '这张卡是正常蒸馏产物，不应允许重新蒸馏。' + '正文'.repeat(30),
    status: 'pending',
    submittedBy: 'agent',
    reason: 'AI 自动沉淀（蒸馏卡）',
  })
  const r = await post('/audit/redistill', { path: w.path })
  assert.equal(r.ok, false)
  assert.match(r.error, /原文卡|降级/)
})

test('不存在的卡 / 缺 path 返回明确错误', async () => {
  const a = await post('/audit/redistill', { path: '03-Knowledge/不存在.md' })
  assert.equal(a.ok, false)
  const b = await post('/audit/redistill', {})
  assert.equal(b.ok, false)
})

// issue #64：append_to 结果是 {append_to, update}，没有 save 字段。
// 旧实现先判 save !== true，直接把「应并入已有卡」误报成 422「模型未产出可保存的知识卡」。
test('模型判定 append_to：返回「应并入已有卡」，不再误报 422（issue #64）', async () => {
  const w = await writeCard(root, {
    kind: 'content',
    title: '待并入的原文卡',
    tags: ['raw', 'distill-failed'],
    body: '原始对话被降级保留下来的内容。' + '这里是一条可以复用的技术结论与参数说明，包含命令与配置项。'.repeat(10),
    status: 'pending',
    submittedBy: 'agent',
    reason: 'AI 自动沉淀（蒸馏无输出 → 原文卡兜底）',
  })
  assert.equal(w.ok, true)
  llmPayload = JSON.stringify({ append_to: '03-Knowledge/已有卡.md', update: '补充：这条应追加到已有卡，而不是新建。' })
  try {
    const r = await post('/audit/redistill', { path: w.path })
    // 目标不存在时的当前语义是**降级保留**（不是 422）：把 update 写进本卡正文 + 打标记，
    // 让用户还能看到模型想并到哪、并了什么；issue #64 要防的是「误报未产出可保存」。
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.mode, 'target-missing', JSON.stringify(r))
    assert.equal(r.appendTo, '03-Knowledge/已有卡.md', JSON.stringify(r))
    assert.match(r.note, /目标不存在/, JSON.stringify(r))
    assert.doesNotMatch(String(r.error || ''), /未产出可保存/, '不得再退回「模型未产出可保存」的误报')
    const q = await auditQueue(root)
    const card = q.pending.find((c) => c.path === w.path)
    assert.ok(card, '原文卡应仍在待审队列')
    assert.equal(card.title, '待并入的原文卡')
    // listCards 出于性能不带 body（0.52 起），正文要用 readCard 读
    const full = await readCard(root, w.path, { allowUnapproved: true })
    assert.match(String(full.text || ''), /补充：这条应追加到已有卡/, 'update 内容要落到本卡正文，不能丢')
    assert.match(String(card.summary || ''), /补充：这条应追加到已有卡/, '摘要也要带上，审核中心才有可读预览')
    assert.ok((card.tags || []).includes('append-target-missing'), '降级要留标记，审核中心能看出来')
  } finally {
    llmPayload = CARD
  }
})

test('宿主沉淀链路：append_to 判断必须先于 save（issue #64 不可达回归）', async () => {
  const src = await fsp.readFile(new URL('../index.js', import.meta.url), 'utf8')
  const appendAt = src.indexOf('if (result.append_to)')
  const saveAt = src.indexOf('if (result.save !== true)')
  assert.ok(appendAt >= 0 && saveAt >= 0, '两处判断都要在')
  assert.ok(appendAt < saveAt, 'append_to 必须先判，否则 {append_to, update} 会被当成「不值得保存」跳过')
})
