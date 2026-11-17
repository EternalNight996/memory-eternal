#!/usr/bin/env node
// FTS 索引维护：检查 / 重建 cards_fts。
//
// 为什么需要手动这一步：索引只在**写卡时**逐条维护（indexCardById / unindexCard）。
// 存量卡经由批量导入、Markdown 迁移、或旧版本升级进来的，不会被自动补进 cards_fts；
// search-index.js 里的 ensureIndex 目前没有调用点。索引缺失时召回会静默退到
// 「全表扫描 + 子串计数」兜底 —— 功能还在，但没有 IDF/BM25，命中会明显变差。
//
// 用法：
//   node scripts/reindex-fts.mjs                 # 只检查，报告索引覆盖率
//   node scripts/reindex-fts.mjs --force         # 重建全量索引
//   node scripts/reindex-fts.mjs --vault "D:\vault" --force
//
// 安全性：只写 cards_fts / _fts_rows 两张表，不动 cards 与 quarantine；重建期间
// 召回可能短暂看到部分索引，完成后立即恢复正常。

import path from 'node:path'
import os from 'node:os'
import { performance } from 'node:perf_hooks'

import { getDb } from '../lib/db.js'
import { reindexAll, ensureIndex, indexStats } from '../lib/search-index.js'

const argv = process.argv.slice(2)
const opt = (name, def) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const home = process.env.USERPROFILE || process.env.HOME || '.'
const vault = path.resolve(opt('vault', path.join(home, '.dsh', 'memory-vault')))
const force = argv.includes('--force')

const db = getDb(vault)
const before = indexStats(db)
const missing = Math.max(0, before.cards - before.indexed)
console.log('库目录：' + vault)
console.log('已批准卡：' + before.cards + '　已索引：' + before.indexed + '　缺：' + missing)

if (!force) {
  if (missing > 0) {
    console.log('\n索引不完整 —— 现在召回走的是全表兜底扫描（无 IDF/BM25，命中质量下降）。')
    console.log('重建：node scripts/reindex-fts.mjs --force')
  } else {
    console.log('\n索引完整，无需重建。')
  }
  process.exit(0)
}

const t0 = performance.now()
const r = reindexAll(db, { force: true })
const ms = performance.now() - t0
ensureIndex(db)
const after = indexStats(db)
console.log('\n重建完成：indexed=' + r.indexed + ' 用时 ' + ms.toFixed(0) + ' ms')
console.log('复检：已批准卡 ' + after.cards + '　已索引 ' + after.indexed + (after.cards === after.indexed ? '　✓ 一致' : '　✗ 仍不一致'))
