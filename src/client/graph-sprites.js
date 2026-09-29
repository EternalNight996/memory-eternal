// 图谱渲染缓存（P1-2）：节点精灵 + 标签位图。
//
// 目标：把「每帧每节点 path+gradient」与「每帧每标签 measureText+roundRect+fillText」
// 换成一次 drawImage —— 帧时间基本不再随节点数上涨。
//
// 设计取舍：精灵按「离散缩放档 + 半径桶」缓存，缩放变化时只重建一次；
// 因为档位按 √2 分级，最大只会有 √2 的缩放误差（轻微模糊，用户已同意牺牲部分美化）。
// 纯 key 计算与 LRU 逻辑独立于 DOM，便于单测（工厂函数注入）。

const SQRT2 = Math.SQRT2

/** 把连续缩放离散成 √2 的档位，避免每帧重建精灵。 */
export function zoomBucket(zoom, step = SQRT2) {
  const z = Number(zoom) > 0 ? Number(zoom) : 1
  return Math.max(0, Math.round(Math.log(z) / Math.log(step)))
}

/** 半径分桶（整数像素），避免每个小数半径都建一份精灵。 */
export function radiusBucket(r) {
  const n = Math.max(1, Math.round(Number(r) || 1))
  return n
}

/** 节点精灵 key：形状/配色（kind）+ 半径桶 + 缩放档 + 主题（深/浅）。 */
export function nodeSpriteKey({ kind = 'other', radius = 9, zoom = 1, dark = false } = {}) {
  return kind + '|' + radiusBucket(radius) + '|' + zoomBucket(zoom) + '|' + (dark ? 'd' : 'l')
}

/** 标签位图 key：文本 + 字号 + 主题。 */
export function labelSpriteKey({ text = '', fontPx = 12, dark = false } = {}) {
  return text + '|' + Math.round(Number(fontPx) || 12) + '|' + (dark ? 'd' : 'l')
}

/**
 * 极简 LRU 画布缓存。
 * `createCanvas(w, h)` 由调用方注入（浏览器里给 () => document.createElement('canvas')，测试里可给假实现）。
 */
export class SpriteCache {
  constructor({ createCanvas, max = 400 } = {}) {
    this.createCanvas = createCanvas
    this.max = max
    this.map = new Map() // key -> entry（Map 的插入序即 LRU 序）
    this.hits = 0
    this.misses = 0
  }
  /** 取缓存；未命中时调用 render(canvasCtx, w, h) 生成。 */
  get(key, w, h, render) {
    const hit = this.map.get(key)
    if (hit && hit.w === w && hit.h === h) {
      this.hits++
      this.map.delete(key); this.map.set(key, hit) // 提到最新
      return hit
    }
    this.misses++
    const canvas = this.createCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)))
    const ctx = canvas.getContext('2d')
    render(ctx, canvas.width, canvas.height)
    const entry = { canvas, w, h, ctx }
    this.map.delete(key)
    this.map.set(key, entry)
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
    return entry
  }
  clear() { this.map.clear(); this.hits = 0; this.misses = 0 }
  get size() { return this.map.size }
}

/** 静态层 key：网格+边的重绘只由「变换 / 尺寸 / 视口 / 过滤器 / 主题」决定。 */
export function staticLayerKey({ panX = 0, panY = 0, zoom = 1, w = 0, h = 0, dpr = 1, tick = 0, filter = '', dark = false, dataVersion = 0 } = {}) {
  return [panX, panY, zoom, w, h, dpr, tick, filter, dark ? 'd' : 'l', dataVersion].join('|')
}
