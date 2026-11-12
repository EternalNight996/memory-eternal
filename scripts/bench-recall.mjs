#!/usr/bin/env node
// 召回基准：在金标集上跑 search()，输出 R@5 / R@10 / MRR / Top1。
//
// 设计取舍：
//   · 直接 import 真实 search()，而不是另写一套检索 —— 否则测的不是线上行为。
//   · 只读快照库（--vault 指向拷贝目录），绝不写用户主库。
//   · 同时记录命中数与延迟，便于发现「优化后变慢」这类副作用。
//
// 用法：
//   node scripts/bench-recall.mjs --vault <快照目录> --golden bench/golden-recall.json --label baseline
// 输出：
//   bench/results/<label>.json + 控制台汇总表
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const home = process.env.USERPROFILE || process.env.HOME || '.'
const vault = path.resolve(opt('vault', path.join(home, '.dsh', 'memory-vault')))
const goldenPath = opt('golden', path.join('bench', 'golden-recall.json'))
const label = opt('label', 'run')
const limit = Number(opt('limit', 10))
const outDir = opt('outdir', path.join('bench', 'results'))
// 消融开关：同一份快照上对比「原始检索 / +停用词清洗 / +同义扩展」，不必切 git 版本。
const clean = !args.includes('--no-clean')
const expand = !args.includes('--no-expand')

const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))
const cases = golden.cases || []

// 延迟导入：确保 --vault 已经就位（search 不接收 root 以外的配置）。
const { search } = await import('../lib/vault.js')

// 预热：首次检索可能触发索引对账（每 5 分钟最多一次的全表 diff），
// 不预热会把一次 300–600ms 的对账算进延迟均值，p95 反而比均值小。
try { await search(vault, '预热', { limit: 1 }) } catch { /* 预热失败不影响主流程 */ }

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '')
const results = []
let hits5 = 0, hits10 = 0, rr = 0, top1 = 0, zero = 0
const lat = []

for (const c of cases) {
  const t0 = performance.now()
  let hits = []
  let err = ''
  try {
    hits = await search(vault, c.query, { limit, clean, expand })
  } catch (e) {
    err = String((e && e.message) || e)
  }
  const ms = performance.now() - t0
  lat.push(ms)
  const expected = new Set((c.expected || []).map(norm))
  let rank = 0
  for (let i = 0; i < hits.length; i++) {
    if (expected.has(norm(hits[i].path))) { rank = i + 1; break }
  }
  if (!hits.length) zero++
  if (rank === 1) top1++
  if (rank && rank <= 5) hits5++
  if (rank && rank <= 10) hits10++
  if (rank) rr += 1 / rank
  results.push({ id: c.id, kind: c.kind, query: c.query, expected: c.expected, rank, hits: hits.length, ms: Math.round(ms), top: hits.slice(0, 3).map((h) => ({ path: h.path, title: h.title, score: Math.round(h.score) })), err })
}

const n = results.length || 1
const pct = (x) => ((x / n) * 100).toFixed(1) + '%'
const sorted = [...lat].sort((a, b) => a - b)
const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0
const summary = {
  label, vault, golden: goldenPath, cases: n,
  cards: golden.cards, limit, clean, expand,
  R5: +(hits5 / n).toFixed(4), R10: +(hits10 / n).toFixed(4),
  MRR: +(rr / n).toFixed(4), Top1: +(top1 / n).toFixed(4),
  zeroHit: zero,
  latencyMs: { mean: +(lat.reduce((a, b) => a + b, 0) / n).toFixed(1), p95: +p95.toFixed(1) },
  byKind: {},
  at: new Date().toISOString(),
}
const kinds = [...new Set(results.map((r) => r.kind))]
for (const k of kinds) {
  const rs = results.filter((r) => r.kind === k)
  const ok5 = rs.filter((r) => r.rank && r.rank <= 5).length
  const ok1 = rs.filter((r) => r.rank === 1).length
  summary.byKind[k] = { n: rs.length, R5: +(ok5 / rs.length).toFixed(4), Top1: +(ok1 / rs.length).toFixed(4) }
}

mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, label + '.json')
writeFileSync(outFile, JSON.stringify({ summary, results }, null, 2))

console.log(`\n== ${label} ==  cases=${n}  cards=${golden.cards ?? '?'}  limit=${limit}`)
console.log(`R@5=${pct(hits5)}  R@10=${pct(hits10)}  MRR=${(rr / n).toFixed(3)}  Top1=${pct(top1)}  zeroHit=${zero}`)
console.log(`latency mean=${summary.latencyMs.mean}ms p95=${summary.latencyMs.p95}ms`)
for (const k of kinds) {
  const s = summary.byKind[k]
  console.log(`  ${k.padEnd(8)} n=${String(s.n).padStart(3)}  R5=${(s.R5 * 100).toFixed(1)}%  Top1=${(s.Top1 * 100).toFixed(1)}%`)
}
const misses = results.filter((r) => !r.rank).slice(0, 5)
if (misses.length) {
  console.log('\n未命中示例：')
  for (const m of misses) console.log(`  [${m.kind}] ${m.query}  -> 期望 ${m.expected[0]}`)
}
console.log('\n写出：' + outFile)
