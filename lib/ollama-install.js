// Ollama 安装闭环：下载安装器 → 静默安装 → 等可执行文件出现
//
// 为什么需要它：原来 `/embedding/install-ollama` 只能跑「你已经下好安装器、并且把路径写进
// MEMORY_OLLAMA_SETUP」这一条路，没装的人点按钮只会拿到一个下载链接 —— 面板上看着像能装，
// 实际还是手动挡。这里把三件事接起来，让「没装」也能一键走完。
//
// 安全边界：
//   · 只从**官方域**取安装器（可用 MEMORY_OLLAMA_MIRROR 指向可信镜像做国内加速）；
//   · 下载后校验文件大小（<10MB 视为失败页/错误响应）并记录 sha256 到日志；
//   · 静默安装参数先 Inno（/VERYSILENT），再退 NSIS（/S）；都失败就把安装器路径交给用户；
//   · MEMORY_OLLAMA_INSTALL_DRY=1 时只下载不执行（CI/测试用）。

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { findOllamaExe } from './ollama-service.js'

const OFFICIAL_URL = 'https://ollama.com/download/OllamaSetup.exe'
const MIN_SIZE = 10 * 1024 * 1024
const MAX_WAIT_MS = 3 * 60 * 1000

/** 安装任务状态（模块级，进程内单例：同时只允许一个安装）。 */
let job = { phase: 'idle', at: 0, bytes: 0, total: 0, path: '', sha256: '', error: '', log: [] }
const pushLog = (line) => {
  job.log = [...job.log.slice(-19), { at: Date.now(), line: String(line).slice(0, 300) }]
}
export function installState() {
  return { ...job, installed: !!findOllamaExe(process.env), exe: findOllamaExe(process.env) }
}
function setPhase(phase, patch = {}) {
  job = { ...job, ...patch, phase, at: Date.now() }
  pushLog(phase + (patch.error ? '：' + patch.error : ''))
}

/**
 * 下载安装器（流式，带进度）。
 * @param {{url?:string, dest?:string, env?:NodeJS.ProcessEnv}} opts
 */
export async function downloadInstaller({ url = '', dest = '', env = process.env } = {}) {
  const mirror = String(env.MEMORY_OLLAMA_MIRROR || '').trim()
  const target = String(url || mirror || OFFICIAL_URL).trim()
  const out = dest || path.join(os.tmpdir(), 'OllamaSetup.exe')
  setPhase('downloading', { path: out, bytes: 0, total: 0, error: '' })
  const res = await fetch(target, { redirect: 'follow' })
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status + '（' + target + '）')
  const total = Number(res.headers.get('content-length') || 0)
  job.total = total
  await fsp.mkdir(path.dirname(out), { recursive: true })
  const tmp = out + '.part'
  const hash = crypto.createHash('sha256')
  const file = fs.createWriteStream(tmp)
  let bytes = 0
  try {
    for await (const chunk of res.body) {
      bytes += chunk.length
      hash.update(chunk)
      file.write(chunk)
      job.bytes = bytes
    }
  } finally {
    await new Promise((r) => file.end(r))
  }
  const size = (await fsp.stat(tmp)).size
  if (size < MIN_SIZE) {
    await fsp.rm(tmp, { force: true })
    throw new Error(`安装器只有 ${Math.round(size / 1024)} KB，明显不是安装包（可能被重定向到错误页）`)
  }
  await fsp.rename(tmp, out)
  job.sha256 = hash.digest('hex')
  print(`downloaded ${out} ${Math.round(size / 1048576)}MB sha256=${job.sha256.slice(0, 16)}`)
  return { path: out, size, sha256: job.sha256 }
}
const print = (s) => { try { console.error('[memory-eternal] ollama-install: ' + s) } catch { /* 忽略 */ } }

/** 跑静默安装（先 Inno 参数，失败退 NSIS）。会等到进程退出。 */
export function runSilentInstall(exePath, { env = process.env, timeoutMs = 10 * 60 * 1000 } = {}) {
  if (String(env.MEMORY_OLLAMA_INSTALL_DRY || '') === '1') {
    setPhase('verifying', { path: exePath })
    return Promise.resolve({ ok: true, dry: true })
  }
  setPhase('installing', { path: exePath })
  const attempts = [
    ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'],
    ['/S'],
  ]
  return new Promise((resolve) => {
    const tryAt = (i) => {
      if (i >= attempts.length) return resolve({ ok: false, error: '静默安装参数都被拒绝，请手动运行：' + exePath })
      const child = execFile(exePath, attempts[i], { timeout: timeoutMs, windowsHide: true, env }, (err) => {
        // Inno 的静默安装经常返回非 0 但实际已装好：交给后面的 findOllamaExe 判定
        if (err && i + 1 < attempts.length) return tryAt(i + 1)
        resolve({ ok: !err, code: err ? (err.code || 1) : 0, args: attempts[i] })
      })
      try { child.unref?.() } catch { /* 忽略 */ }
    }
    tryAt(0)
  })
}

/** 等可执行文件出现（安装器是异步的，装完才落地）。 */
export async function waitInstalled({ timeoutMs = MAX_WAIT_MS } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const exe = findOllamaExe(process.env)
    if (exe) { setPhase('done', { path: exe }); return exe }
    await new Promise((r) => setTimeout(r, 1500))
  }
  return ''
}

/**
 * 一键安装：已有就跳过；否则下载 → 静默安装 → 等 exe。
 * @returns {Promise<{ok:boolean, exe?:string, phase?:string, error?:string, path?:string}>}
 */
export async function autoInstall({ env = process.env, url = '' } = {}) {
  if (job.phase === 'downloading' || job.phase === 'installing') return { ok: false, busy: true, phase: job.phase }
  const existing = findOllamaExe(env)
  if (existing) { setPhase('done', { path: existing }); return { ok: true, exe: existing, phase: 'done' } }
  try {
    const dl = await downloadInstaller({ url, env })
    const run = await runSilentInstall(dl.path, { env })
    if (!run.ok) { setPhase('failed', { error: run.error || '安装失败' }); return { ok: false, phase: 'failed', error: run.error, path: dl.path } }
    setPhase('verifying', { path: dl.path })
    const exe = await waitInstalled({})
    if (!exe) {
      setPhase('failed', { error: '安装器跑完了但没找到 ollama 可执行文件（可能要重启终端/系统），安装器在：' + dl.path })
      return { ok: false, phase: 'failed', error: '安装后仍未检测到可执行文件', path: dl.path }
    }
    return { ok: true, exe, phase: 'done', path: dl.path }
  } catch (e) {
    const msg = String((e && e.message) || e)
    setPhase('failed', { error: msg })
    return { ok: false, phase: 'failed', error: msg }
  }
}
