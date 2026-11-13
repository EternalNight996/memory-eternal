#!/usr/bin/env node
/**
 * 知识类型回填：给现有卡打上 `知识类型:<中文>` / `knowledge-type:<code>` 标签。
 *
 * 为什么需要回填：识别逻辑（lib/card-types.js）是纯关键词纯函数，新卡在写入时能算，
 * 但库里已有的几千张不会自己变。这个脚本就是一次性补齐 + 以后随时可重跑（幂等）。
 *
 * 用法：
 *   node scripts/backfill-card-types.mjs                只统计（dry-run，默认）
 *   node scripts/backfill-card-types.mjs --yes          真写
 *   node scripts/backfill-card-types.mjs --yes --include-quarantine   连待审/回收站的卡一起
 *   node scripts/backfill-card-types.mjs --json
 */
import path from 'node:path'
import os from 'node:os'
import { getDb, closeAllDb } from '../lib/db.js'
import { knowledgeTypeOf, mergeTypeTags, KNOWLEDGE_TYPE_LABELS } from '../lib/card-types.js'

const A = new Set(process.argv.slice(2))
const YES = A.has('--yes')
const JSON_OUT = A.has('--json')
const WITH_Q = A.has('--include-quarantine')
const rootArg = process.argv.find((x) => x.startsWith('--vault='))
const VAULT = rootArg ? path.resolve(rootArg.slice('--vault='.length)) : path.join(os.homedir(), '.dsh', 'memory-vault')

const db = getDb(VAULT)
const out = { vault: VAULT, mode: YES ? 'write' : 'dry-run', tables: {}, samples: [], updated: 0, unchanged: 0, skipped: 0 }

function plan(table) {
  const rows = db.prepare(`SELECT id, path, kind, title, tags, substr(body,1,1200) AS body, source FROM ${table}`).all()
  const dist = new Map()
  const todo = []
  for (const r of rows) {
    const t = knowledgeTypeOf(r)
    if (!t.code) { out.skipped++; continue }
    dist.set(t.label, (dist.get(t.label) || 0) + 1)
    let tags = []
    try { tags = JSON.parse(r.tags || '[]') } catch { tags = [] }
    const merged = mergeTypeTags(tags, t.tags)
    const same = merged.length === tags.length && merged.every((x, i) => x === tags[i])
    if (same) { out.unchanged++; continue }
    todo.push({ id: r.id, path: r.path, title: r.title, tags: merged, label: t.label })
    if (out.samples.length < 12) out.samples.push({ kind: r.kind, title: r.title, label: t.label })
  }
  out.tables[table] = { rows: rows.length, distribution: Object.fromEntries([...dist.entries()].sort((a, b) => b[1] - a[1])) }
  return todo
}

const tasks = []
tasks.push(...plan('cards').map((x) => ({ ...x, table: 'cards' })))
if (WITH_Q) tasks.push(...plan('quarantine').map((x) => ({ ...x, table: 'quarantine' })))

out.pending = tasks.length
if (YES && tasks.length) {
  const stmt = db.prepare('UPDATE cards SET tags = ?, updated_at = ? WHERE id = ?')
  const stmtQ = db.prepare('UPDATE quarantine SET tags = ?, updated_at = ? WHERE id = ?')
  const now = new Date().toISOString()
  db.exec('BEGIN')
  try {
    for (const t of tasks) {
      const s = t.table === 'cards' ? stmt : stmtQ
      s.run(JSON.stringify(t.tags), now, t.id)
      out.updated++
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    out.error = String(e.message || e)
  }
}
closeAllDb()

if (JSON_OUT) {
  console.log(JSON.stringify(out, null, 1))
} else {
  console.log(`vault=${VAULT}  模式=${out.mode}`)
  for (const [table, v] of Object.entries(out.tables)) {
    console.log(`\n[${table}] ${v.rows} 张`)
    const total = Object.values(v.distribution).reduce((a, b) => a + b, 0)
    for (const [label, n] of Object.entries(v.distribution)) {
      const pct = total ? Math.round((n / total) * 100) : 0
      console.log('  ' + label.padEnd(10, ' ') + String(n).padStart(6, ' ') + '  ' + String(pct).padStart(3, ' ') + '%')
    }
  }
  console.log(`\n待写入 ${out.pending} · 已是最新 ${out.unchanged} · 跳过（无类型） ${out.skipped}`)
  if (!YES) console.log('（dry-run：没有改任何东西；确认真写加 --yes）')
  else console.log(`已写入 ${out.updated} 张` + (out.error ? ' · 错误：' + out.error : ''))
}
process.exit(out.error ? 1 : 0)
