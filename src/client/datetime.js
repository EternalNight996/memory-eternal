// 卡片时间显示：一律按「运行环境本地时区」渲染（issue #55）。
//
// 为什么单独成模块：数据库 / frontmatter 里的 created/updated 是 UTC ISO 字符串
// （new Date().toISOString()）。旧代码在待审页直接 `c.created.slice(0, 16)`，
// 相当于把 UTC 墙钟当本地时间显示 —— 东八区实测「记忆库 22:49 / 待审 14:49」，
// 差整整一个时区。日期筛选同样拿 UTC 的 YYYY-MM-DD 跟 <input type=date> 的
// 本地日历日比，跨零点还会错一天。
//
// 这里不写死 +8，也不读配置：直接走 Date 的本地 getter，宿主进程 / 浏览器所在
// 系统的时区是什么就显示什么（用户要的「根据本地环境去配置」即此意）。

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const pad2 = (n) => String(n).padStart(2, '0')

/** 解析成 Date：纯日期按**本地**日历日理解（否则 JS 会当成 UTC 零点，跨时区偏一天）。非法返回 null。 */
export function toLocalDate(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const raw = String(value).trim()
  if (!raw) return null
  if (DATE_ONLY.test(raw)) {
    const [y, m, d] = raw.split('-').map(Number)
    const local = new Date(y, m - 1, d)
    return Number.isNaN(local.getTime()) ? null : local
  }
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

const dateKeyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const clockOf = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`

/** 本地日历日 YYYY-MM-DD（给日期筛选 / 分组用）。 */
export function localDateKey(value) {
  const d = toLocalDate(value)
  return d ? dateKeyOf(d) : ''
}

/** 本地完整时间 YYYY-MM-DD HH:mm（待审队列 / 判词栏用）。 */
export function localDateTime(value) {
  const d = toLocalDate(value)
  return d ? dateKeyOf(d) + ' ' + clockOf(d) : ''
}

/** 本地时分 HH:mm（卡片网格的短时间用）。 */
export function localClock(value) {
  const d = toLocalDate(value)
  return d ? clockOf(d) : ''
}
