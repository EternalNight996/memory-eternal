// 记忆核心 · 看门狗（独立进程保活 lib/web.js）。
//
// 用法（经 CLI）：dsh-memory watchdog [--port 7999] [--interval 5] [--max-restart 10]
//
// 行为：
// - 启动时探测端口：活则只监督不接管；死则 spawn 新 web server
// - 周期性探活：HTTP GET /memory-eternal/api/overview（不是我们服务视为死）
// - 探到死：清理残留进程 → spawn 新 web server → restart 计数 +1
// - restart 超过 max-restart（默认 10）→ fatal 退出，不再保活
// - SIGINT/SIGTERM：优雅退出（停掉 watchdog 自己拉起的 web，但不动用户手动起的）
// - 所有状态输出到 stderr（看门狗 daemon 的标准约定）
//
// 独立性：watchdog 完全独立于 DSH 宿主——即便旧版插件（无 autoWeb）跑的
// DSH 环境，watchdog 也能拉起并保活 web server，让浏览器始终可达。

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { nodeBinary, childEnv } from './node-bin.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WEB_JS = path.join(__dirname, 'web.js')
const API_PREFIX = '/memory-eternal/api'
// -- 单例锁 -------------------------------------------------------------------
// 每个 DSH 启动都会 spawn 一个 detached watchdog，而旧代码没有任何存活检查 ——
// 多次重启就堆积多个 watchdog 常驻轮询同一端口（dsh-memory-eternal#6）。
// 这里用一个 pid 锁文件：同端口已有活着的 watchdog 就让它直接退出。
const LOCK_NAME = 'memory-eternal-watchdog.json'

/** 锁文件路径（$DSH_HOME 下，与共享配置同处）。 */
export function watchdogLockPath(env = process.env) {
  return path.join(env.DSH_HOME || path.join(os.homedir(), '.dsh'), LOCK_NAME)
}

/** 进程是否存活（Windows 下 process.kill(pid,0) 同样可用；EPERM 说明进程在但无权限）。 */
export function isPidAlive(pid) {
  const n = Number(pid)
  if (!n || n <= 0) return false
  if (n === process.pid) return true
  try { process.kill(n, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/**
 * 读取锁文件，归一化成 { watchdogs: [{pid, port, vault, startedAt}] }。
 * 兼容早期单槽格式（顶层就是 {pid, port}）：多端口/多 vault 并存时需要多槽。
 */
export function readWatchdogLock(env = process.env) {
  let raw = null
  try { raw = JSON.parse(fs.readFileSync(watchdogLockPath(env), 'utf8')) } catch { return { watchdogs: [] } }
  if (!raw || typeof raw !== 'object') return { watchdogs: [] }
  if (Array.isArray(raw.watchdogs)) return { watchdogs: raw.watchdogs.filter((w) => w && w.pid) }
  if (raw.pid) return { watchdogs: [raw] } // 旧格式
  return { watchdogs: [] }
}

function writeWatchdogLock(env, list) {
  const file = watchdogLockPath(env)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ watchdogs: list }))
  } catch { /* 写不了锁不阻塞保活 */ }
}

/**
 * 尝试取得看门狗锁（按端口分槽）。
 * @returns {{acquired:boolean, file:string, previous:object|null, reaped:number[]}} acquired=false 表示同端口已有活着的看门狗，调用方应直接退出。
 */
export function acquireWatchdogLock({ env = process.env, port, vault = '', pid = process.pid } = {}) {
  const file = watchdogLockPath(env)
  const cur = readWatchdogLock(env)
  const samePort = cur.watchdogs.filter((w) => Number(w.port) === Number(port) && w.pid !== pid)
  const alive = samePort.find((w) => isPidAlive(w.pid))
  if (alive) return { acquired: false, file, previous: alive, reaped: [] }
  // 清掉死掉的槽（含其它端口的陈旧记录），保留仍然存活的其它端口
  const reaped = []
  const kept = []
  for (const w of cur.watchdogs) {
    if (Number(w.port) === Number(port)) { reaped.push(w.pid); continue }
    if (isPidAlive(w.pid)) kept.push(w)
    else reaped.push(w.pid)
  }
  const previous = samePort[0] || (reaped.length ? { pid: reaped[0] } : null)
  kept.push({ pid, port: Number(port), vault, startedAt: new Date().toISOString() })
  writeWatchdogLock(env, kept)
  return { acquired: true, file, previous, reaped }
}

