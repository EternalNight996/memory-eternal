#!/usr/bin/env node
// 实验：偏好类查询的 HyDE 改写（本地小模型写一段“假设的记忆片段”，与原查询合并检索）。
// 用法：node scripts/exp-hyde-pref.mjs --type single-session-preference --questions 30
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { normalizeQuestions, makeScratchVault, ingestQuestion } from '../lib/eval-longmemeval.js'
import { search } from '../lib/vault.js'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const dataPath = opt('data', path.join('bench', 'longmemeval', 'longmemeval_s_cleaned.json'))
const type = opt('type', 'single-session-preference')
const maxQ = Number(opt('questions', 30))
const base = String(opt('base', 'http://127.0.0.1:7997/v1')).replace(/\/+$/, '')
const model = opt('model', 'qwen2.5:1.5b')

const data = JSON.parse(readFileSync(dataPath, 'utf8'))
let qs = normalizeQuestions(data).filter((q) => q.type === type)
if (qs.length > maxQ) { const step = qs.length / maxQ; qs = Array.from({ length: maxQ }, (_, i) => qs[Math.floor(i * step)]) }

async function chat(system, user, maxTokens = 120) {
  const res = await fetch(base + '/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.3, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const d = await res.json()
  return String(d?.choices?.[0]?.message?.content || '').trim()
}

let hit5 = 0, hit10 = 0, mrr = 0
for (const q of qs) {
  const root = await makeScratchVault()
  try {
    const pathToSession = await ingestQuestion(root, q)
    const orig = await search(root, q.question, { limit: 10 })
    let hypo = ''
    try {
      hypo = await chat('You write a short hypothetical past chat snippet (2 sentences, English) that this user might have had, relevant to the question. No explanation.', q.question)
    } catch { hypo = '' }
    let extra = []
    if (hypo) extra = await search(root, hypo.slice(0, 400), { limit: 10 })
    const seen = new Set(orig.map((h) => h.path))
    const merged = [...orig, ...extra.filter((h) => !seen.has(h.path))]
    let rank = 0
    for (let i = 0; i < merged.length; i++) {
      const sid = pathToSession.get(merged[i].path)
      if (sid && q.gold.has(String(sid))) { rank = i + 1; break }
    }
    if (rank && rank <= 5) hit5++
    if (rank && rank <= 10) hit10++
    mrr += rank ? 1 / rank : 0
    console.log(`${rank ? 'HIT ' : 'MISS'} ${q.id} rank=${rank} hypo=${hypo.slice(0, 60).replace(/\n/g, ' ')}`)
  } finally {
    const { rmSync } = await import('node:fs')
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows */ }
  }
}
const n = qs.length || 1
console.log(`\nHyDE preference: n=${n} R@5=${(hit5 / n * 100).toFixed(1)}% R@10=${(hit10 / n * 100).toFixed(1)}% MRR=${(mrr / n).toFixed(3)}`)
