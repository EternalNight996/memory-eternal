// 记忆核心 · 动态 / 新闻模块（用户自定义内容）
//
// 设计边界：
// - 新闻不是记忆卡：独立存在 <vault>/news/*.md，不进入 cards / quarantine，
//   不参与 memory_recall、知识星图、审核队列，避免污染记忆。
// - 内容完全由用户定义：标题、分类、来源、链接、标签、置顶、Markdown 正文。
// - 已读状态单独存 news/.state.json，不写进正文，方便直接编辑 Markdown。
//
// 文件格式：
//   ---
//   title: ...
//   date: 2026-10-30
//   category: 产品
//   source: GitHub
//   url: https://...
//   tags: [release, skill]
//   pinned: true
//   created: ...
//   updated: ...
//   ---
//   # 标题
//   正文…
import fs from 'node:fs/promises'
import path from 'node:path'
import { safeSlug, normalizeTags } from './vault.js'

const NEWS_DIR = 'news'
const STATE_FILE = '.state.json'
const MAX_BODY = 200000

function newsDir(root) { return path.join(root, NEWS_DIR) }
function statePath(root) { return path.join(newsDir(root), STATE_FILE) }

/** 只允许安全的文件名 id，绝不接受路径分隔符 / ..。 */
export function safeNewsId(id) {
  const s = String(id || '').trim()
  return /^[\w\u4e00-\u9fff.-]+$/.test(s) && !s.includes('..') ? s : ''
}

