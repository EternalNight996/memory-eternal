// 配置表单的「本地叠加」合并：消除保存后输入框先退回旧值、再跳回新值的闪烁。
//
// 背景：保存成功后客户端会重新拉取 /config，而宿主 volatile 回流可能滞后几百毫秒到几秒，
// 那一刻拉到的是旧值 —— 直接 setForm 就会看到「先退回原配置，再恢复到修改后配置」。
// 做法：把「刚保存过、宿主还没回显」的字段继续用本地值渲染；一旦宿主回显与本地一致就摘除。

/** 值比较（数组/对象按 JSON 比较，标量直接比）。 */
export function sameValue(a, b) {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return a === b
  if (typeof a !== 'object' && typeof b !== 'object') return a === b
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

/**
 * 合并：host 快照 + 本地叠加层。
 * @returns {{values: object, overlay: object}} values 用于渲染；overlay 是仍需保留的部分
 */
export function mergeLocalOverlay(host, overlay) {
  const values = { ...(host || {}) }
  const rest = {}
  for (const [k, v] of Object.entries(overlay || {})) {
    if (sameValue(host ? host[k] : undefined, v)) continue // 宿主已回显 → 摘除
    values[k] = v
    rest[k] = v
  }
  return { values, overlay: rest }
}
