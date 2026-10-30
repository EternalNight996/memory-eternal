// 审核中心的本地筛选：标题 / 摘要 / 原因 / 路径 / 标签 / 提交者。
// 与知识卡、星图的搜索体验保持一致：空格分隔多个词时按 AND 匹配，中文直接子串。
export function auditMatches(card, query) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return true
  const c = card || {}
  const tags = Array.isArray(c.tags) ? c.tags.map((x) => String(x)) : []
  const hay = [
    c.title, c.summary, c.reason, c.path, c.submittedBy,
    ...tags,
  ].map((x) => String(x || '')).join('\n').toLowerCase()
  return q.split(/\s+/).filter(Boolean).every((term) => hay.includes(term))
}
