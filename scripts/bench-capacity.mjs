#!/usr/bin/env node
// 容量基准：回答「卡片变多之后，召回会不会变慢 / 注入会不会变多」。
//
// 与 scripts/bench-recall.mjs 的分工：
//   · bench-recall.mjs   —— 检索**质量**（金标集上的 R@5 / R@10 / MRR / Top1），要 --vault 快照
//   · bench-capacity.mjs —— 检索**容量**（耗时随卡片数怎么长、注入字符是否恒定），自带合成库
//
// 用法：
//   node scripts/bench-capacity.mjs                  # 默认 200,1000,2000,5000
//   node scripts/bench-capacity.mjs 500,5000,20000   # 自定义规模
//   node scripts/bench-capacity.mjs 2000 --keep      # 保留临时库以便排查
//
// 做法：在系统临时目录造 N 张合成卡（正文约 1600 字，接近真实卡），建 FTS5 索引与随机向量
// （dim=768）后分别计三段：
//   1) FTS/BM25 主路径    searchIndexed(limit=80)
//   2) 向量打分          读全表 card_vec + cosine（等价 denseSearch 的打分主体）
//   3) 端到端             vault.search(limit=5, minScore=2)，即 memory_recall 的真实入口
// 同时统计「单次召回注入字符」—— 这是 agent 上下文会不会被撑爆的直接指标。
//
// 全程只写系统临时目录，不读也不写真库。

import { mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

import { getDb } from '../lib/db.js'
import { reindexAll, searchIndexed } from '../lib/search-index.js'
import { ensureVecTable, cosine } from '../lib/embeddings.js'
import { search } from '../lib/vault.js'

const DIM = 768
const WORDS = ['缓存', '审核', '召回', '索引', '向量', '端口', '令牌', '插件', '宿主机', '蒸馏', '幂等', '回滚',
  '并发', '超时', '注入', '优先级', '日志', '备份', '迁移', '阈值', '语义', '查询', '排序', '限额',
  '脚本', '配置', '协议', '权限', '会话', '上下文']
const QUERIES = ['npm 发布 403 账号冷却', '数据库选型 SQLite FTS5', 'Ollama bge-m3 语义召回',
  'DSH 插件 权限 注册', '审核 红线 卡片 批准', '端口 冲突 多实例']

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const sizes = String(argv.find((a) => !a.startsWith('--')) || '200,1000,2000,5000')
  .split(',').map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0)

const rand = (n) => Math.floor(Math.random() * n)
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const toBuf = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength)
const toFloat = (blob) => {
  const b = Buffer.from(blob); const ab = new ArrayBuffer(b.length)
  new Uint8Array(ab).set(b); return new Float32Array(ab)
}
function body(i) {
  const parts = []
  while (parts.join(' ').length < 1600) parts.push(WORDS[rand(WORDS.length)] + '#' + ((i * 31 + parts.length * 7) % 400))
  return parts.join(' ')
}
/** 复刻 index.js 里 memory_recall 的输出拼装：limit=5、每条 summary 截 130 字。 */
function renderRecall(hits, defLen = 130) {
  const lines = hits.map((h, i) => {
    const tags = h.tags && h.tags.length ? ' [' + h.tags.join(', ') + ']' : ''
    const snippet = String(h.summary || '').replace(/\s+/g, ' ').trim().slice(0, defLen)
    return '### ' + (i + 1) + '. ' + h.title + tags + '\n路径：' + h.path + '\n' + snippet
  })
  return '从记忆核心检索到 ' + hits.length + ' 条相关卡片：\n\n' + lines.join('\n\n')
}

const rows = []
for (const N of sizes) {
  const root = path.join(os.tmpdir(), 'me-capacity-' + N + '-' + process.pid)
  mkdirSync(root, { recursive: true })
  const db = getDb(root)

  const ins = db.prepare('INSERT INTO cards(path,title,body,summary,status) VALUES(?,?,?,?,?)')
  db.exec('BEGIN')
  for (let i = 0; i < N; i++) {
    ins.run('bench/card-' + i + '.md', WORDS[i % WORDS.length] + ' 卡 ' + i, body(i), WORDS[i % WORDS.length] + ' 结论 ' + i + ' 的取舍与证据', 'approved')
  }
  db.exec('COMMIT')
  reindexAll(db, { force: true })

  ensureVecTable(db)
  const vins = db.prepare("INSERT OR REPLACE INTO card_vec(id,path,model,dim,vec,updated_at) VALUES(?,?,?,?,?,datetime('now'))")
  db.exec('BEGIN')
  for (const r of db.prepare('SELECT id FROM cards').all()) {
    const v = new Float32Array(DIM)
    for (let k = 0; k < DIM; k++) v[k] = Math.random() * 2 - 1
    vins.run(r.id, 'bench', 'bge-m3', DIM, toBuf(v))
  }
  db.exec('COMMIT')

  const fts = []
  for (const q of QUERIES) for (let rep = 0; rep < 3; rep++) {
    const t = performance.now()
    searchIndexed(db, q, { limit: 80 })
    fts.push(performance.now() - t)
  }

  const dvec = []; let readBytes = 0
  const qv = new Float32Array(DIM)
  for (let k = 0; k < DIM; k++) qv[k] = Math.random()
  for (const q of QUERIES) for (let rep = 0; rep < 2; rep++) {
    const t = performance.now()
    const all = db.prepare('SELECT id, vec FROM card_vec WHERE model = ?').all('bge-m3')
    const scored = []
    for (const r of all) { readBytes = r.vec.length * all.length; scored.push(cosine(qv, toFloat(r.vec))) }
    scored.sort((a, b) => b - a)
    dvec.push(performance.now() - t)
  }

  const e2e = []; let injectChars = 0
  for (const q of QUERIES) for (let rep = 0; rep < 2; rep++) {
    const t = performance.now()
    const hits = await search(root, q, { limit: 5, minScore: 2 })
    e2e.push(performance.now() - t)
    if (rep === 0) injectChars = Math.max(injectChars, renderRecall(hits).length)
  }

  const corpus = Number(db.prepare('SELECT SUM(length(body)) s FROM cards').get().s || 0)
  rows.push({ N, fts: median(fts), vec: median(dvec), e2e: median(e2e), readMB: readBytes / 1048576, injectChars, corpus })

  db.close?.()
  if (!keep) { try { rmSync(root, { recursive: true, force: true }) } catch {} }
  else console.log('# kept: ' + root)
}

const f = (n, d = 2) => n.toFixed(d)
console.log('')
console.log('| 卡片数 | FTS/BM25 | 向量打分 | 端到端 search | 向量读入 | 单次召回注入字符 | 全库正文 |')
console.log('|---|---|---|---|---|---|---|')
for (const r of rows) {
  console.log('| ' + r.N + ' | ' + f(r.fts) + ' ms | ' + f(r.vec) + ' ms | ' + f(r.e2e) + ' ms | '
    + f(r.readMB, 1) + ' MB | ' + r.injectChars + ' 字 | ' + f(r.corpus / 1e6, 2) + ' M 字 |')
}
console.log('')
console.log('读法：前两列随卡片数增长（词法亚线性、向量线性），第六列「注入字符」才是上下文成本 ——')
console.log('它由 recallLimit(默认 5) × recallSummaryLen(默认 130) 决定，与库规模无关。')