/** 释放锁（只清自己那一槽；没有其它槽就删文件）。 */
export function releaseWatchdogLock({ env = process.env, pid = process.pid } = {}) {
  const cur = readWatchdogLock(env)
  const kept = cur.watchdogs.filter((w) => w.pid !== pid)
  if (kept.length === cur.watchdogs.length) return false
  if (!kept.length) { try { fs.unlinkSync(watchdogLockPath(env)) } catch { /* 已不存在 */ } return true }
  writeWatchdogLock(env, kept)
  return true
}

/**
 * 解析进程列表（纯函数，便于单测）。
 * 支持 `ps -eo pid,args` 与 Windows 的 `ConvertTo-Csv` 两种输入。
 * @returns {Array<{pid:number, port:number, command:string}>} 只保留命令行里带 watchdog.js 的 node 进程
 */
export function parseWatchdogProcesses(text, platform = process.platform) {
  const out = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || !line.includes('watchdog.js')) continue
    let pid = 0
    let command = line
    const csv = /^"?(\d+)"?,(.*)$/.exec(line) // Windows: "1234","node ... watchdog.js --port 7999"
    const ps = /^(\d+)\s+(.*)$/.exec(line)      // POSIX: 1234 node ... watchdog.js --port 7999
    if (csv) { pid = Number(csv[1]); command = csv[2].replace(/^"|"$/g, '') }
    else if (ps) { pid = Number(ps[1]); command = ps[2] }
    if (!pid) continue
    const m = /--port\s+(\d+)/.exec(command)
    out.push({ pid, port: m ? Number(m[1]) : 7999, command })
  }
  return out
}

/** 列出机器上所有 watchdog 进程（平台相关，失败返回空数组）。 */
async function listWatchdogProcesses(exec, platform = process.platform) {
  if (platform === 'win32') {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"
    const out = await exec('powershell', ['-NoProfile', '-Command', ps])
    return parseWatchdogProcesses(out, 'win32')
  }
  const out = await exec('ps', ['-eo', 'pid,args'])
  return parseWatchdogProcesses(out, 'linux')
}

/**
 * 回收历史遗留的孤儿看门狗（新锁只能防新增，管不了升级前已经在跑的）。
 * 只杀「命令行是 watchdog.js + 端口相同 + pid 不是自己 + 不在锁里存活」的进程。
 * @returns {Promise<{scanned:number, killed:number[], skipped:number[]}>}
 */
export async function reapStaleWatchdogs({ port = 7999, keepPid = process.pid, env = process.env, exec, list, kill } = {}) {
  const runExec = exec || (async (cmd, args) => {
    const { spawn } = await import('node:child_process')
    return await new Promise((resolve) => {
      const c = spawn(cmd, args, { windowsHide: true })
      let buf = ''
      c.stdout.on('data', (d) => { buf += d })
      c.on('error', () => resolve(''))
      c.on('close', () => resolve(buf))
    })
  })
  const procs = list ? await list() : await listWatchdogProcesses(runExec)
  const lock = readWatchdogLock(env)
  const lockedAlive = new Set(lock.watchdogs.filter((w) => isPidAlive(w.pid)).map((w) => Number(w.pid)))
  const killFn = kill || ((pid) => { try { process.kill(pid, 'SIGTERM'); return true } catch { return false } })
  const killed = []
  const skipped = []
  for (const p of procs) {
    if (Number(p.port) !== Number(port)) { skipped.push(p.pid); continue }
    if (Number(p.pid) === Number(keepPid)) { skipped.push(p.pid); continue }
    if (lockedAlive.has(Number(p.pid))) { skipped.push(p.pid); continue } // 锁里活着的是当前合法实例
    if (!isPidAlive(p.pid)) { skipped.push(p.pid); continue }
    if (killFn(p.pid)) killed.push(p.pid); else skipped.push(p.pid)
  }
  return { scanned: procs.length, killed, skipped }
}

