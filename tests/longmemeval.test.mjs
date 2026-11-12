import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeAllDb } from '../lib/db.js'
import { normalizeQuestions, sessionToCard, makeScratchVault, ingestQuestion, evalQuestion, summarize } from '../lib/eval-longmemeval.js'

const tmpRoots = []
after(async () => {
  closeAllDb()
  for (const p of tmpRoots) { try { await fsp.rm(p, { recursive: true, force: true }) } catch { /* Windows 句柄 */ } }
})

const qs = normalizeQuestions(JSON.parse(await fsp.readFile(path.join('bench', 'longmemeval', 'fixture.json'), 'utf8')))

test('normalizeQuestions：兼容数组与 {questions}，缺字段的题被丢弃', () => {
  assert.equal(qs.length, 3)
  const wrapped = normalizeQuestions({ questions: JSON.parse(JSON.stringify(qs.map((q) => ({ question_id: q.id, question: q.question, haystack_sessions: q.sessions, haystack_session_ids: q.sessionIds, answer_session_ids: [...q.gold] })))) })
  assert.equal(wrapped.length, 3)
  const bad = normalizeQuestions([{ question: 'x' }, { question: '', haystack_sessions: [[]], answer_session_ids: ['s1'] }])
  assert.equal(bad.length, 0, '没有会话或没有金标会话的题必须被跳过')
})

test('sessionToCard：turns 拼成正文，标题带会话号', () => {
  const c = sessionToCard([{ role: 'user', content: 'A' }, { role: 'assistant', content: 'B' }], 's9')
  assert.equal(c.title, '会话 s9')
  assert.match(c.body, /user: A/)
  assert.match(c.body, /assistant: B/)
})

test('端到端：每题独立库，金标会话能被题目召回且排名第 1', async () => {
  for (const q of qs) {
    const root = await makeScratchVault()
    tmpRoots.push(root)
    const map = await ingestQuestion(root, q)
    assert.equal(map.size, q.sessions.length, '每段会话都要落成一张卡')
    const r = await evalQuestion(root, q, { limit: 10 })
    assert.equal(r.rank, 1, `${q.id} 应命中金标会话`)
  }
})

test('summarize：R@5/R@10/MRR 与未命中统计正确', () => {
  const rows = [{ id: 'a', rank: 1 }, { id: 'b', rank: 3 }, { id: 'c', rank: 0 }]
  const s = summarize(rows)
  assert.equal(s.R5, +(2 / 3).toFixed(4))
  assert.equal(s.R10, +(2 / 3).toFixed(4))
  assert.equal(s.MRR, +((1 + 1 / 3) / 3).toFixed(4))
  assert.deepEqual(s.misses, ['c'])
})
