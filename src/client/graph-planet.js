// 星球分层视图的客户端工具（纯函数，便于单测）。
//
// 分层视图里「这一层显示什么」由宿主算好（lib/vault.js 的 planGraphLevel）：客户端只做三件事
//   ① 按层请求 + 层级缓存（面包屑返回上层必须零新增请求）；
//   ② 把宿主返回的图元（planet / card）映射成画布节点（星球半径、卡片半径）；
//   ③ 统计自己占用的 rAF / 监听器 / 定时器 —— 20 轮下钻/返回后必须回到同一个数。

/** 层加载超时（ms）：超时显式报错 + 保留当前层 + 可重试，绝不静默空图。 */
export const LEVEL_TIMEOUT_MS = 1600
/** 与宿主一致：单层图元上限。客户端只做防御性校验（宿主才是权威）。 */
export const LEVEL_MAX_ITEMS = 1000
/** 与宿主一致：单次层响应 payload 上限。 */
export const LEVEL_PAYLOAD_LIMIT = 1024 * 1024
/** 大星球半径区间（像素，世界坐标）。 */
export const PLANET_MIN_RADIUS = 34
export const PLANET_MAX_RADIUS = 240
/** 星球层用更大的斥力：大圆必须分得开，否则「一层星球」会叠成一坨。 */
export const PLANET_LAYER_REPULSION = 1600
export const PLANET_LAYER_GRAVITY = 0.004

/** 层级路径 → 缓存键 / URL 片段。 */
export function pathKey(segments) {
  return (Array.isArray(segments) ? segments : []).filter(Boolean).join('/')
}

/** 面包屑 / 图元 id → 路径段数组（宿主返回的是 join('/') 的字符串）。 */
export function segmentsOf(pathStr) {
  return String(pathStr == null ? '' : pathStr).split('/').filter(Boolean)
}

export function urlForLevel(api, segments, opts = {}) {
  const p = pathKey(segments)
  return `${api}/graph/level?path=${encodeURIComponent(p)}${opts.all ? '&all=1' : ''}`
}

/** 大星球半径随卡数增长（对数），夹在 PLANET_MIN_RADIUS..PLANET_MAX_RADIUS。 */
export function planetRadius(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0))
  const r = 24 + 38 * Math.log10(Math.max(1, n))
  return Math.max(PLANET_MIN_RADIUS, Math.min(PLANET_MAX_RADIUS, Math.round(r)))
}

/** 卡片半径：度数越高越大（沿用改造前的 9 + min(10, deg/maxDeg*8)），核心记忆 +3。 */
export function cardRadius({ kind = 'other', degree = 0, maxDegree = 1 } = {}) {
  const deg = Math.max(0, Number(degree) || 0)
  const max = Math.max(1, Number(maxDegree) || 1)
  return 9 + Math.min(10, (deg / max) * 8) + (kind === 'core' ? 3 : 0)
}

/**
 * 星球层打的大数字：<10000 原样（944 / 6500 这类显示保持不变），
 * ≥10000 用 Intl 紧凑写法 —— 中文「1.2万」、英文「12K / 1.2M」。
 * unit / locale 由调用方从词典传进来（t('graphCountWan') / t('graphCountLocale')），
 * 中英文界面各用各的写法；Intl 不可用（老运行时）时退回手写单位。
 * @param {number} count
 * @param {{unit?:string, locale?:string, intl?:boolean}} opts intl=false 让单测固定走回退分支
 */
export function formatCount(count, opts = {}) {
  const v = Math.max(0, Math.floor(Number(count) || 0))
  if (v < 10000) return String(v)
  const unit = opts.unit || '万'
  const locale = opts.locale || 'zh-CN'
  if (opts.intl !== false) {
    try {
      return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(v)
    } catch { /* 运行时没有 Intl compact：走下面的手写单位 */ }
  }
  if (unit === '万') return (Math.round(v / 1000) / 10) + '万'
  if (v >= 1e6) return (Math.round(v / 1e5) / 10) + 'M'
  return (Math.round(v / 100) / 10) + 'K'
}

/**
 * 宿主图元 → 画布节点。卡片用现有节点形状/半径；大星球带 planet=true + count。
 * @param {{id:string,type:string,label?:string,kind?:string,tags?:string[],updated?:string,count?:number}} item
 * @param {{degree?:number,maxDegree?:number}} opts
 */
export function levelItemToNode(item, opts = {}) {
  const src = item || {}
  const planet = src.type === 'planet'
  const kind = src.kind || 'other'
  // label 来自宿主；卡片层也可能是 title（兼容两种图元形状），最后才退回 id
  const label = String(src.label || src.title || src.name || src.id || '')
  return {
    id: String(src.id || ''),
    title: label,
    name: label,
    type: kind,
    planet,
    count: planet ? Math.max(0, Math.floor(Number(src.count) || 0)) : 0,
    tags: Array.isArray(src.tags) ? src.tags.slice() : [],
    updated: src.updated || '',
    r: planet ? planetRadius(src.count) : cardRadius({ kind, degree: opts.degree, maxDegree: opts.maxDegree }),
  }
}

