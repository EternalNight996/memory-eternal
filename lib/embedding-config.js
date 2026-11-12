// 语义召回配置（可选后端）：独立小文件，避开 DSH 设置 schema 与同步链路。
//
// 位置：与共享配置文件同目录，形如 <config>.embedding.json（与 <config>.star.json 同思路）。
// 默认值：关闭、地址 http://127.0.0.1:7997/v1、模型 bge-m3 —— 用户不配置时零影响。
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

export function embeddingConfigFile(env = process.env) {
  return String(configFilePath(env)).replace(/\.json$/i, '.embedding.json')
}

function normalizeBaseUrl(v) {
  const s = String(v || '').trim()
  if (!/^https?:\/\//i.test(s)) return ''
  return s.replace(/\/+$/, '')
}

export function readEmbeddingConfig(env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(embeddingConfigFile(env), 'utf8'))
    // 老配置文件没有 mode 字段：按 local 解释，避免把已有向量用户静默切到 builtin
    return { ...EMBED_DEFAULTS, ...raw, mode: raw.mode === undefined ? 'local' : raw.mode }
  } catch {
    return { ...EMBED_DEFAULTS }
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
  // 只显式传 mode=builtin 才强制关闭向量；「启用语义」但没选模式时按向量模式处理
  if (patch.mode === undefined && next.enabled === true && next.mode === 'builtin') next.mode = 'local'
  if (patch.mode === 'builtin') next.enabled = false
  next.mode = ['local', 'builtin', 'online'].includes(next.mode) ? next.mode : 'local'
  next.baseUrl = normalizeBaseUrl(next.baseUrl)
  next.model = String(next.model || '').trim()
  next.apiKey = String(next.apiKey || '')
  if (!next.baseUrl) throw new Error('embedding 地址需要 http(s):// 开头')
  if (!/^[\w./:@-]{1,120}$/.test(next.model)) throw new Error('embedding 模型名不合法')
  next.updatedAt = new Date().toISOString()
  const file = embeddingConfigFile(env)
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  return next
}

/** 只用于展示的脱敏视图。 */
export function publicEmbeddingConfig(env = process.env) {
  const c = readEmbeddingConfig(env)
  return { enabled: c.enabled, mode: c.mode, baseUrl: c.baseUrl, model: c.model, hasKey: !!c.apiKey, updatedAt: c.updatedAt }
}
