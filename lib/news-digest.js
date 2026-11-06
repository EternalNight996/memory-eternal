// 记忆核心 · 关注摘要（News Digest）
//
// 定位：「关注」负责持续抓取，摘要负责**把结果压成一句话送给 Agent**。
// 送达通道复用插件的 systemPrompt 分段（与核心记忆同一机制），因此不需要新的宿主能力。
//
// 三条纪律：
//   1. **默认关闭**：这是会打扰人的功能，必须由用户显式开启（newsDigestEnabled）。
//   2. 只送「新东西」：generatedAt > consumedAt 才注入；一轮会话消费后立刻静默，不刷屏。
//   3. 本地可预览：配置页有「立即生成」，用户能在开启前先看到会推送什么。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { refreshFollows, followItems } from './news-follows.js'

const DIGEST_FILE = 'digest.json'

function digestPath(root) { return path.join(String(root || ''), 'news', DIGEST_FILE) }

export async function readDigest(root) {
  try { return JSON.parse(await fs.readFile(digestPath(root), 'utf8')) } catch { return null }
}

export async function writeDigest(root, digest) {
  const file = digestPath(root)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(digest, null, 2), 'utf8')
  await fs.rename(tmp, file)
  return digest
}

/**
 * 从关注结果里挑出摘要条目（纯函数，便于单测）。
 * 排序：热度优先（GitHub star / HN points），其次时间。
 */
export function pickDigestItems(items, { sinceMs = 0, maxItems = 5, seenUrls = [] } = {}) {
  const seen = new Set(Array.isArray(seenUrls) ? seenUrls : [])
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && it.url && !seen.has(it.url) && (!sinceMs || (Number(it.publishedAt) || 0) >= sinceMs))
    .slice()
    .sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0) || (Number(b.publishedAt) || 0) - (Number(a.publishedAt) || 0))
    .filter((it) => { if (seen.has(it.url)) return false; seen.add(it.url); return true })
    .slice(0, Math.max(1, Number(maxItems) || 5))
}

/**
 * 生成一份摘要快照并落盘。
 * @param {string} root vault
 * @param {{windowHours?:number,maxItems?:number,force?:boolean,now?:number}} opts
 */
export async function buildDigest(root, { windowHours = 24, maxItems = 5, force = false, now = Date.now() } = {}) {
  const follows = await refreshFollows(root, { force, now })
  const all = await followItems(root, follows)
  // 「新」的判定 = **没推送过**，而不是「刚发布」。
  // 为什么：GitHub 仓库的时间戳是创建时间，按 12/24 小时窗口筛会把它们全筛掉，
  // 于是「GitHub 热门」的摘要永远是空的。用 sentUrls 记账才符合"关注"的语义。
  const prev = await readDigest(root)
  const prevSent = Array.isArray(prev && prev.sentUrls) ? prev.sentUrls : []
  const picked = pickDigestItems(all, { maxItems, seenUrls: prevSent })
  // 关键：把**这一次扫到的全部 URL**记为已推送，而不是只记被挑中的那几条。
  // 否则每次摘要都会从积压里再掏 5 条 —— 那不叫"新内容"，叫"清库存"，用户会被反复骚扰。
  const sentUrls = [...new Set([...prevSent, ...all.map((it) => it.url)])].slice(-2000)
  const digest = {
    ok: true,
    generatedAt: now,
    consumedAt: 0,
    windowHours,
    maxItems,
    followCount: follows.length,
    scanned: all.length,
    sentUrls,
    items: picked.map((it) => ({
      title: it.title, url: it.url, source: it.source, followLabel: it.followLabel || '',
      points: Number(it.points) || 0, publishedAt: Number(it.publishedAt) || 0,
    })),
  }
  await writeDigest(root, digest)
  return digest
}

/** 标记「这一份已经进过一轮会话」，避免同一个摘要反复注入。 */
export async function consumeDigest(root, generatedAt) {
  const d = await readDigest(root)
  if (!d || Number(d.generatedAt) !== Number(generatedAt)) return null
  d.consumedAt = d.generatedAt
  await writeDigest(root, d)
  return d
}

/**
 * 生成注入文本。返回空串 = 本轮不注入。
 * 刻意要求 Agent「一两句话带过」：摘要是提醒，不是让模型把标题念一遍。
 */
export function digestPrompt(digest, { maxItems = 5 } = {}) {
  const items = Array.isArray(digest && digest.items) ? digest.items : []
  if (!items.length) return ''
  const top = items.slice(0, Math.max(1, Number(maxItems) || 5))
  const lines = top.map((it, i) => {
    const src = it.followLabel || it.source || '关注'
    const heat = it.points ? ' · ' + it.points : ''
    return (i + 1) + '. ' + it.title + '（' + src + heat + '）'
  })
  return [
    '【关注动态（记忆核心 · 新闻关注）】',
    '后台按你开启的「关注摘要」抓到了 ' + items.length + ' 条新内容：',
    ...lines,
    '请在本次回复开头用一两句话告诉用户「有哪些关注更新」，不要整段罗列标题；',
    '用户要看全部时再展开（新闻页有「关注动态」专区）。',
  ].join('\n')
}