/** 星球层的力参数：与大图同一套内核，只把斥力/重力换成适配大圆的量级。 */
export function planetLayerParams(base) {
  const b = base || {}
  return { ...b, repulsion: PLANET_LAYER_REPULSION, centerGravity: PLANET_LAYER_GRAVITY }
}

/**
 * 大星球对卡片的「护城河」半径：越大的球推开得越远。
 * 旧版只做「刚体重叠才推开」，小卡片会被吸在大球表面形成一圈紧贴的疙瘩；
 * 这里把排斥范围随半径放大，让大球周围始终留出一圈可呼吸的空白。
 */
export function planetMoat(radius) {
  const r = Math.max(0, Number(radius) || 0)
  return 12 + r * 0.25
}

/**
 * 星球层的「大球公转」：所有星球绕当前质心缓慢旋转（原地改 x/y，半径不变）。
 * - 只改角度不改半径 → 构图稳定，不会越转越散；
 * - 大球角速度更小（ω ∝ 1/√r）→ 四颗球不会像刚体一样死板地一起转；
 * - 少于 2 颗球、或 speed=0 时不动；拖拽中的球可以由 skip 跳过。
 * @param {Array<{planet?:boolean,x:number,y:number,r?:number}>} planets
 * @param {{speed?:number, skip?:(p:any)=>boolean}} [opts]
 * @returns {{cx:number,cy:number}|null} 质心（没有球时 null）
 */
const hash01 = (value) => {
  const s = String(value == null ? '' : value)
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  // FNV 对短字符串的尾部雪崩不够：不混一下，p0..p7 会落在同一侧。
  h ^= h >>> 16
  h = Math.imul(h, 2246822507)
  h ^= h >>> 13
  h = Math.imul(h, 3266489909)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/**
 * 给每颗大球分配各自的运动参数：方向正反各半（洗牌），速度倍率/相位随机。
 * 用户要的是「活动方向不要一致、随意活动」，所以不能整盘同向、同速。
 * @param {Array} planets
 * @param {() => number} [rand] 注入随机源（单测用）
 */
export function assignOrbitRandom(planets, rand = Math.random) {
  const list = (Array.isArray(planets) ? planets : []).filter((p) => p && p.planet)
  const n = list.length
  if (!n) return list
  const dirs = list.map((_, i) => (i % 2 ? 1 : -1))
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.max(0, Math.min(0.999999, Number(rand()) || 0)) * (i + 1))
    const tmp = dirs[i]
    dirs[i] = dirs[j]
    dirs[j] = tmp
  }
  list.forEach((p, i) => {
    p.orbitDir = dirs[i]
    p.orbitScale = 0.55 + Math.max(0, Math.min(0.999999, Number(rand()) || 0)) * 1.1
    p.orbitPhase = Math.max(0, Math.min(0.999999, Number(rand()) || 0)) * Math.PI * 2
  })
  return list
}

export function orbitPlanets(planets, opts = {}) {
  const list = (Array.isArray(planets) ? planets : [])
    .filter((p) => p && p.planet && Number.isFinite(p.x) && Number.isFinite(p.y))
  if (!list.length) return null
  let cx = 0
  let cy = 0
  for (const p of list) { cx += p.x; cy += p.y }
  cx /= list.length
  cy /= list.length
  if (list.length < 2) return { cx, cy }
  const speed = opts.speed === undefined ? 0.0028 : Math.max(0, Number(opts.speed) || 0)
  if (!speed) return { cx, cy }
  const skip = typeof opts.skip === 'function' ? opts.skip : null
  const random = opts.random !== false
  const tick = Number.isFinite(opts.tick) ? opts.tick : 0
  for (let i = 0; i < list.length; i += 1) {
    const p = list[i]
    if (skip && skip(p)) continue
    const dx = p.x - cx
    const dy = p.y - cy
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist < 1e-3) continue
    // 每颗球各转各的：方向正反随机、速度倍率随机、角速度再叠一个慢速正弦摆动。
    // 旧版「整盘同向旋转」看起来像刚体，用户要的是「随意活动」。
    const seed = p.id == null ? 'planet-' + i : String(p.id)
    const dir = p.orbitDir === 1 || p.orbitDir === -1
      ? p.orbitDir
      : (random ? (hash01(seed) < 0.5 ? -1 : 1) : 1)
    const speedScale = Number.isFinite(p.orbitScale)
      ? Math.max(0.2, Math.min(2, p.orbitScale))
      : (random ? 0.55 + hash01(seed + '#s') * 1.1 : 1)
    const phase = Number.isFinite(p.orbitPhase) ? p.orbitPhase : hash01(seed + '#w') * Math.PI * 2
    const wobble = random ? 1 + Math.sin(tick * 0.009 + phase) * 0.35 : 1
    // 半径越大转得越慢：ω 用 1/√r 过渡，视觉上有「质量感」
    const omega = speed * dir * speedScale * wobble * Math.sqrt(120 / Math.max(40, Number(p.r) || 120))
    const a = Math.atan2(dy, dx) + omega
    p.x = cx + Math.cos(a) * dist
    p.y = cy + Math.sin(a) * dist
  }
  return { cx, cy }
}

