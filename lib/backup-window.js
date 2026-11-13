// 备份时间窗计算（**零依赖**）。
//
// 为什么单独一个文件：`lib/api.js` 为了拿 `nextBackupAt` 曾经 `await import('../index.js')`，
// 而 index.js 是 DSH 插件入口、静态依赖 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-tools`
// （宿主专有）。结果：**云端部署（不带 DSH 宿主）一调 /backup/status 就 500**
// `Cannot find package '@deepseek-ai/schemastery'`。
//
// 现在这里是纯函数模块，插件与云端都能用，谁也不拖累谁。

/**
 * 下一次备份的时间点：**落在备份时间窗内**（默认每天 03:00），而不是「上次 + 周期」。
 * 面板显示「下次备份 10:57」是错的 —— 那个时刻窗口外根本不会动手。
 * @param {{lastAt?:number, intervalHours?:number, windowStart?:number}} p
 * @param {number} now
 * @returns {number} 时间戳
 */
export function nextBackupAt({ lastAt = 0, intervalHours = 24, windowStart = 3 } = {}, now = Date.now()) {
  const hours = Math.max(1, Math.min(Math.floor(Number(intervalHours) || 24), 24 * 365))
  const winStart = Math.max(0, Math.min(23, Math.floor(Number(windowStart ?? 3))))
  const last = Number(lastAt) > 0 ? Number(lastAt) : 0
  // 每天一次时：今天窗口还没过、且今天还没备过 → 今天的窗口；否则明天的窗口
  const todayWin = new Date(now)
  todayWin.setHours(winStart, 0, 0, 0)
  if (hours <= 24) {
    const busyToday = last > 0 && new Date(last).toDateString() === new Date(now).toDateString()
    if (!busyToday && todayWin.getTime() > now) return todayWin.getTime()
    const next = new Date(todayWin)
    next.setDate(next.getDate() + 1)
    // 每天一次：今天备过就明天备，不再叠加「距上次够 24h」的额外顺延
    return next.getTime()
  }
  const earliest = last > 0 ? last + hours * 3600000 : now
  const d = new Date(earliest)
  d.setHours(winStart, 0, 0, 0)
  if (d.getTime() < earliest) d.setDate(d.getDate() + 1)
  return d.getTime()
}
