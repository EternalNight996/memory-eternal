// 内置语义（零安装）：字符 n-gram 哈希向量
//
// 为什么需要它：面板上「内置语义」原本只是把 `enabled` 设成 false —— 选了等于关掉，
// 用户看到的是一句「已选中但没有任何效果」。这里把它做成真的能用的东西：
// 不装模型、不联网、纯 JS，把文本编码成定长稀疏向量，用 cosine 做「意思相近」的召回。
//
// 定位：**比词法好一点、比真模型差一截**的兜底通道 —— 它认得出「卡住/卡死/挂住」这类近义，
// 也认得出中英文混排里的重复主题；但不要把语义推理押在它身上。要质量就上本地 bge-m3 或在线 API。
//
// 算法（hashing trick）：
//   1. 归一化：小写、把标点当分隔；
//   2. 取特征：中文 2-gram + 3-gram（单字太泛，4-gram 太稀），英文/数字按整词；
//   3. 哈希到 DIM 维（同一个 n-gram 永远落同一个桶），词频取 1+log(tf) 抑制高频；
//   4. L2 归一化，于是 `cosine` 直接可用，且与外部模型的向量可以共存于同一张 card_vec 表。

import { mix32 } from './minhash.js'

export const BUILTIN_MODEL = 'builtin-ngram-768'
export const BUILTIN_DIM = 768

/** 归一化：小写，标点/符号当分隔符（保留中英文数字）。 */
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
}

/**
 * 内置近义归一表（**唯一的一份"语义知识"**）。
 *
 * 纯 n-gram 只能认字面重叠：「卡住 / 挂住」「报错 / 异常」一个 2-gram 都不共享。
 * 不引外部词表也能救回来 —— 把这些高频近义说法在抽特征前归一成一个规范词形，
 * 于是它们共享同一批 n-gram。表故意做得小：只覆盖记忆库里真正高频的那几十个概念，
 * 加词的成本很低，加错的代价也很低（只是多共享一点特征）。
 * 左 → 右（右为规范形）。
 */
const SYNONYM_GROUPS = [
  ['卡死', '挂住', '死锁', '卡顿', '无响应', '假死', 'hang', 'stuck', '卡住'],
  ['报错', '异常', '出错', '错误', '失败', '崩溃', 'failed', 'error', 'crash', '报错'],
  ['配置', '设置', '参数', '选项', 'settings', 'config', '配置'],
  ['检索', '搜索', '查找', '查询', '搜不到', 'search', 'query', '检索'],
  ['记忆', '记忆库', '知识库', '卡片', 'memory', '记忆'],
  ['备份', '快照', '存档', 'backup', 'snapshot', '备份'],
  ['还原', '恢复', '回滚', 'restore', 'rollback', '还原'],
  ['安装', '部署', '装好', '装完', 'install', 'deploy', 'setup', '安装'],
  ['路径', '目录', '文件夹', '盘符', 'path', 'dir', 'folder', '路径'],
  ['删除', '清除', '移除', '清空', 'delete', 'remove', 'clear', '删除'],
  ['权限', '鉴权', '授权', '认证', '登录', 'auth', 'login', '权限'],
  ['性能', '速度', '流畅', '耗时', '延迟', 'performance', 'latency', '性能'],
  ['界面', '面板', '页面', '前端', 'ui', 'interface', '界面'],
  ['皮肤', '主题', '配色', 'theme', 'skin', '皮肤'],
  ['文档', '说明', '注释', 'readme', 'docs', 'document', '文档'],
  ['测试', '验证', '验收', '用例', 'test', 'verify', 'check', '测试'],
  ['版本', '升级', '更新', 'version', 'update', 'upgrade', '版本'],
  ['向量', '语义', '相似度', '语义召回', 'embedding', 'vector', '语义'],
  ['模型', '模型服务', 'ollama', 'bge', 'model', '模型'],
  ['钩子', 'hook', '回调', 'callback', '钩子'],
  ['端口', 'port', '监听', 'listen', '端口'],
  ['缓存', 'cache', '内存缓存', '缓存'],
  ['打包', '构建', '编译', 'build', 'bundle', '打包'],
  ['发布', '上线', '发版', 'release', 'publish', '发布'],
]
/** 规范形（每组最后一个词）。 */
const CANON = SYNONYM_GROUPS.map((g) => g[g.length - 1])
/** 扁平化并按长度倒序，保证「语义召回」先于「语义」被替换。 */
const SYNONYM_PAIRS = (() => {
  const pairs = []
  SYNONYM_GROUPS.forEach((group, gi) => {
    const canon = CANON[gi]
    for (const w of group) if (w && w !== canon) pairs.push([w.toLowerCase(), canon])
  })
  return pairs.sort((a, b) => b[0].length - a[0].length)
})()

