// 本地嵌入服务（Ollama）的启动 / 停止 / 状态探测
//
// 为什么需要它：面板上「服务不可达」是这套可选功能最常见的卡点 —— 用户看到红点，
// 唯一的自解方案是打开终端敲 `OLLAMA_HOST=127.0.0.1:7997 ollama serve`。
// 这里把这步做成面板上一个按钮：点「启动服务」→ 拉起（或复用）→ 轮询到就绪 → 返回可用的 baseUrl。
//
// 三条硬约束：
//   1. **只停自己启动的进程**：pid 记在状态文件里；用户自己起的 Ollama（11434 / 7979）一律不碰。
//   2. **能复用就复用**：11434 已经有服务在跑时直接指过去，不重复起进程。
//   3. **失败要说人话**：找不到 exe、起不来、超时，分别给不同的 error 码，前端据此给指引。

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const PREFERRED_PORT = 7997
const ALT_PORTS = [11434, 7979]
const STATE_FILE = path.join(String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh'), 'ollama-service.json')

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {} } catch { return {} }
}
function writeState(s) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1), 'utf8')
  } catch { /* 写不进去只影响跨进程 stop，不影响本进程 */ }
}

/** 探测某个 baseUrl 是否是可用的 OpenAI 兼容端点（Ollama 同时提供 /api/tags）。 */
export async function probeBase(base, timeoutMs = 1500) {
  const url = String(base || '').replace(/\/+$/, '')
  if (!url) return { ok: false, kind: '', models: [] }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(url + '/api/tags', { signal: ctl.signal })
    if (r.ok) {
      const j = await r.json().catch(() => ({}))
      return { ok: true, kind: 'ollama', models: (j.models || []).map((m) => String(m.name || '').trim()).filter(Boolean) }
    }
    // 不是 Ollama（比如在线 OpenAI 兼容服务）：/models 能通就算可用
    const r2 = await fetch(url + '/models', { signal: ctl.signal })
    if (r2.ok) return { ok: true, kind: 'openai', models: [] }
    return { ok: false, kind: '', models: [] }
  } catch {
    return { ok: false, kind: '', models: [] }
  } finally { clearTimeout(timer) }
}

/** 找 ollama 可执行文件（先问 PATH，再问常见安装位置）。 */
export function findOllamaExe(env = process.env) {
  const explicit = String(env.MEMORY_OLLAMA_EXE || '').trim()
  if (explicit && fs.existsSync(explicit)) return explicit
  const cands = [
    path.join(env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    'C:\\Program Files\\Ollama\\ollama.exe',
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe'),
    '/usr/local/bin/ollama',
    '/opt/homebrew/bin/ollama',
    '/usr/bin/ollama',
  ].filter(Boolean)
  for (const c of cands) { try { if (fs.existsSync(c)) return c } catch { /* 忽略 */ } }
  try {
    const which = process.platform === 'win32' ? ['where', ['ollama']] : ['which', ['ollama']]
    const out = execFileSync(which[0], which[1], { encoding: 'utf8', timeout: 3000 }).trim().split(/\r?\n/)[0]
    if (out && fs.existsSync(out)) return out
  } catch { /* PATH 里没有 */ }
  return ''
}

function isAlive(pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try { process.kill(n, 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

/**
 * 状态：优先看「我们启动的进程」，再看端口探活。
 * @returns {{installed:boolean, exe:string, running:boolean, managed:boolean, pid:number, baseUrl:string, reuse:boolean}}
 */
export async function serviceStatus(env = process.env) {
  const exe = findOllamaExe(env)
  const st = readState()
  const managedAlive = isAlive(st.pid)
  const probePreferred = await probeBase(`http://127.0.0.1:${PREFERRED_PORT}/v1`)
  if (probePreferred.ok) {
    return { installed: !!exe, exe, running: true, managed: managedAlive, pid: managedAlive ? st.pid : 0, baseUrl: `http://127.0.0.1:${PREFERRED_PORT}/v1`, reuse: !managedAlive }
  }
  for (const p of ALT_PORTS) {
    const pr = await probeBase(`http://127.0.0.1:${p}/v1`)
    if (pr.ok) return { installed: !!exe, exe, running: true, managed: false, pid: 0, baseUrl: `http://127.0.0.1:${p}/v1`, reuse: true }
  }
  return { installed: !!exe, exe, running: false, managed: false, pid: managedAlive ? st.pid : 0, baseUrl: '', reuse: false }
}

/**
 * 启动：能复用就复用，否则拉起 `ollama serve`（OLLAMA_HOST 指向 7997）并等到就绪。
 * @param {{env?:NodeJS.ProcessEnv, timeoutMs?:number}} [opts]
 */
export async function startService({ env = process.env, timeoutMs = 30000 } = {}) {
  const before = await serviceStatus(env)
  if (before.running) return { ok: true, reused: true, ...before }
  const exe = findOllamaExe(env)
  if (!exe) return { ok: false, code: 'NO_BINARY', error: '没有找到 ollama 可执行文件（可手动安装，或把路径写进 MEMORY_OLLAMA_EXE）', ...before }

  let child
  try {
    child = spawn(exe, ['serve'], {
      env: { ...env, OLLAMA_HOST: `127.0.0.1:${PREFERRED_PORT}` },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch (e) {
    return { ok: false, code: 'SPAWN_FAILED', error: String((e && e.message) || e), ...before }
  }
  writeState({ pid: child.pid, at: Date.now(), exe, port: PREFERRED_PORT })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pr = await probeBase(`http://127.0.0.1:${PREFERRED_PORT}/v1`, 1200)
    if (pr.ok) {
      return {
        ok: true, reused: false, installed: true, exe, running: true, managed: true,
        pid: child.pid, baseUrl: `http://127.0.0.1:${PREFERRED_PORT}/v1`, models: pr.models,
      }
    }
    await new Promise((r) => setTimeout(r, 600))
  }
  return { ok: false, code: 'TIMEOUT', error: `等了 ${Math.round(timeoutMs / 1000)} 秒服务仍未就绪（进程 pid ${child.pid} 已启动，可稍后点「刷新状态」）`, installed: true, exe, running: false, managed: true, pid: child.pid, baseUrl: '' }
}

/** 停止：**只停本插件启动的进程**；用户自己起的一律不碰。 */
export async function stopService({ env = process.env } = {}) {
  const st = readState()
  const pid = Number(st.pid)
  if (!isAlive(pid)) {
    const now = await serviceStatus(env)
    if (now.running) return { ok: false, code: 'NOT_MANAGED', error: '这个服务不是面板启动的，不做停止（请在启动它的地方关闭）', ...now }
    return { ok: true, stopped: false, already: true, ...now }
  }
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 8000 })
    else process.kill(pid, 'SIGTERM')
  } catch (e) {
    return { ok: false, code: 'KILL_FAILED', error: String((e && e.message) || e), pid }
  }
  writeState({ pid: 0, at: Date.now(), exe: st.exe || '', port: st.port || PREFERRED_PORT })
  // 等端口释放
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const pr = await probeBase(`http://127.0.0.1:${PREFERRED_PORT}/v1`, 800)
    if (!pr.ok) break
    await new Promise((r) => setTimeout(r, 400))
  }
  const after = await serviceStatus(env)
  return { ok: true, stopped: !after.running, pid, ...after }
}
