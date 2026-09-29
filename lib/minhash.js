// MinHash + LSH：相似卡候选生成（把 O(n²) 精确比对换成「签名分桶 → 少量精确校验」）。
//
// 用法：先给每张卡的 bigram 哈希集合算一个 k 维最小哈希签名；再按 band 分桶，
// 同一 band 撞在一起的卡互为候选；最后只对候选做**精确** Jaccard（保证判定语义不变）。
// 纯函数，方便单测。

const M1 = 0x85ebca6b
const M2 = 0xc2b2ae35

/** 32 位整数混合（murmur3 finalizer 变体）—— 用作第 seed 号哈希函数。 */
export function mix32(x, seed = 0) {
  let h = (x ^ Math.imul(seed + 1, 0x9e3779b1)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, M1) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, M2) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/**
 * k 维最小哈希签名。
 * @param {Iterable<number>} grams 哈希后的 bigram 集合
 * @param {number} k 签名长度
 * @returns {Uint32Array}
 */
export function minhashSignature(grams, k = 64) {
  const sig = new Uint32Array(k).fill(0xffffffff)
  for (const g of grams) {
    for (let i = 0; i < k; i++) {
      const h = mix32(g, i)
      if (h < sig[i]) sig[i] = h
    }
  }
  return sig
}

/** 两个签名的一致位比例 = Jaccard 的无偏估计。 */
export function jaccardEstimate(a, b) {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0
  let same = 0
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++
  return same / a.length
}

/**
 * LSH 分桶：把签名切成 bands 段，每段 rows 行，拼成桶 key。
 * @returns {string[]} 长度 = bands（每段一个 key）
 */
export function lshBandKeys(sig, bands = 32, rows = 2) {
  const keys = []
  for (let b = 0; b < bands; b++) {
    let key = ''
    for (let r = 0; r < rows; r++) key += sig[b * rows + r].toString(36) + '.'
    keys.push(key)
  }
  return keys
}

/**
 * 生成候选：同一 band 撞在一起的卡互为候选，按「撞上的 band 数」降序截断。
 * @param {Map<string, Uint32Array>} signatures id -> 签名
 * @param {{bands?:number, rows?:number, maxPerCard?:number, minHits?:number}} [opts]
 * @returns {Map<string, string[]>} id -> 候选 id 列表（已按命中数排序、已截断）
 */
export function lshCandidates(signatures, opts = {}) {
  const bands = opts.bands || 32
  const rows = opts.rows || 2
  const maxPerCard = opts.maxPerCard || 40
  const minHits = opts.minHits || 1
  const hits = new Map() // id -> Map(otherId -> count)
  const buckets = new Map() // bandKey -> id[]
  for (const [id, sig] of signatures) {
    const keys = lshBandKeys(sig, bands, rows)
    for (const key of keys) {
      const arr = buckets.get(key)
      if (arr) arr.push(id)
      else buckets.set(key, [id])
    }
  }
  for (const arr of buckets.values()) {
    if (arr.length < 2 || arr.length > 400) continue // 超大桶基本是「全库同质」，跳过以免退化
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], b = arr[j]
        let ma = hits.get(a); if (!ma) { ma = new Map(); hits.set(a, ma) }
        ma.set(b, (ma.get(b) || 0) + 1)
        let mb = hits.get(b); if (!mb) { mb = new Map(); hits.set(b, mb) }
        mb.set(a, (mb.get(a) || 0) + 1)
      }
    }
  }
  const out = new Map()
  for (const [id, map] of hits) {
    const ranked = [...map.entries()].filter(([, n]) => n >= minHits).sort((x, y) => y[1] - x[1])
    out.set(id, (ranked.length <= maxPerCard ? ranked : ranked.slice(0, maxPerCard)).map(([other]) => other))
  }
  return out
}