/** 近义归一（长词优先，纯字符串替换）。 */
export function canonicalize(text) {
  let s = String(text || '').toLowerCase()
  for (const [from, to] of SYNONYM_PAIRS) {
    if (!s.includes(from)) continue
    s = s.split(from).join(to)
  }
  return s
}

/**
 * 抽取特征：中文 2/3-gram（主）+ 单字（**低权重**），英文/数字整词。
 *
 * 单字为什么必须有：n-gram 只能认出字面重叠，而「卡住 / 挂住」「死锁 / 卡死」这类近义说法
 * 一个 2-gram 都不共享。加上低权重单字（共享「住」「死」这类字）后相似度才有非零底噪，
 * 权重压到 0.35 是为了不让「的/了/是」这类高频字把一切拉成同一类。
 *
 * @param {string} text
 * @returns {Array<[string, number]>} [特征, 权重]
 */
export function weightedFeatures(text) {
  const s = normalizeText(canonicalize(text))
  const out = []
  const cjk = /[\u3400-\u9fff]/
  for (const token of s.split(/\s+/)) {
    if (!token) continue
    if (!cjk.test(token)) { out.push([token, 1]); continue }
    if (token.length === 1) { out.push([token, 1]); continue }
    for (let n = 2; n <= 3; n++) {
      for (let i = 0; i + n <= token.length; i++) out.push([token.slice(i, i + n), 1])
    }
    for (const ch of token) out.push([ch, 0.35])
  }
  return out
}

/** 只要特征串（调试/测试用）。 */
export function featuresOf(text) {
  return weightedFeatures(text).map(([f]) => f)
}

/** L2 归一化（原地）。 */
function l2(vec) {
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i]
  if (sum <= 0) return vec
  const inv = 1 / Math.sqrt(sum)
  for (let i = 0; i < vec.length; i++) vec[i] *= inv
  return vec
}

/**
 * 字符串 → 32 位哈希（FNV-1a）。
 * 必须先做这一步：`mix32` 是整数混合器，直接喂字符串会被 `^` 转成 NaN→0，
 * 于是所有特征落进同一个桶、任意两段文本相似度恒为 1。
 */
function hashStr(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * 编码一段文本。
 * @param {string} text
 * @param {{dim?:number, grams?:string[]}} [opts] grams：预先算好的特征（批量时复用）
 * @returns {Float32Array}
 */
export function embedBuiltin(text, { dim = BUILTIN_DIM, grams = null } = {}) {
  const vec = new Float32Array(dim)
  const feats = grams || weightedFeatures(text)
  if (!feats.length) return vec
  // 分别记「权重和」与「出现次数」：词频抑制只压次数，不能拿小权重（0.35）去算 1+log(w)，
  // 那会得负数，单字特征反而把向量往下拉（实测近义文本相似度直接变 0）。
  const stat = new Map()
  for (const [f, w] of feats) {
    const cur = stat.get(f) || { w: 0, c: 0 }
    cur.w += w
    cur.c += 1
    stat.set(f, cur)
  }
  for (const [f, { w, c }] of stat) {
    const idx = mix32(hashStr(f)) % dim
    vec[idx] += w * (1 + Math.log(c))
  }
  return l2(vec)
}

/** 相似度（两边都已 L2 归一化时等价于点积）。 */
export function builtinSimilarity(a, b) {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}
