// 语义召回：本地模型目录、在线厂商预设、机器条件探测。
//
// 目录只做「展示与预填」，不改变后端行为；下载/部署仍走 Ollama API 或已配置端点。
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

/** 本地 embedding 模型（Ollama library 名称）。dims/size 为公开规格的近似值，仅用于展示。 */
export const MODEL_CATALOG = [
  {
    name: 'bge-m3', sizeMB: 1200, dims: 1024, ramMB: 2048, vramMB: 2048,
    tag: '中文最佳', desc: '多语 + 中文，1024 维；本机 3060 级别显卡可跑，CPU 也可（较慢）',
  },
  {
    name: 'qwen3-embedding:0.6b', sizeMB: 640, dims: 1024, ramMB: 1536, vramMB: 1536,
    tag: '中文强', desc: '通义 embedding，0.6B 参数，中英兼顾，显存占用低于 bge-m3',
  },
  {
    name: 'granite-embedding:278m', sizeMB: 560, dims: 768, ramMB: 1200, vramMB: 1200,
    tag: '多语', desc: 'IBM 多语模型，12 种语言，体积适中',
  },
  {
    name: 'nomic-embed-text', sizeMB: 274, dims: 768, ramMB: 800, vramMB: 800,
    tag: '英文向', desc: '体积小、速度快；中文效果一般',
  },
  {
    name: 'all-minilm', sizeMB: 46, dims: 384, ramMB: 300, vramMB: 300,
    tag: '最轻量', desc: '46MB，仅适合验证流程或英文场景',
  },
]

/** 在线 OpenAI 兼容厂商预设（地址 + 可用 embedding 模型）。 */
export const VENDORS = [
  {
    id: 'siliconflow', label: '硅基流动（国内）', baseUrl: 'https://api.siliconflow.cn/v1',
    models: [{ id: 'BAAI/bge-m3', dims: 1024 }, { id: 'BAAI/bge-large-zh-v1.5', dims: 1024 }],
  },
  {
    id: 'zhipu', label: '智谱（国内）', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [{ id: 'embedding-3', dims: 2048 }],
  },
  {
    id: 'dashscope', label: '阿里百炼（国内）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [{ id: 'text-embedding-v3', dims: 1024 }],
  },
  {
    id: 'openai', label: 'OpenAI（海外）', baseUrl: 'https://api.openai.com/v1',
    models: [{ id: 'text-embedding-3-small', dims: 1536 }, { id: 'text-embedding-3-large', dims: 3072 }],
  },
  { id: 'custom', label: '自定义', baseUrl: '', models: [] },
]

/** Ollama 是否已安装（标准安装路径 / PATH / 环境变量），并尽量读出客户端版本。 */
export async function ollamaStatus(env = process.env) {
  const candidates = [
    env.MEMORY_OLLAMA_EXE,
    process.platform === 'win32' ? path.join(env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe') : '',
    '/usr/local/bin/ollama',
    '/opt/homebrew/bin/ollama',
    '/usr/bin/ollama',
    // PATH 里的 ollama（不做命令注入：只在 PATH 目录下找同名可执行文件）
    ...String(env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
      .map((d) => path.join(d, process.platform === 'win32' ? 'ollama.exe' : 'ollama')),
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue
      let version = ''
      try {
        version = await new Promise((resolve) => {
          execFile(p, ['--version'], { timeout: 1500 }, (err, stdout) => {
            const raw = String(stdout || '')
            const m = raw.match(/\b\d+\.\d+\.\d+\b/)
            resolve(m ? 'v' + m[0] : (raw.trim().split('\n').pop() || ''))
          })
        })
      } catch { version = '' }
      return { installed: true, path: p, version }
    } catch { /* 继续找 */ }
  }
  return { installed: false, path: '', version: '' }
}

/** 本机条件：CPU / 内存 / 显卡（nvidia-smi 可用时）。全部 best-effort。 */
export async function systemInfo() {
  const cpu = os.cpus()?.[0]?.model || ''
  const cores = os.cpus()?.length || 0
  const ramGB = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10
  let gpu = null
  try {
    gpu = await new Promise((resolve) => {
      execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeout: 1500 }, (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const first = String(stdout).trim().split('\n')[0]
        const [name, mem] = first.split(',').map((s) => s.trim())
        resolve(name ? { name, vramGB: mem || '' } : null)
      })
    })
  } catch { gpu = null }
  return { cpu, cores, ramGB, gpu }
}

/** 已安装的 Ollama 模型名（通过 /api/tags，去 tag 后缀）。 */
export async function installedModelNames(cfg, { timeoutMs = 3000 } = {}) {
  if (!cfg?.baseUrl) return []
  try {
    const origin = cfg.baseUrl.replace(/\/v1\/?$/i, '')
    const r = await fetch(origin + '/api/tags', { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return []
    const d = await r.json()
    return (Array.isArray(d?.models) ? d.models : []).map((m) => String(m?.name || '')).filter(Boolean)
  } catch { return [] }
}
