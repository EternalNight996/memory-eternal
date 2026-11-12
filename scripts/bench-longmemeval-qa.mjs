#!/usr/bin/env node
// LongMemEval 端到端 QA（检索 → 答题 → 判定），本地模型版。
//
// 用法：
//   node scripts/bench-longmemeval-qa.mjs --data bench/longmemeval/longmemeval_s_cleaned.json \
//     --questions 30 --k 5 --answer-model qwen2.5:1.5b --judge-model qwen2.5:1.5b
//
// 注意：这是**非官方口径**——answer/judge 都是本地小模型，仅用于自测回归；
// 与论文/GPT-4o judge 的分数不可直接比较。官方口径需固定 answer model + GPT-4o judge。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { normalizeQuestions, makeScratchVault, ingestQuestion } from '../lib/eval-longmemeval.js'
import { search, readCard } from '../lib/vault.js'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const dataPath = opt('data', path.join('bench', 'longmemeval', 'fixture.json'))
const label = opt('label', 'qa')
const maxQ = Number(opt('questions', 20))
const k = Math.max(1, Number(opt('k', 5)))
const base = String(opt('base', process.env.MEMORY_QA_BASE_URL || 'http://127.0.0.1:7997/v1')).replace(/\/+$/, '')
const answerModel = opt('answer-model', process.env.MEMORY_QA_ANSWER_MODEL || 'qwen2.5:1.5b')
const judgeModel = opt('judge-model', process.env.MEMORY_QA_JUDGE_MODEL || answerModel)
const typeFilter = opt('type', '')

const raw = JSON.parse(readFileSync(dataPath, 'utf8'))
let questions = normalizeQuestions(raw)
if (typeFilter) questions = questions.filter((q) => q.type === typeFilter)
if (maxQ > 0 && questions.length > maxQ) {
  const step = questions.length / maxQ
  questions = Array.from({ length: maxQ }, (_, i) => questions[Math.floor(i * step)])
}

async function chat(model, system, user, { maxTokens = 256 } = {}) {
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  })
  if (!res.ok) throw new Error('chat HTTP ' + res.status)
  const d = await res.json()
  return String(d?.choices?.[0]?.message?.content || '').trim()
}

function sessionText(q, sid) {
  const i = q.sessionIds.indexOf(sid)
  const s = i >= 0 ? q.sessions[i] : null
  if (!Array.isArray(s)) return ''
  return s.map((t) => `${t.role || 'x'}: ${t.content ?? ''}`).join('\n')
}

const rows = []
for (const q of questions) {
  const root = await makeScratchVault()
  try {
    const pathToSession = await ingestQuestion(root, q)
    const hits = await search(root, q.question, { limit: k })
    const ctxParts = []
    for (const h of hits) {
      const sid = pathToSession.get(h.path)
      const text = sid ? sessionText(q, sid) : ''
      if (text) ctxParts.push(text)
    }
    const ctx = ctxParts.join('\n\n---\n\n').slice(0, 12000)
    let pred = ''
    try {
      pred = await chat(answerModel, 'You answer questions using only the provided memory context. If the context does not contain the answer, say "I don\'t know". Be concise.', `Context:\n${ctx}\n\nQuestion: ${q.question}\nAnswer:`)
    } catch { pred = '' }
    let ok = false
    try {
      const verdict = await chat(judgeModel, 'You are a strict grader. Given a question, the correct answer, and a model answer, decide if the model answer is correct (semantically equivalent). Reply with exactly YES or NO.', `Question: ${q.question}\nCorrect answer: ${q.answer}\nModel answer: ${pred}\nVerdict:`)
      ok = /yes/i.test(verdict.slice(0, 20))
    } catch { ok = false }
    rows.push({ id: q.id, type: q.type, correct: ok, pred: pred.slice(0, 240), gold: q.answer, hits: hits.length })
    console.log(`${ok ? 'OK  ' : 'MISS'} ${q.id} [${q.type}] hits=${hits.length} pred=${pred.slice(0, 80).replace(/\n/g, ' ')}`)
  } finally {
    try { const { rmSync } = await import('node:fs'); rmSync(root, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
  }
}

const n = rows.length || 1
const acc = rows.filter((r) => r.correct).length / n
const byType = {}
for (const r of rows) {
  byType[r.type] = byType[r.type] || { n: 0, ok: 0 }
  byType[r.type].n++
  if (r.correct) byType[r.type].ok++
}
const outDir = path.join('bench', 'results')
mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'lme-qa-' + label + '.json')
writeFileSync(outFile, JSON.stringify({ label, data: dataPath, questions: rows.length, k, answerModel, judgeModel, accuracy: acc, byType, rows }, null, 2))
console.log(`\n== ${label} == questions=${rows.length} QA_acc=${(acc * 100).toFixed(1)}% (local judge: 非官方口径)`)
for (const [t, g] of Object.entries(byType)) console.log(`  ${t}: ${g.ok}/${g.n} = ${(g.ok / g.n * 100).toFixed(1)}%`)
console.log('写出：' + outFile)