function yq(value) {
  const s = String(value == null ? '' : value)
  return /[:#\[\]{},&*!|>'"%@`\n]/.test(s) ? JSON.stringify(s) : s
}

function parseBool(v) { return /^(1|true|yes|on)$/i.test(String(v || '').trim()) }

/** 解析 news markdown（frontmatter + body）。 */
export function parseNews(text, fallbackId = '') {
  const raw = String(text || '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  const meta = {}
  let body = raw
  if (m) {
    body = raw.slice(m[0].length)
    for (const line of m[1].split(/\r?\n/)) {
      const eq = line.indexOf(':')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      meta[key] = value.replace(/^['"]|['"]$/g, '')
    }
  }
  const tags = String(meta.tags || '').replace(/^\[/, '').replace(/\]$/, '').split(',').map((x) => x.trim()).filter(Boolean)
  const title = String(meta.title || '').trim() || (body.match(/^#\s+(.+)$/m) || [])[1] || fallbackId || '未命名动态'
  return {
    id: fallbackId,
    title,
    date: String(meta.date || '').trim() || '',
    category: String(meta.category || '').trim() || '未分类',
    source: String(meta.source || '').trim(),
    url: String(meta.url || '').trim(),
    tags: normalizeTags(tags),
    pinned: parseBool(meta.pinned),
    cover: String(meta.cover || '').trim(),
    created: String(meta.created || '').trim(),
    updated: String(meta.updated || '').trim(),
    body: body.trim(),
  }
}

/** 序列化为可被人类直接编辑的 Markdown。 */
export function serializeNews(item) {
  const tags = normalizeTags(item.tags)
  const lines = [
    '---',
    'title: ' + yq(item.title),
    'date: ' + yq(item.date),
    'category: ' + yq(item.category),
    item.source ? 'source: ' + yq(item.source) : '',
    item.url ? 'url: ' + yq(item.url) : '',
    'tags: [' + tags.map(yq).join(', ') + ']',
    'pinned: ' + (item.pinned ? 'true' : 'false'),
    item.cover ? 'cover: ' + yq(item.cover) : '',
    'created: ' + yq(item.created),
    'updated: ' + yq(item.updated),
    '---',
    '',
    '# ' + item.title,
    '',
    item.body.trim(),
    '',
  ].filter((x) => x !== '')
  return lines.join('\n')
}

async function ensureDir(root) { await fs.mkdir(newsDir(root), { recursive: true }) }

async function readState(root) {
  try {
    const raw = await fs.readFile(statePath(root), 'utf8')
    const data = JSON.parse(raw)
    return data && typeof data === 'object' ? data : {}
  } catch { return {} }
}

async function writeState(root, state) {
  await ensureDir(root)
  await fs.writeFile(statePath(root), JSON.stringify(state, null, 2) + '\n', 'utf8')
}

function itemExcerpt(item) {
  return String(item.body || '').replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim().slice(0, 220)
}

function fromFile(root, file, text, state) {
  const id = file.replace(/\.md$/i, '')
  const item = parseNews(text, id)
  item.read = !!state[id]
  item.path = NEWS_DIR + '/' + file
  item.excerpt = itemExcerpt(item)
  return item
}

function matches(item, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return true
  const hay = [item.title, item.body, item.category, item.source, item.url, ...(item.tags || [])].join('\n').toLowerCase()
  return q.split(/\s+/).filter(Boolean).every((term) => hay.includes(term))
}

/**
 * 列出动态。
 * @returns {Promise<{items:Array, categories:string[], counts:{all:number, unread:number}}>}
 */
export async function listNews(root, { q = '', category = '', unreadOnly = false, limit = 500 } = {}) {
  await ensureDir(root)
  const state = await readState(root)
  const files = (await fs.readdir(newsDir(root))).filter((f) => /\.md$/i.test(f))
  const items = []
  for (const file of files) {
    try {
      const text = await fs.readFile(path.join(newsDir(root), file), 'utf8')
      const item = fromFile(root, file, text, state)
      if (!item.date) {
        try { item.date = (await fs.stat(path.join(newsDir(root), file))).mtime.toISOString().slice(0, 10) } catch { item.date = '' }
      }
      items.push(item)
    } catch { /* 单篇读取失败不影响列表 */ }
  }
  const categories = [...new Set(items.map((x) => x.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh'))
  const unread = items.filter((x) => !x.read).length
  let filtered = items
  if (category) filtered = filtered.filter((x) => x.category === category)
  if (unreadOnly) filtered = filtered.filter((x) => !x.read)
  filtered = filtered.filter((x) => matches(x, q))
  filtered.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const da = a.date || a.updated || a.created || ''
    const db = b.date || b.updated || b.created || ''
    return db.localeCompare(da) || String(b.updated || '').localeCompare(String(a.updated || ''))
  })
  const out = filtered.slice(0, limit).map((x) => {
    const { body, ...rest } = x
    return rest
  })
  return { items: out, categories, counts: { all: items.length, unread } }
}

/** 读取单篇完整正文。 */
export async function getNews(root, id) {
  const safe = safeNewsId(id)
  if (!safe) return null
  try {
    const text = await fs.readFile(path.join(newsDir(root), safe + '.md'), 'utf8')
    const state = await readState(root)
    return fromFile(root, safe + '.md', text, state)
  } catch { return null }
}

/**
 * 新建 / 更新动态。
 * @returns {Promise<{ok:true,item:object}|{ok:false,error:string}>}
 */
export async function saveNews(root, input = {}) {
  const title = String(input.title || '').trim().slice(0, 200)
  const body = String(input.body || '').trim().slice(0, MAX_BODY)
  if (!title) return { ok: false, error: '标题不能为空' }
  if (!body) return { ok: false, error: '正文不能为空' }
  await ensureDir(root)
  const now = new Date().toISOString()
  const date = String(input.date || '').trim().slice(0, 10) || now.slice(0, 10)
  let id = safeNewsId(input.id)
  let created = String(input.created || '').trim()
  let old = null
  if (id) {
    try { old = parseNews(await fs.readFile(path.join(newsDir(root), id + '.md'), 'utf8'), id) } catch { old = null }
    if (!old) return { ok: false, error: '动态不存在' }
    created = old.created || created || now
  } else {
    const base = date + '-' + safeSlug(title)
    id = base
    let n = 2
    while (await exists(path.join(newsDir(root), id + '.md'))) { id = base + '-' + n; n++ }
    created = created || now
  }
  const item = {
    id,
    title,
    date,
    category: String(input.category || '').trim().slice(0, 40) || '未分类',
    source: String(input.source || '').trim().slice(0, 80),
    url: String(input.url || '').trim().slice(0, 1000),
    tags: normalizeTags(input.tags),
    pinned: !!input.pinned,
    cover: String(input.cover || '').trim().slice(0, 500),
    created,
    updated: now,
    body,
  }
  await fs.writeFile(path.join(newsDir(root), id + '.md'), serializeNews(item), 'utf8')
  return { ok: true, item: { ...item, read: false, path: NEWS_DIR + '/' + id + '.md', excerpt: itemExcerpt(item) } }
}

async function exists(file) { try { await fs.access(file); return true } catch { return false } }

/** 删除动态（同时清掉已读状态）。 */
export async function deleteNews(root, id) {
  const safe = safeNewsId(id)
  if (!safe) return { ok: false, error: '无效的动态 id' }
  try { await fs.unlink(path.join(newsDir(root), safe + '.md')) } catch { return { ok: false, error: '动态不存在' } }
  const state = await readState(root)
  if (state[safe]) { delete state[safe]; try { await writeState(root, state) } catch { /* 状态清理失败不影响删除 */ } }
  return { ok: true, id: safe }
}

/** 标记已读 / 未读。 */
export async function setNewsRead(root, id, read = true) {
  const safe = safeNewsId(id)
  if (!safe) return { ok: false, error: '无效的动态 id' }
  try { await fs.access(path.join(newsDir(root), safe + '.md')) } catch { return { ok: false, error: '动态不存在' } }
  const state = await readState(root)
  if (read) state[safe] = new Date().toISOString()
  else delete state[safe]
  await writeState(root, state)
  return { ok: true, id: safe, read: !!read }
}
