#!/usr/bin/env node
// 从卡片标题/标签共现里挖关联词，写入 term_assoc。
// 用法：node scripts/mine-assoc.mjs --vault <vault 目录> [--min 3] [--top 3]
import path from 'node:path'
import { getDb, closeAllDb } from '../lib/db.js'
import { tokenize } from '../lib/search-index.js'
import { ensureAssocTable, assocStats } from '../lib/assoc.js'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const home = process.env.USERPROFILE || process.env.HOME || '.'
const root = opt('vault', path.join(home, '.dsh', 'memory-vault'))
const minN = Math.max(3, Number(opt('min', 5)))
const topN = Math.max(1, Number(opt('top', 2)))

const db = getDb(root)
ensureAssocTable(db)
const rows = db.prepare('SELECT title, tags FROM cards WHERE deleted_at IS NULL').all()
const STOP = new Set(['dsh', 'the', 'and', 'for', 'with', 'http', 'https', 'www', 'com', 'md'])
const df = new Map()
const pairs = new Map()
for (const row of rows) {
  const tags = (() => { try { return JSON.parse(row.tags || '[]') } catch { return [] } })()
  const raw = [row.title || '', ...(Array.isArray(tags) ? tags : [])].join(' ')
  const toks = [...new Set(tokenize(raw))].filter((t) => t.length >= 2 && !STOP.has(t.toLowerCase()) && !/^\d+$/.test(t))
  if (!toks.length) continue
  for (const t of toks) df.set(t, (df.get(t) || 0) + 1)
  for (let i = 0; i < toks.length; i++) {
    for (let j = i + 1; j < toks.length; j++) {
      const key = toks[i] + '\u0000' + toks[j]
      pairs.set(key, (pairs.get(key) || 0) + 1)
    }
  }
}
// 高频词（>3% 卡）不做关联：它们几乎和所有词共现，扩进来的全是噪声
const dfCap = Math.max(20, Math.floor(rows.length * 0.03))
const best = new Map()
for (const [key, n] of pairs) {
  if (n < minN) continue
  const [a, b] = key.split('\u0000')
  if ((df.get(a) || 0) > dfCap || (df.get(b) || 0) > dfCap) continue
  const strength = n / Math.max(1, Math.min(df.get(a) || 1, df.get(b) || 1))
  if (strength < 0.2) continue
  const score = n * strength
  for (const [x, y] of [[a, b], [b, a]]) {
    const list = best.get(x) || []
    list.push({ assoc: y, score, n })
    list.sort((p, q) => q.score - p.score)
    if (list.length > topN) list.length = topN
    best.set(x, list)
  }
}
db.exec('BEGIN')
try {
  db.prepare('DELETE FROM term_assoc').run()
  const ins = db.prepare('INSERT OR REPLACE INTO term_assoc(term, assoc, score, n) VALUES (?, ?, ?, ?)')
  for (const [term, list] of best) for (const r of list) ins.run(term, r.assoc, r.score, r.n)
  db.exec('COMMIT')
} catch (e) { try { db.exec('ROLLBACK') } catch { /* ignore */ } throw e }
const stats = assocStats(db)
console.log(`cards=${rows.length} vocab=${stats.vocab} pairs=${stats.terms}`)
closeAllDb()
