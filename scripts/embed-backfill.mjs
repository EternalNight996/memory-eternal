#!/usr/bin/env node
// 为可选语义召回补齐向量缓存。
//
// 用法：
//   MEMORY_EMBED_BASE_URL=https://api.openai.com/v1 \
//   MEMORY_EMBED_MODEL=text-embedding-3-small \
//   MEMORY_EMBED_KEY=sk-... \
//   node scripts/embed-backfill.mjs --vault <vault 目录> [--limit 5000]
//
// 说明：
//   · 只读卡片、只写 card_vec 缓存；不改卡片正文/状态。
//   · 换模型后旧向量保留但不再参与召回（检索按 model 过滤），重跑本脚本即重算。
//   · 失败会照常抛错退出，不会留下半批数据（每批事务）。
import path from 'node:path'
import { embeddingSettings, backfill, vectorStats } from '../lib/embeddings.js'
import { readEmbeddingConfig } from '../lib/embedding-config.js'
import { closeAllDb } from '../lib/db.js'

const args = process.argv.slice(2)
const opt = (name, def) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const home = process.env.USERPROFILE || process.env.HOME || '.'
const root = opt('vault', path.join(home, '.dsh', 'memory-vault'))
const limit = Number(opt('limit', 5000))
const batch = Math.min(32, Math.max(1, Number(opt('batch', 16))))

// 优先用界面保存的配置（enabled=true），其次环境变量
const saved = readEmbeddingConfig(process.env)
const cfg = (saved.enabled && saved.baseUrl && saved.model)
  ? { baseUrl: saved.baseUrl.replace(/\/+$/, ''), apiKey: saved.apiKey || '', model: saved.model }
  : embeddingSettings()
if (!cfg) {
  console.error('未配置 embedding：在「设置 → 记忆 → 语义召回（可选）」里开启，或设置 MEMORY_EMBED_BASE_URL + MEMORY_EMBED_MODEL')
  process.exit(2)
}

console.log(`vault=${root}`)
console.log(`model=${cfg.model} base=${cfg.baseUrl}`)
const before = vectorStats(root, cfg.model)
console.log(`已有向量 ${before.vectors}/${before.cards}`)

let embedded = 0
try {
  const r = await backfill(root, cfg, {
    limit, batch,
    onProgress: (done, total) => { embedded = done; console.log(`  ${done}/${total}`) },
  })
  console.log(`本次补齐 ${r.embedded} 条，剩余未补 ${r.remaining} 条（可用 --limit 再跑）`)
} finally {
  closeAllDb()
}
const after = vectorStats(root, cfg.model)
console.log(`现在向量 ${after.vectors}/${after.cards}`)
