#!/usr/bin/env node
// 记忆核心 · 检索延迟基准（用户可自行复跑，不接受"我们很快"这种空话）
//
// 用法：
//   node scripts/bench-search.mjs                      # 默认 ~/.dsh/memory-vault
//   node scripts/bench-search.mjs --vault <DIR>        # 指定库
//   node scripts/bench-search.mjs --rounds 5           # 每个查询跑几轮（默认 5）
//   node scripts/bench-search.mjs --rebuild            # 先全量重建索引，报出重建耗时
//
// 输出：卡片数、索引条数、p50 / p95 / max 延迟、QPS 估算。
// 为什么要有它：README 里的性能数字必须能被人现场复核，否则就是营销。
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const args = process.argv.slice(2)
const opt = (name, def = '') => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] ?? def) : def }
const flag = (name) => args.includes('--' + name)

const vault = opt('vault') || process.env.MEMORY_VAULT_DIR
  || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'memory-vault')
const rounds = Math.max(1, Number(opt('rounds', '5')) || 5)

if (!fs.existsSync(vault)) {
  console.error('找不到记忆库：' + vault + '（用 --vault 指定）')
  process.exit(1)
}

const { search } = await import('../lib/vault.js')
const { reindexAll, indexStats } = await import('../lib/search-index.js')
const { getDb } = await import('../lib/db.js')

const db = getDb(vault)
if (flag('rebuild')) {
  const t0 = Date.now()
  reindexAll(db)
  console.log('全量重建索引：' + (Date.now() - t0) + 'ms')
}

const st = indexStats(db)
// 固定查询集：混合中英、长词、短词、专有名词，避免只挑"快的那几个"
const queries = [
  '检索 索引', '审核 红线', '回收站 清空', '作者语录', '新闻 关注', '发布 版本',
  '数据库 选型', '记忆 架构', '插件 安装', '异常 排查', 'token 成本', '知识图谱 性能',
  '审核 中心', '技能卡', 'FTS5 索引', '缓存 一致性', '配置 同步', '新闻 源', '摘要 推送', 'GitHub 热门',
]

const samples = []
for (const q of queries) {
  for (let i = 0; i < rounds; i++) {
    const t = process.hrtime.bigint()
    await search(vault, q, { limit: 5 })
    samples.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
}
samples.sort((a, b) => a - b)
const at = (p) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]
const total = samples.reduce((a, b) => a + b, 0)

console.log('库路径        : ' + vault)
console.log('卡片 / 索引   : ' + st.cards + ' / ' + st.indexed)
console.log('查询 × 轮次   : ' + queries.length + ' × ' + rounds + ' = ' + samples.length + ' 次')
console.log('p50 / p95 / max: ' + at(0.5).toFixed(2) + 'ms / ' + at(0.95).toFixed(2) + 'ms / ' + samples[samples.length - 1].toFixed(2) + 'ms')
console.log('平均 / QPS    : ' + (total / samples.length).toFixed(2) + 'ms / ' + Math.round(1000 / (total / samples.length)) + ' 次/秒')
