// 「模型不守 JSON」的记忆（issue #47）。
//
// 现场：stepfun / step-api 这类模型会把蒸馏请求当聊天回（「已读取并理解以下技能约束…」），
// 解析失败 → 轮换下一个 provider。问题是不记录，于是**每轮对话都要先白烧一次调用**。
// 这里把「哪个 provider/model 最近连续不守格式」记下来，选路时把它们排到候选末尾
// （不删除：万一全都命中过，仍按原顺序兜底，绝不把自己饿死）。
import fs from 'node:fs'
import { configFilePath } from './capture-run.js'

/** 打击记录文件：与共享配置同目录（<config>.llm-strikes.json）。 */
export function strikesPath(env = process.env) {
  return String(configFilePath(env)).replace(/\.json$/i, '.llm-strikes.json')
}

/** 路由键：provider|model。 */
export function routeKey(route) {
  return String((route && route.provider) || '') + '|' + String((route && route.model) || '')
}

function readAll(env) {
  try {
    const d = JSON.parse(fs.readFileSync(strikesPath(env), 'utf8'))
    return d && typeof d === 'object' && d.strikes && typeof d.strikes === 'object' ? d.strikes : {}
  } catch { return {} }
}

/** 记一次「不守 JSON」。只保留最近 50 个路由，避免文件无限增长。 */
export function recordModelStrike(env, route, code = 'MODEL_NOT_JSON', now = Date.now()) {
  const key = routeKey(route)
  if (!key || key === '|') return null
  const all = readAll(env)
  const prev = all[key] && typeof all[key] === 'object' ? all[key] : { count: 0, at: 0 }
  all[key] = { count: (Number(prev.count) || 0) + 1, at: Number(now) || Date.now(), code: String(code || '') }
  const keys = Object.keys(all)
  if (keys.length > 50) {
    keys.sort((a, b) => (Number(all[a].at) || 0) - (Number(all[b].at) || 0))
    for (const k of keys.slice(0, keys.length - 50)) delete all[k]
  }
  try {
    fs.mkdirSync(String(strikesPath(env)).replace(/[\\/][^\\/]+$/, ''), { recursive: true })
    fs.writeFileSync(strikesPath(env), JSON.stringify({ version: 1, strikes: all }, null, 2), 'utf8')
    return all[key]
  } catch { return null }
}

/** 最近 window 内的打击次数（默认 24h）。 */
export function recentModelStrikes(env, { hours = 24, now = Date.now() } = {}) {
  const all = readAll(env)
  const cut = Number(now) - Math.max(1, Number(hours) || 24) * 3600 * 1000
  const out = {}
  for (const [key, v] of Object.entries(all)) {
    const at = Number(v && v.at) || 0
    if (at < cut) continue
    const count = Number(v && v.count) || 0
    if (count > 0) out[key] = count
  }
  return out
}

/**
 * 纯函数：把「近期不守格式」的路由排到后面（稳定排序，阈值默认 2 次）。
 * 全部命中过时保持原顺序（宁可慢一点，也不能没有候选）。
 */
export function rankRoutesByStrikes(routes = [], strikes = {}, { threshold = 2 } = {}) {
  const list = Array.isArray(routes) ? routes : []
  const th = Math.max(1, Number(threshold) || 2)
  const isBad = (r) => (Number(strikes[routeKey(r)]) || 0) >= th
  const clean = list.filter((r) => !isBad(r))
  const bad = list.filter(isBad)
  if (!clean.length) return list.slice()   // 全都命中过 → 原顺序兜底
  return [...clean, ...bad]
}