/**
 * 层加载失败的归类：超时（AbortError 或耗时越过预算）单独标出来 —— UI 上要提示「可重试」，
 * 而不是把两者混成一句「加载失败」。纯函数，便于单测。
 */
export function describeLevelError(err, opts = {}) {
  const timeoutMs = Math.max(1, Number(opts.timeoutMs) || LEVEL_TIMEOUT_MS)
  const elapsedMs = Math.max(0, Number(opts.elapsedMs) || 0)
  const name = String((err && err.name) || '')
  const raw = String((err && err.message) || err || '')
  const aborted = name === 'AbortError' || /abort/i.test(raw)
  const timeout = aborted || elapsedMs >= timeoutMs
  return { timeout, message: timeout ? `层级加载超时（${timeoutMs}ms）` : (raw || '未知错误') }
}

/** 层级缓存（LRU）：面包屑返回上层命中即零新增请求。 */
export function createLevelCache(limit = 96) {
  const cap = Math.max(1, Math.floor(Number(limit) || 96))
  const map = new Map()
  return {
    get size() { return map.size },
    has(key) { return map.has(key) },
    get(key) {
      if (!map.has(key)) return null
      const v = map.get(key)
      map.delete(key)
      map.set(key, v) // LRU：命中即刷新热度
      return v
    },
    set(key, value) {
      if (map.has(key)) map.delete(key)
      map.set(key, value)
      while (map.size > cap) map.delete(map.keys().next().value)
      return value
    },
    clear() { map.clear() },
    keys() { return [...map.keys()] },
  }
}

/**
 * rAF / 定时器 / 监听器账本：GraphCanvas 的每个层级实例都从同一个账本申请资源，
 * 卸载时 releaseAll()。探针读 snapshot() —— 20 轮下钻/返回后三个数必须回到同一个值。
 * env 可注入（单测用假定时器），生产走浏览器全局。
 */
export function createResourceTracker(env = {}) {
  const rafFn = env.raf || ((fn) => requestAnimationFrame(fn))
  const cafFn = env.cancelRaf || ((id) => cancelAnimationFrame(id))
  const timeoutFn = env.setTimeout || ((fn, ms) => setTimeout(fn, ms))
  const clearFn = env.clearTimeout || ((id) => clearTimeout(id))
  const rafs = new Set()
  const timers = new Set()
  const listeners = []
  return {
    raf(fn) {
      const id = rafFn(() => { rafs.delete(id); fn() })
      rafs.add(id)
      return id
    },
    cancelRaf(id) {
      if (id == null) return
      rafs.delete(id)
      cafFn(id)
    },
    setTimeout(fn, ms) {
      const id = timeoutFn(() => { timers.delete(id); fn() }, ms)
      timers.add(id)
      return id
    },
    clearTimeout(id) {
      if (id == null) return
      timers.delete(id)
      clearFn(id)
    },
    listen(target, type, fn, opts) {
      target.addEventListener(type, fn, opts)
      listeners.push({ target, type, fn, opts })
    },
    snapshot() {
      return { rafs: rafs.size, timers: timers.size, listeners: listeners.length }
    },
    releaseAll() {
      for (const id of [...rafs]) { rafs.delete(id); try { cafFn(id) } catch { /* 已触发 */ } }
      for (const id of [...timers]) { timers.delete(id); try { clearFn(id) } catch { /* 已触发 */ } }
      for (const l of listeners.splice(0)) { try { l.target.removeEventListener(l.type, l.fn, l.opts) } catch { /* 目标已销毁 */ } }
    },
  }
}

/** 防御性校验：宿主返回的一层是否越界（越界只告警，不静默截断，便于定位宿主回归）。 */
export function validateLevelPayload(data, opts = {}) {
  const maxItems = Math.max(1, Number(opts.maxItems) || LEVEL_MAX_ITEMS)
  const payloadLimit = Math.max(1, Number(opts.payloadLimit) || LEVEL_PAYLOAD_LIMIT)
  const items = data && data.level && Array.isArray(data.level.items) ? data.level.items.length : 0
  const bytes = Number(data && data.stats && data.stats.bytes) || 0
  const problems = []
  if (items > maxItems) problems.push(`单层图元 ${items} > ${maxItems}`)
  if (bytes > payloadLimit) problems.push(`层 payload ${bytes} > ${payloadLimit}`)
  return { ok: problems.length === 0, items, bytes, problems }
}
