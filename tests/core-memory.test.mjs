// 核心记忆（前置强制记忆）：已批准的 core 卡每次会话注入 systemPrompt，
// 不依赖 autoRecall / memory_recall 工具调用；限制条数与总字符。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { coreMemoryPrompt, CORE_HEADER } from '../lib/core-memory.js'
import { writeCard, setCardKind, setCardStatus } from '../lib/vault.js'
import { setAuditConfig } from '../lib/db.js'

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'me-core-'))
async function seed(root, title, body) {
  setAuditConfig(root, { auditMode: 'none', auditExemptAgents: [], auditExemptKinds: [] })
  const r = await writeCard(root, { kind: 'core', title, body, status: 'approved', submittedBy: 'test' })
  assert.equal(r.ok, true, '写入核心卡失败: ' + JSON.stringify(r))
  // core 不论 auditMode / 显式 status 如何都先待审；测试里模拟用户批准。
  assert.equal(r.status, 'pending', '核心卡必须强制待审')
  await setCardStatus(root, r.path, 'approved')
  return r.path
}

test('核心卡被注入，普通卡不会混进来', async () => {
  const root = makeRoot()
  await seed(root, '用户偏好：内部思考也用中文', '用户要求：内部思考（reasoning）与回复都用中文。')
  setAuditConfig(root, { auditMode: 'none', auditExemptAgents: [], auditExemptKinds: [] })
  const normal = await writeCard(root, { kind: 'knowledge', title: '普通知识', body: '这条不是核心记忆', status: 'approved', submittedBy: 'test' })
  assert.equal(normal.ok, true)
  const out = await coreMemoryPrompt(root)
  assert.equal(out.ok, true)
  assert.equal(out.count, 1)
  assert.ok(out.text.startsWith(CORE_HEADER))
  assert.match(out.text, /内部思考也用中文/)
  assert.doesNotMatch(out.text, /普通知识/)
})

test('关闭后返回空；limit 与 maxChars 生效且不超预算', async () => {
  const root = makeRoot()
  await seed(root, '核心一', '第一条核心记忆内容')
  await seed(root, '核心二', '第二条核心记忆内容')
  await seed(root, '核心三', '第三条核心记忆内容')
  assert.equal((await coreMemoryPrompt(root, { enabled: false })).text, '')
  assert.equal((await coreMemoryPrompt(root, { limit: 2 })).count, 2)
  const capped = await coreMemoryPrompt(root, { limit: 20, maxChars: 260 })
  assert.ok(capped.text.length <= 260, '注入文本不能超过 maxChars: ' + capped.text.length)
  assert.ok(capped.count >= 1)
})

test('已批准普通卡可提升为核心，审核中的卡不能提升', async () => {
  const root = makeRoot()
  setAuditConfig(root, { auditMode: 'none', auditExemptAgents: [], auditExemptKinds: [] })
  const normal = await writeCard(root, { kind: 'knowledge', title: '偏好：回答简洁', body: '用户要求回答尽量简洁。', status: 'approved', submittedBy: 'test' })
  assert.equal(normal.ok, true)
  await setCardKind(root, normal.path, 'core')
  const out = await coreMemoryPrompt(root)
  assert.equal(out.count, 1)
  assert.match(out.text, /回答简洁/)

  setAuditConfig(root, { auditMode: 'all', auditExemptAgents: [], auditExemptKinds: [] })
  const pending = await writeCard(root, { kind: 'knowledge', title: '待审批偏好', body: '这是待审批的卡。', status: 'pending', submittedBy: 'test' })
  assert.equal(pending.ok, true)
  await assert.rejects(() => setCardKind(root, pending.path, 'core'), /已批准|审核/)
})
test('core 卡强制待审：auditMode=none 也不能免审', async () => {
  const root = makeRoot()
  setAuditConfig(root, { auditMode: 'none', auditExemptAgents: ['__all__'], auditExemptKinds: ['__all__'] })
  const r = await writeCard(root, { kind: 'core', title: '免审测试', body: '核心偏好必须人工审核。', status: 'approved', submittedBy: 'test' })
  assert.equal(r.ok, true)
  assert.equal(r.status, 'pending')
  assert.equal(r.store, 'quarantine')
})

test('自动沉淀能建议 core，但数据库层仍强制待审', () => {
  const capture = readFileSync(new URL('../lib/capture.js', import.meta.url), 'utf8')
  assert.match(capture, /knowledge|project|content|prompt|business|tool|mistake|core/)
  assert.match(capture, /core 只在/)
  const db = readFileSync(new URL('../lib/db.js', import.meta.url), 'utf8')
  assert.match(db, /kind\) === 'core'\) return 'pending'/)
})

test('宿主在 systemPrompt 里注入核心记忆，且配置有默认值', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(src, /memory-eternal: core-memory/, 'host 要注册核心记忆 systemPrompt 段')
  assert.match(src, /coreMemoryPrompt/, 'host 要调用 coreMemoryPrompt')
  assert.match(src, /order: 120/, '核心记忆必须比普通召回更靠前')
  assert.match(src, /coreMemoryEnabled: z\.boolean\(\)\.default\(true\)/)
  assert.match(src, /coreMemoryLimit: z\.number\(\)\.min\(1\)\.max\(20\)\.default\(6\)/)
  assert.match(src, /coreMemoryMaxChars: z\.number\(\)\.min\(200\)\.max\(10000\)\.default\(2000\)/)
})
