// 搜索命中片段：从正文里截出「关键词附近」的一小段（纯函数，便于单测）。
// 为什么单独抽出来：列表里只显示标题/摘要时，用户看不出「为什么命中」；片段 + 高亮能立刻解释。
export function snippetAround(text, q, radius = 48) {
  if (!q || !text) return ''
  const src = String(text)
  const lower = src.toLowerCase()
  const ql = String(q).toLowerCase()
  if (!ql) return ''
  const idx = lower.indexOf(ql)
  if (idx < 0) return ''
  const start = Math.max(0, idx - radius)
  const end = Math.min(src.length, idx + ql.length + radius)
  const body = src.slice(start, end).replace(/\s+/g, ' ').trim()
  return (start > 0 ? '…' : '') + body + (end < src.length ? '…' : '')
}
