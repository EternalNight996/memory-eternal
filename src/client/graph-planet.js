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
 * 护城河：大球把小球推开的最小间距。
 *
 * 用户反馈原话是「小的球数量多紧贴着大的，丑」。硬性把小球挡在 `球半径 + 基础间距` 之外，
 * 且间距随半径单调增大（大球推得更远），否则 240px 的大球周围会贴满小点。
 * 纯函数，便于单测。
 * @param {number} r 半径
 * @returns {number} 护城河宽度（像素）
 */
export function planetMoat(r) {
  const radius = Math.max(0, Number(r) || 0)
  return 12 + radius * 0.55
}

/**
 * 大球公转：只改角度、不改半径，绕当前重心缓慢转动。
 *
 * 为什么要「各自方向 + 各自速度」：整盘同向同速看起来像整张图在转，不像天体在公转。
 * 每颗球的 `orbitDir / orbitScale / orbitPhase` 由 `assignOrbitRandom` 提前分配；
 * 大球角速度更小（有质量感），靠 `1 / sqrt(r)` 的权重实现。
 *
 * @param {Array} nodes 节点列表（只处理 planet 节点，原地修改 x/y）
 * @param {{speed?:number, tick?:number, random?:boolean, skip?:(n:any)=>boolean}} [opts]
 * @returns {{cx:number, cy:number}|null} 重心；不足两颗可动球时返回 null
 */
export function orbitPlanets(nodes, { speed = 0.01, tick = 0, random = true, skip = null } = {}) {
  if (!Array.isArray(nodes)) return null
  const planets = nodes.filter((n) => n && n.planet)
  if (planets.length < 2) return null
  const s = Number(speed) || 0
  if (s === 0) return null
  let cx = 0
  let cy = 0
  for (const p of planets) { cx += p.x; cy += p.y }
  cx /= planets.length
  cy /= planets.length
  for (let i = 0; i < planets.length; i++) {
    const p = planets[i]
    // 拖拽中的球跳过（它有自己的位移来源），但重心仍按全量算 —— 否则拖一颗会把整层重心带跑
    if (skip && skip(p)) continue
    // 未分配方向时按 id/x 派生一个稳定的伪随机（同一次会话里不会每帧翻向）
    if (p.orbitDir === undefined) {
      p.orbitDir = random ? ((i % 2 === 0) ? 1 : -1) : 1
    }
    if (p.orbitScale === undefined) p.orbitScale = 1
    if (p.orbitPhase === undefined) p.orbitPhase = 0
    const dx = p.x - cx
    const dy = p.y - cy
    const radius = Math.hypot(dx, dy)
    if (radius < 1e-6) continue
    const base = angleAt(dx, dy)
    // 大球转得慢：半径越大角速度越小（1/sqrt(r)），再叠各自的 scale/phase 做慢摆
    const mass = 1 / Math.sqrt(Math.max(PLANET_MIN_RADIUS, p.r || PLANET_MIN_RADIUS))
    const wobble = 1 + 0.35 * Math.sin((p.orbitPhase || 0) + tick * 0.004)
    const next = base + p.orbitDir * s * (p.orbitScale || 1) * mass * 34 * wobble
    p.x = cx + Math.cos(next) * radius
    p.y = cy + Math.sin(next) * radius
  }
  return { cx, cy }
}

const angleAt = (dx, dy) => Math.atan2(dy, dx)

/**
 * 给每颗大球分配「方向 / 速度倍率 / 相位」。
 * 方向正反各半（洗牌），速度倍率 0.55–1.65，相位 0–2π —— 这样整盘不会同向同速。
 * @param {Array} nodes
 * @param {() => number} [rand] 可注入的随机源（测试用）
 */
export function assignOrbitRandom(nodes, rand = Math.random) {
  if (!Array.isArray(nodes)) return
  const planets = nodes.filter((n) => n && n.planet)
  if (!planets.length) return
  // 正反各半：先造一个减半的数组再打乱，保证方向分布均匀（纯随机会出现 8 颗全同向）
  const dirs = planets.map((_, i) => (i % 2 === 0 ? 1 : -1))
  for (let i = dirs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = dirs[i]; dirs[i] = dirs[j]; dirs[j] = t
  }
  planets.forEach((p, i) => {
    p.orbitDir = dirs[i]
    p.orbitScale = 0.55 + rand() * 1.1
    p.orbitPhase = rand() * Math.PI * 2
  })
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
