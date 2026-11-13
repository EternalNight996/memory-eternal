// 卡片内容哈希：把「O(n) 全量正文比对」换成「O(1) 索引命中」。
//
// 为什么需要：导入几万条时，原实现的去重是 `mainStoreBodies()` 把**主库全部正文**
// 读进内存，再对每条候选逐字比对。两万张卡 ≈ 几十 MB 常驻 + 每条约 O(n) 次比较，
// 导一次要几分钟，还容易触发内存压力。
//
// 有了 content_hash（sha256 前 16 位）：
//   · 完全相同的卡 → 一次 `WHERE content_hash = ?` 就命中，不必读正文
//   · 近似重复（改了几个字）→ 仍走原来的相似度算法，不退化
//
// 归一化只做「不会误判」的那几步：去首尾空白、统一换行、压掉行尾空格。
// **不**去标点、**不**小写化 —— 那会把语义不同的卡判成重复，属于逆优化。

import { createHash } from 'node:crypto'

/** 归一化正文：只做安全的空白处理，不动内容本身。 */
export function normalizeForHash(body) {
  return String(body || '')
    .replace(/\r\n?/g, '\n')       // 统一换行
    .replace(/[ \t]+$/gm, '')      // 行尾空白
    .replace(/\n{3,}/g, '\n\n')    // 连续空行压成一个空行
    .trim()
}

/**
 * 计算内容哈希（16 位十六进制）。
 * @param {string} title 标题
 * @param {string} body 正文
 * @returns {string} 空内容返回 ''（不参与去重，避免所有空卡互相撞）
 */
export function contentHash(title, body) {
  const t = String(title || '').trim()
  const b = normalizeForHash(body)
  if (!t && !b) return ''
  return createHash('sha256').update(t + '\n' + b, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 批量算哈希（导入时用，避免逐条建 hash 对象的开销）。
 * @param {Array<{title?:string, body?:string}>} cards
 * @returns {string[]}
 */
export function contentHashMany(cards) {
  return (cards || []).map((c) => contentHash(c && c.title, c && c.body))
}
