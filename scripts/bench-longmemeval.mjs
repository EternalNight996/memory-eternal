#!/usr/bin/env node
// LongMemEval-S 风格检索评测入口。
//
// 用法：
//   node scripts/bench-longmemeval.mjs --data <longmemeval_s.json> --label lme
//   node scripts/bench-longmemeval.mjs --data bench/longmemeval/fixture.json --label fixture
//
// 说明：
//   · 数据集不随仓库分发；fixture 只用于验证流水线，不代表真实分数。
//   · 每题独立临时库（haystack 是每题一套会话），跑完自动清理。
//   · 只报检索 R@5/R@10/MRR；QA 需要固定 answer model + judge，另跑。
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { normalizeQuestions, makeScratchVault, evalQuestion, summarize } from '../lib/eval-longmemeval.js'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const dataPath = opt('data', path.join('bench', 'longmemeval', 'fixture.json'))
const label = opt('label', 'lme')
const limit = Number(opt('limit', 10))
const maxQuestions = Number(opt('questions', 0)) || 0
const typeFilter = opt('type', '')
const embed = args.includes('--embed')
const outDir = opt('outdir', path.join('bench', 'results'))

const raw = JSON.parse(readFileSync(dataPath, 'utf8'))
let questions = normalizeQuestions(raw)
if (typeFilter) questions = questions.filter((q) => q.type === typeFilter)
// 均匀抽样（不是取前 N）：避免题目按类型扎堆，保证子集可代表全集
if (maxQuestions > 0 && questions.length > maxQuestions) {
  const step = questions.length / maxQuestions
  questions = Array.from({ length: maxQuestions }, (_, i) => questions[Math.floor(i * step)])
}
if (!questions.length) {
  console.error('数据集为空或字段不匹配（需要 question + haystack_sessions + answer_session_ids）')
  process.exit(1)
}

const rows = []
const started = Date.now()
for (const q of questions) {
  const root = await makeScratchVault()
  try {
    const r = await evalQuestion(root, q, { limit, embed })
    rows.push(r)
    console.log(`${r.rank ? 'HIT  ' : 'MISS '} ${r.id} rank=${r.rank} sessions=${r.sessions} hits=${r.hits}`)
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
  }
}

const summary = { label, data: dataPath, limit, ...summarize(rows), ms: Date.now() - started, at: new Date().toISOString() }
mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'lme-' + label + '.json')
writeFileSync(outFile, JSON.stringify({ summary, rows }, null, 2))

console.log(`\n== ${label} == questions=${summary.questions}  R@5=${(summary.R5 * 100).toFixed(1)}%  R@10=${(summary.R10 * 100).toFixed(1)}%  MRR=${summary.MRR}`)
if (summary.misses.length) console.log('未命中：' + summary.misses.join(', '))
console.log('写出：' + outFile)
console.log('注意：fixture 仅验证流水线；真实分数需用 LongMemEval-S 原数据集跑。')