const ts = () => new Date().toISOString().slice(11, 19) // HH:MM:SS
const log = (...args) => process.stderr.write(`[${ts()}] [watchdog] ${args.join(' ')}\n`)

/** 探测某端口是否在响应 + 是我们的服务（响应含 vaultDir 标记）。 */
export async function probe(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: `${API_PREFIX}/overview`, method: 'GET', timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) return resolve(null)
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (data && data.ok === true && typeof data.vaultDir === 'string') return resolve(data)
          resolve(null)
        } catch { resolve(null) }
      })
      res.on('error', () => resolve(null))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.end()
  })
}

/** 探测端口是否有任何 TCP 监听（即便不是我们的服务也占用）。 */
export async function probeTcp(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const s = new net.Socket()
    s.setTimeout(timeoutMs)
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('timeout', () => { s.destroy(); resolve(false) })
    s.once('error', () => resolve(false))
    s.connect(port, '127.0.0.1')
  })
}

/**
 * 启动看门狗。返回对象含 .stop() 优雅退出。
 * @param {object} opts
 * @param {number} [opts.port=7999]
 * @param {string} [opts.vaultRoot]    // 默认 ~/.dsh/memory-vault
 * @param {number} [opts.interval=5000]
 * @param {number} [opts.maxRestart=10]
 * @param {boolean} [opts.autoStart=true]  // 首次探测到死时是否自动拉起
 */
export function startWatchdog({ port = 7999, vaultRoot, interval = 5000, maxRestart = 10, autoStart = true } = {}) {
  let child = null   // 我们 spawn 的 web 进程（最近一次）
  const spawned = new Map() // child -> 它监听的端口（用于回收多余实例）
  let ownedByUs = false
  let restartCount = 0
  let stopped = false
  let timer = null

  // 找空闲端口：port, port+1, ... 最多 +10
  const findFreePort = async (start) => {
    for (let p = start; p < start + 10; p++) {
      if (await probeTcp(p) === false) return p
    }
    return start
  }

  const spawnWeb = async () => {
    if (child && !child.killed) {
      try { child.kill('SIGTERM') } catch {}
    }
    const targetPort = await findFreePort(port)
    const args = [WEB_JS, '--port', String(targetPort)]
    if (vaultRoot) args.push('--vault', vaultRoot)
    log(`spawn web: ${nodeBinary()} ${args.join(' ')}`)
    const c = spawn(nodeBinary(), args, {
      detached: true,
      stdio: 'ignore',
      env: childEnv({ MEMORY_VAULT_DIR: vaultRoot || process.env.MEMORY_VAULT_DIR || '' }),
      windowsHide: true,
    })
    // spawn 失败默认静默，显式记录（Electron 宿主下曾因此完全无迹可查）
    c.on('error', (error) => {
      log(`web spawn failed (${nodeBinary()}): ${error?.message || error}`)
    })
    c.on('exit', (code, sig) => {
      spawned.delete(c)
      if (!stopped && code !== 0) log(`web exited code=${code} sig=${sig}`)
    })
    c.unref()
    spawned.set(c, targetPort)
    child = c
    ownedByUs = true
    return targetPort
  }

  /**
   * 回收「跑到备用端口上的多余实例」。
   *
   * findFreePort 会在目标端口被占时退到 port+1…（曾经因此留下一个 8000 的重复 web
   * 进程常驻 66MB，而 tick 只探目标端口，永远发现不了）。目标端口确认可用后，
   * 把不在目标端口上的自家子进程收掉即可（只杀我们自己 spawn 的，不动用户手起的）。
   */
  const reapExtraChildren = () => {
    for (const [c, p] of spawned) {
      if (p === port) continue
      if (c.exitCode !== null || c.killed) { spawned.delete(c); continue }
      try { c.kill('SIGTERM') } catch {}
      spawned.delete(c)
      log(`目标端口 ${port} 已可用 → 回收多余实例（端口 ${p}，pid ${c.pid}）`)
    }
  }

  const tick = async () => {
    if (stopped) return
    const alive = await probe(port)
    if (alive) {
      // 是我们的服务
      if (!ownedByUs) {
        log(`port ${port} 已存活（外部实例）→ 切换为保活模式（不接管）`)
        ownedByUs = true // 至少逻辑上"知道"它活了
      }
      reapExtraChildren()
      return
    }
    // 端口死
    if (restartCount >= maxRestart) {
      log(`restart 次数达上限 ${maxRestart} → 退出看门狗（请人工排查）`)
      stop()
      return
    }
    if (!autoStart) {
      log(`port ${port} 已死，但 --no-restart 设置，跳过`)
      return
    }
    restartCount += 1
    log(`port ${port} 离线 → 第 ${restartCount} 次拉起 web server`)
    try {
      const newPort = await spawnWeb()
      // 等待 ready
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500))
        const a = await probe(newPort)
        if (a) {
          log(`web 在 ${newPort} 就绪（vault: ${a.vaultDir}）`)
          if (newPort !== port) log(`提示：目标端口 ${port} 被占，watchdog 在 ${newPort} 上保活`)
          return
        }
      }
      log(`web 未能在 15s 内就绪`)
    } catch (error) {
      log(`spawn 失败：${error?.message || error}`)
    }
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) { clearInterval(timer); timer = null }
    for (const c of spawned.keys()) {
      if (c.exitCode === null && !c.killed) {
        try { c.kill('SIGTERM') } catch {}
        setTimeout(() => { try { c.kill('SIGKILL') } catch {} }, 1000).unref()
      }
    }
    spawned.clear()
    log('看门狗退出')
    process.exit(0)
  }

  // 首次探测
  ;(async () => {
    const alive = await probe(port)
    if (alive) {
      log(`port ${port} 已活（外部实例），启动保活监督（间隔 ${interval}ms）`)
    } else if (autoStart) {
      log(`port ${port} 离线 → 首次拉起 web`)
      restartCount += 1
      try {
        const np = await spawnWeb()
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 500))
          if (await probe(np)) { log(`web 在 ${np} 就绪`); break }
        }
      } catch (e) { log(`首次拉起失败：${e?.message || e}`) }
    }
    timer = setInterval(tick, interval)
  })()

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return { stop, get port() { return port }, get restartCount() { return restartCount } }
}

