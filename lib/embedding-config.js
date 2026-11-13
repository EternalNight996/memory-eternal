// 语义召回配置（可选后端）：独立小文件，避开 DSH 设置 schema 与同步链路。
//
// 位置：<config>.embedding.v2.json（**v2 改名不是洁癖，是隔离**：旧版宿主进程（≤0.31.x）在
// web 自愈/配置同步时会把旧路径 `<config>.embedding.json` 重写回 `local + bge-m3`，
// 用户在面板里保存的「内置语义 + 关闭」会被它覆盖 —— 表现就是「保存后重启又变回去了」。
// 换文件名后，旧进程的写入落到废弃路径，新版只读 v2；第一次启动会把旧文件迁移过来一次。
// 默认值：关闭、内置语义（零安装）、地址 http://127.0.0.1:7997/v1 —— 用户不配置时零影响。
import fs from 'node:fs'
import path from 'node:path'
import { configFilePath } from './capture-run.js'

export const EMBED_DEFAULTS = {
  enabled: false,
  mode: 'builtin', // 新装默认内置语义（零安装）；local=Ollama/向量；online=在线 API
  baseUrl: 'http://127.0.0.1:7997/v1',
  model: 'bge-m3',
  rerankModel: '',
  apiKey: '',
  updatedAt: '',
}

/** 旧版路径（只读，用于一次性迁移；不再写入）。 */
export function legacyEmbeddingConfigFile(env = process.env) {
  return String(configFilePath(env)).replace(/\.json$/i, '.embedding.json')
}

export function embeddingConfigFile(env = process.env) {
  return String(configFilePath(env)).replace(/\.json$/i, '.embedding.v2.json')
}

function normalizeBaseUrl(v) {
  const s = String(v || '').trim()
  if (!/^https?:\/\//i.test(s)) return ''
  return s.replace(/\/+$/, '')
}

/** 内部直写（迁移用，不经过 read → 避免递归）。 */
function writeRaw(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export function readEmbeddingConfig(env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(embeddingConfigFile(env), 'utf8'))
    // 老配置文件没有 mode 字段：按 local 解释，避免把已有向量用户静默切到 builtin
    return { ...EMBED_DEFAULTS, ...raw, mode: raw.mode === undefined ? 'local' : raw.mode }
  } catch {
    // v2 还不存在：从旧文件迁移一次（旧值可能是旧宿主写过的，但至少是用户最后一次实际生效的配置）
    try {
      const legacy = JSON.parse(fs.readFileSync(legacyEmbeddingConfigFile(env), 'utf8'))
      const migrated = { ...EMBED_DEFAULTS, ...legacy, mode: legacy.mode === undefined ? 'local' : legacy.mode }
      try { writeRaw(embeddingConfigFile(env), migrated) } catch { /* 迁移失败就只在内存里用 */ }
      return migrated
    } catch {
      return { ...EMBED_DEFAULTS }
    }
  }
}

/** 写入（原子替换 + 0600）。patch 里的 undefined 视为不修改；空字符串 apiKey 表示清除。 */
export function writeEmbeddingConfig(patch = {}, env = process.env) {
  const cur = readEmbeddingConfig(env)
  const next = { ...cur }
  for (const k of ['enabled', 'mode', 'baseUrl', 'model', 'rerankModel', 'apiKey']) {
    if (patch[k] === undefined || patch[k] === null) continue
    next[k] = patch[k]
  }
  next.enabled = next.enabled === true
  // 不要再有「enabled=true 且 mode=builtin 就悄悄改成 local」这种隐式改写：
  // 用户明确选了内置，保存后却变回本地 Ollama，重启后还带着在线模式的预设地址 —— 正是它造成的。
  // 历史实现里 mode=builtin 还会强制 enabled=false（等于「选中即关闭」），同样已移除。
  next.mode = ['local', 'builtin', 'online'].includes(next.mode) ? next.mode : 'local'
  // 传了「非空但非法」的地址必须直接拒（用户粘贴了 ftp:// 或少了 scheme）；
  // 只有「空地址」才按模式宽容（builtin 根本不需要地址）。
  const rawBase = String(next.baseUrl == null ? '' : next.baseUrl).trim()
  next.baseUrl = normalizeBaseUrl(rawBase)
  if (rawBase && !next.baseUrl) throw new Error('embedding 地址需要 http(s):// 开头')
  next.model = String(next.model || '').trim()
  next.apiKey = String(next.apiKey || '')
  const corrected = []
  // local 模式必须指向本机：在线模式的预设地址（如 api.siliconflow.cn）被写进 local，
  // 会让「本地 Ollama」去连公网，服务状态与模型列表全是错的。这里直接纠正并如实回报。
  if (next.mode === 'local' && next.baseUrl && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(next.baseUrl)) {
    next.baseUrl = 'http://127.0.0.1:7997/v1'
    corrected.push('local 模式的地址必须是本机，已纠正为 127.0.0.1:7997')
  }
  // builtin 不需要 baseUrl：保留原值占位即可，不因为「没填地址」把保存整个拒掉
  if (!next.baseUrl && next.mode !== 'builtin') throw new Error('embedding 地址需要 http(s):// 开头')
  if (!next.baseUrl && next.mode === 'builtin') next.baseUrl = 'http://127.0.0.1:7997/v1'
  if (!/^[\w./:@-]{1,120}$/.test(next.model)) throw new Error('embedding 模型名不合法')
  next.updatedAt = new Date().toISOString()
  const file = embeddingConfigFile(env)
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  // 纠正项单独返回（不写进文件），调用方据此提示用户「保存时做了什么修正」
  Object.defineProperty(next, 'corrected', { value: corrected, enumerable: false })
  return next
}

/** 只用于展示的脱敏视图。 */
export function publicEmbeddingConfig(env = process.env) {
  const c = readEmbeddingConfig(env)
  return { enabled: c.enabled, mode: c.mode, baseUrl: c.baseUrl, model: c.model, hasKey: !!c.apiKey, updatedAt: c.updatedAt }
}