// 脚本入口：node lib/watchdog.js [--port N] [--interval MS] [--max-restart N] [--vault DIR]
if (process.argv[1] && /[\\/]watchdog\.js$/.test(process.argv[1])) {
  const argv = process.argv.slice(2)
  const argOf = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
  }
  const port = Number(argOf('--port')) || 7999
  const interval = Number(argOf('--interval')) || 5000
  const maxRestart = Number(argOf('--max-restart')) || 10
  const vaultRoot = argOf('--vault') || undefined
  const autoStart = !argv.includes('--no-restart')
  if (argv.includes('--reap')) {
    const out = await reapStaleWatchdogs({ port, keepPid: 0 })
    log(`回收孤儿看门狗：扫描 ${out.scanned} 个，清理 ${out.killed.length} 个${out.killed.length ? '（pid ' + out.killed.join(', ') + '）' : ''}，保留 ${out.skipped.length} 个`)
    process.exit(0)
  }
  const lock = acquireWatchdogLock({ port, vault: vaultRoot || '' })
  if (!lock.acquired) {
    log('同端口已有看门狗在跑（pid ' + (lock.previous && lock.previous.pid) + '，启动于 ' + (lock.previous && lock.previous.startedAt) + '）→ 本次启动退出，避免进程堆积')
    process.exit(0)
  }
  if (lock.previous) log('清理陈旧看门狗记录（pid ' + lock.previous.pid + ' 已不存在）')
  process.on('exit', () => releaseWatchdogLock())
  startWatchdog({ port, interval, maxRestart, vaultRoot, autoStart })
  log('看门狗已启动（pid ' + process.pid + '，端口 ' + port + '）')
}