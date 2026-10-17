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
const PKG_JSON = path.join(__dirname, '..', 'package.json')
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

/**
 * 当前包的版本号（写进锁文件，用于发现「常驻实例是旧版」这一漂移，issue #19）。
 * 读不到就返回空串（不影响保活）。
 */
export function currentPkgVersion() {
  try { return String(JSON.parse(fs.readFileSync(PKG_JSON, 'utf8')).version || '') } catch { return '' }
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

let lockWarned = false

function writeWatchdogLock(env, list) {
  const file = watchdogLockPath(env)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ watchdogs: list }))
  } catch (e) {
    // 写不了锁**不阻塞保活**，但不能再全静默：这是「托管状态判不出来」的根因（issue #33 第③层，
    // 实测受限环境写不进锁 → 面板显示「未托管」而端口上其实有健康实例）。留一条可查的痕。
    if (!lockWarned) {
      lockWarned = true
      console.error('[memory-eternal] 看门狗锁文件写不进去（' + file + '）：' + String((e && e.message) || e) + ' —— 保活不受影响，但「是否被托管」将无法判断')
    }
  }
}

/**
 * 探测「锁文件所在目录现在写不写得了」—— **只探测，不碰锁文件本身**（避免把真实状态写坏）。
 *
 * 用途（issue #33 第③层）：面板要区分「**确实没被托管**」与「**判不出来**（受限环境写不进锁）」
 * —— 后者不该被显示成「未托管 / 未运行」，那会让用户以为实例坏了，跑去反复重启。
 */
export function probeLockWritable(env = process.env) {
  const file = watchdogLockPath(env)
  const probe = path.join(path.dirname(file), '.me-lock-probe-' + process.pid + '-' + Date.now())
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    return { writable: true, path: file, error: '' }
  } catch (e) {
    try { fs.unlinkSync(probe) } catch { /* 清不掉也无妨 */ }
    return { writable: false, path: file, error: String((e && e.message) || e) }
  }
}

/**
 * 尝试取得看门狗锁（按端口分槽）。
 * @returns {{acquired:boolean, file:string, previous:object|null, reaped:number[]}} acquired=false 表示同端口已有活着的看门狗，调用方应直接退出。
 */
export function acquireWatchdogLock({ env = process.env, port, vault = '', pid = process.pid, pkgVersion = currentPkgVersion(), force = false } = {}) {
  const file = watchdogLockPath(env)
  const cur = readWatchdogLock(env)
  const samePort = cur.watchdogs.filter((w) => Number(w.port) === Number(port) && w.pid !== pid)
  // endedAt 的槽是「已结束」的记录（releaseWatchdogLock 留下的痕迹，见 #30）：**绝不能挡住新实例**
  // —— pid 可能已被复用、那个进程还活着，但那条记录明确表示它已经交出这把锁。
  const alive = samePort.find((w) => !w.endedAt && isPidAlive(w.pid))
  // force：--replace 助手的语义就是「替换同端口那个」。不允许让位 —— 否则旧实例还活着时
  // 新助手直接退出，而清场那一步可能根本没跑完（issue #30 实测：清场被十几秒的枚举拖住 →
  // 助手退在写锁之前 → 锁永远为空 → verify 必然超时、restart 100% 失败）。
  if (alive && !force) return { acquired: false, file, previous: alive, reaped: [] }
  // 清掉死掉的槽（含其它端口的陈旧记录），保留仍然存活的其它端口
  const reaped = []
  const kept = []
  for (const w of cur.watchdogs) {
    if (Number(w.port) === Number(port)) { reaped.push(w.pid); continue }
    if (!w.endedAt && isPidAlive(w.pid)) kept.push(w)
    else reaped.push(w.pid)
  }
  const previous = samePort[0] || (reaped.length ? { pid: reaped[0] } : null)
  kept.push({ pid, port: Number(port), vault, startedAt: new Date().toISOString(), ...(pkgVersion ? { pkgVersion } : {}) })
  writeWatchdogLock(env, kept)
  return { acquired: true, file, previous, reaped }
}

/**
 * 释放锁（只清自己那一槽）。
 *
 * issue #30 实测：旧实现在「没有其它槽」时**直接删文件** —— 于是一次失败的重启/意外退出之后，
 * 现场看起来像「从来没有过常驻实例」，而端口上那个 web 还在跑（孤儿）。现在**保留文件**并留一个
 * `endedAt` 标记的槽：status 会显示「已退出（陈旧记录）」，下次 acquire 再正常回收它。
 */
export function releaseWatchdogLock({ env = process.env, pid = process.pid, keepEnded = true } = {}) {
  const cur = readWatchdogLock(env)
  const kept = cur.watchdogs.filter((w) => w.pid !== pid)
  if (kept.length === cur.watchdogs.length) return false
  const ended = cur.watchdogs.filter((w) => w.pid === pid).map((w) => ({ ...w, endedAt: new Date().toISOString() }))
  writeWatchdogLock(env, kept.length ? kept : (keepEnded ? ended.slice(-1) : []))
  return true
}

/**
 * 把「替换前的锁登记」写回去（issue #30：失败的 restart 不能把登记抹掉）。
 * 只补本端口、且当前没有**活着的**同端口登记时才写，避免覆盖新实例的登记。
 * @returns {boolean} 是否真的写回
 */
/**
 * 「接管助手」的单飞互斥（issue #30 第六轮实测）：宿主 tick 与 CLI 会各自拉起一个 `--replace`，
 * 两个助手谁都不写锁、还互相收对方的 web —— 现场更难复盘。用一个 claim 文件做互斥：
 * 助手开工前独占创建；已存在且**持有者还活着 + 没过期**就退出（不抢）。
 *
 * 失败开放（fail-open）：受限环境写不了 claim 时**照常进行**（不能让权限问题把接管彻底堵死），
 * 但要留一条可查的理由。
 */
export function replaceClaimPath(env = process.env) {
  return path.join(path.dirname(watchdogLockPath(env)), 'memory-eternal-replace.claim')
}

/** 读当前 claim（不存在/损坏返回 null）。 */
export function readReplaceClaim(env = process.env) {
  try {
    const d = JSON.parse(fs.readFileSync(replaceClaimPath(env), 'utf8'))
    if (!d || typeof d !== 'object' || !d.pid) return null
    return d
  } catch { return null }
}

/** 抢 claim：抢到 true；有人在跑则是 false（附持有者信息）。 */
export function claimReplaceSlot({ env = process.env, port = 0, pid = process.pid, staleMs = 60000, now = Date.now() } = {}) {
  const file = replaceClaimPath(env)
  const cur = readReplaceClaim(env)
  if (cur) {
    const fresh = now - Number(cur.at || 0) < Math.max(1000, Number(staleMs) || 60000)
    if (fresh && Number(cur.pid) !== Number(pid) && isPidAlive(cur.pid)) {
      return { claimed: false, holder: cur, reason: '已有接管助手在跑（pid ' + cur.pid + '，' + Math.round((now - Number(cur.at || now)) / 1000) + 's 前）' }
    }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ pid: Number(pid), port: Number(port) || 0, at: now }))
    return { claimed: true, holder: cur || null, reason: cur ? '接管了陈旧 claim' : '抢到 claim' }
  } catch (e) {
    return { claimed: true, holder: cur || null, reason: 'claim 写不进去（' + String((e && e.message) || e) + '）→ 失败开放，继续接管' }
  }
}

/** 释放 claim（只清自己那条；别人的不动）。 */
export function releaseReplaceClaim({ env = process.env, pid = process.pid } = {}) {
  const cur = readReplaceClaim(env)
  if (cur && Number(cur.pid) !== Number(pid)) return false
  try { fs.unlinkSync(replaceClaimPath(env)); return true } catch { return false }
}

export function restoreWatchdogLock({ env = process.env, port, watchdogs = [] } = {}) {
  const p = Number(port) || 0
  const want = (Array.isArray(watchdogs) ? watchdogs : []).filter((w) => Number(w.port) === p)
  if (!want.length) return false
  const cur = readWatchdogLock(env)
  // 必须排除 endedAt 槽（与 acquireWatchdogLock 同一口径）——报告者实测：PID 复用/正在退出时，
  // 一条本端口的 endedAt 槽会让这里误判「已有活着的登记」而放弃写回。
  const liveSame = cur.watchdogs.filter((w) => Number(w.port) === p && !w.endedAt && isPidAlive(w.pid))
  if (liveSame.length) return false
  const others = cur.watchdogs.filter((w) => Number(w.port) !== p && isPidAlive(w.pid))
  writeWatchdogLock(env, [...others, ...want.map((w) => ({ ...w, restoredAt: new Date().toISOString() }))])
  return true
}

/**
 * 就地更新某一槽的字段（不存在则忽略）。
 *
 * 用途：watchdog spawn / 回收 web 子进程时，把 webPid / webPort 记进锁里 ——
 * Windows 上 `process.kill(pid,'SIGTERM')` 是**无条件终止**，watchdog 的 stop() 处理器
 * 根本不会执行，所以「停看门狗」时必须靠这份记录才能连带收掉它拉起的 web（issue #19）。
 *
 * @returns {object|null} 更新后的槽；槽不存在时返回 null
 */
export function updateWatchdogSlot({ env = process.env, pid = process.pid, patch = {} } = {}) {
  const cur = readWatchdogLock(env)
  let hit = null
  const next = cur.watchdogs.map((w) => {
    if (Number(w.pid) !== Number(pid)) return w
    hit = { ...w, ...patch }
    return hit
  })
  if (!hit) return null
  writeWatchdogLock(env, next)
  return hit
}

/**
 * 看门狗运行状态（issue #19 的 `dsh-memory status`）：锁文件里登记了什么、谁还活着、
 * 版本是否与本机磁盘上的包一致。
 * @returns {{lockPath:string, pkgVersion:string, watchdogs:Array<object>}}
 */
export function watchdogStatus({ env = process.env, port } = {}) {
  const pkgVersion = currentPkgVersion()
  const want = port === undefined || port === null || port === '' ? null : Number(port)
  const list = readWatchdogLock(env).watchdogs
    .filter((w) => want === null || Number(w.port) === want)
    .map((w) => ({
      pid: Number(w.pid),
      port: Number(w.port),
      vault: String(w.vault || ''),
      startedAt: String(w.startedAt || ''),
      pkgVersion: String(w.pkgVersion || ''),
      alive: isPidAlive(w.pid),
      versionMismatch: !!(w.pkgVersion && pkgVersion && String(w.pkgVersion) !== pkgVersion),
      webPid: Number(w.webPid) || 0,
      webPort: Number(w.webPort) || 0,
      webAlive: !!(Number(w.webPid) > 0 && isPidAlive(w.webPid)),
    }))
  return { lockPath: watchdogLockPath(env), pkgVersion, watchdogs: list }
}

/**
 * 显式停止常驻看门狗（issue #19：此前只能手工 kill）。
 *
 * 只动**锁文件里登记、且真的活着**的实例；SIGTERM → 等它退出 → 清锁槽。
 * 多会话共用同一个 watchdog，所以这是显式命令，绝不在配置变更时自动调用。
 *
 * @param {object} opts
 * @param {number|string} [opts.port] 只停这个端口；缺省 = 锁里所有端口
 * @param {number} [opts.timeoutMs] 等待退出的上限
 * @param {(pid:number)=>boolean} [opts.kill] 注入用（单测）
 * @param {(pid:number)=>boolean} [opts.isAlive] 注入用（单测）
 * @param {()=>Promise<Array<{pid:number,port:number,command:string}>>} [opts.listProcesses] 注入用（单测）
 * @param {boolean} [opts.checkPort] 停完是否再问一次「端口上还有谁在服务」（issue #23）
 * @param {boolean} [opts.forcePortOccupant] 是否连「按端口找到、且确认是本插件的 web」也一起收掉
 * @param {(port:number)=>Promise<{pid:number,command:string}|null>} [opts.findListener] 注入用（单测）
 * @returns {Promise<{stopped:number[], webStopped:number[], failed:number[], skipped:number[],
 *   portOwners:Array<{port:number,pid:number,command:string}>, portStopped:number[], warnings:string[]}>}
 */
export async function stopWatchdogs({ env = process.env, port, timeoutMs = 5000, kill, isAlive, sleep, listProcesses, checkPort = false, forcePortOccupant = false, findListener } = {}) {
  const want = port === undefined || port === null || port === '' ? null : Number(port)
  const alive = isAlive || isPidAlive
  const killFn = kill || ((pid) => { try { process.kill(pid, 'SIGTERM'); return true } catch { return false } })
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const slots = readWatchdogLock(env).watchdogs.filter((w) => want === null || Number(w.port) === want)

  // 先确认「锁里登记的 web 子进程」现在确实是 web.js（防 pid 复用误杀）。
  // 枚举不到（极端环境）就只报 skipped，交由用户手工处理 —— 宁可少杀，不可错杀。
  const wantedWeb = slots.map((w) => ({ pid: Number(w.webPid) || 0, port: Number(w.webPort) || Number(w.port) })).filter((x) => x.pid > 0)
  let confirmedWeb = null
  if (wantedWeb.length) {
    try {
      const procs = listProcesses ? await listProcesses() : await listWatchdogProcesses(defaultExec(), process.platform, 'web.js')
      confirmedWeb = new Set(procs.filter((p) => Number(p.pid) > 0).map((p) => Number(p.pid)))
    } catch { confirmedWeb = null }
  }

  const stopped = []
  const failed = []
  const skipped = []
  for (const w of slots) {
    // 显式清理路径：陈旧槽直接清掉（不留 endedAt 尾巴），与「看门狗自己退出」区分开
    if (!alive(w.pid)) { skipped.push(Number(w.pid)); releaseWatchdogLock({ env, pid: w.pid, keepEnded: false }); continue }
    if (!killFn(w.pid)) { failed.push(Number(w.pid)); continue }
    stopped.push(Number(w.pid))
  }
  // 等它们真的退出（最多 timeoutMs），再清锁槽 —— 否则新实例会以为槽里还是活的
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  while (Date.now() < deadline && stopped.some((pid) => alive(pid))) await wait(100)

  // 收掉 watchdog 拉起的 web：Windows 上 process.kill(pid,'SIGTERM') 是无条件终止，
  // watchdog 的 stop() 处理器不会执行 —— 不在这里收，就会留下一个占着端口的孤儿 web，
  // 而「stop 了却还占端口」正是 issue #19 抱怨的那类不可控状态。
  const webStopped = []
  const webSkipped = []   // issue #23 建议 4：要收但没敢收的，必须留一行可查的话，不能静默
  for (const target of wantedWeb) {
    if (!alive(target.pid)) continue
    if (confirmedWeb && !confirmedWeb.has(target.pid)) {
      skipped.push(target.pid)
      webSkipped.push(target.pid)
      continue
    }
    if (!killFn(target.pid)) { failed.push(target.pid); continue }
    webStopped.push(target.pid)
  }

  for (const pid of [...stopped, ...failed, ...webStopped]) {
    if (alive(pid)) { if (pid !== 0) failed.push(pid); continue }
    releaseWatchdogLock({ env, pid, keepEnded: false })
  }

  // 端口兜底（issue #23）：锁里登记的 webPid 可能压根没写、或者写了却枚举不到，
  // 于是「已停止旧实例」打印了、端口上跑的还是旧代码（升级静默不生效）。
  // 收紧到「直接问操作系统谁占着端口」，不再只信锁；可选地把它一起收掉。
  const warnings = []
  const portOwners = []
  const portStopped = []
  if (webSkipped.length) {
    warnings.push(`锁里登记的 web 子进程 pid ${webSkipped.join(', ')} 未被收掉：在进程列表里没确认到它是 web.js（防 pid 复用误杀，宁可不杀）——若端口仍被占着，请手工结束它`)
  }
  if (checkPort) {
    const ports = want === null
      ? [...new Set(slots.map((w) => Number(w.port) || 0))].filter((p) => p > 0)
      : [want]
    const probeListener = async (p) => {
      try { return findListener ? await findListener(p) : await findPortListener(p) } catch { return null }
    }
    for (const p of ports) {
      const found = await probeListener(p)
      if (found && found.pid) portOwners.push({ port: p, pid: Number(found.pid), command: String(found.command || '') })
    }
    if (portOwners.length && forcePortOccupant) {
      for (const occ of portOwners) {
        if (!looksLikeOurWeb(occ.command)) {
          warnings.push(`端口 ${occ.port} 被 pid ${occ.pid} 占用，但它看起来不是本插件拉起的 web（${occ.command || '命令行未知'}）→ 不自动终止，请人工确认`)
          continue
        }
        if (!killFn(occ.pid)) { warnings.push(`端口 ${occ.port} 上的旧 web（pid ${occ.pid}）未能终止，请手工 kill`); continue }
        const webDeadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
        while (Date.now() < webDeadline && alive(occ.pid)) await wait(100)
        portStopped.push(occ.pid)
      }
    }
    // 收尾复检：这时还占着端口的，就是需要人介入的
    for (const p of ports) {
      const found = await probeListener(p)
      if (!found || !found.pid) continue
      warnings.push(`端口 ${p} 仍被 pid ${found.pid} 占用（${found.command || '命令行未知'}）；status 显示的版本可能不是端口上真正服务的版本`)
    }
    // 顺带回收「上一代退让到 port+1… 的孤儿 web」：它们不在锁里，配置端口的兜底永远够不到它们
    // （8001/8002 上常驻的那两个就是这么来的）。三道门由 sweepOrphanWebs 把握，只收自家的。
    for (const p of ports) {
      try {
        const sweep = await sweepOrphanWebs({ env, port: p, findListener, kill: killFn, isAlive: alive, lock: { watchdogs: readWatchdogLock(env).watchdogs } })
        for (const pid of sweep.killed) portStopped.push(pid)
        for (const w of sweep.warnings) warnings.push(w)
      } catch { /* 回收失败不影响 stop 主流程 */ }
    }
  }
  return {
    stopped: [...new Set(stopped.filter((p) => !failed.includes(p)))],
    webStopped: [...new Set(webStopped.filter((p) => !failed.includes(p)))],
    failed: [...new Set(failed)],
    skipped: [...new Set(skipped)],
    portOwners,
    portStopped: [...new Set(portStopped)],
    warnings,
  }
}

/**
 * 解析进程列表（纯函数，便于单测）。
 * 支持 `ps -eo pid,args` 与 Windows 的 `ConvertTo-Csv` 两种输入。
 * @param {string} text 进程列表原文
 * @param {string} [platform]
 * @param {string} [marker] 只保留命令行里带该标记的进程（默认 watchdog.js；确认 web 子进程时传 web.js）
 * @returns {Array<{pid:number, port:number, command:string}>}
 */
export function parseWatchdogProcesses(text, platform = process.platform, marker = 'watchdog.js') {
  const out = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || !line.includes(marker)) continue
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

/** 列出机器上带 marker 的 node 进程（平台相关，失败返回空数组）。 */
async function listWatchdogProcesses(exec, platform = process.platform, marker = 'watchdog.js') {
  if (platform === 'win32') {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"
    const out = await exec('powershell', ['-NoProfile', '-Command', ps])
    return parseWatchdogProcesses(out, 'win32', marker)
  }
  const out = await exec('ps', ['-eo', 'pid,args'])
  return parseWatchdogProcesses(out, 'linux', marker)
}

/**
 * 默认的进程执行器（spawn + 收 stdout；失败返回空串）。
 *
 * issue #31/#33 第③层实测：受限环境（DSH 沙箱）**不允许打开命名管道**，默认的 `stdio:'pipe'`
 * 会在 `spawn()` 时**同步抛 EPERM** —— 老实现只在 `'error'` 事件里兜底，根本没机会执行，
 * 于是 `dsh-memory watchdog --reap` 直接崩（`Error: spawn EPERM`），而 `listWatchdogProcesses()`
 * 在该环境下永远返回空名单（孤儿回收 / findPortListener / looksLikeOurWeb 全部失去依据）。
 * 两条对策：① `try/catch` 包住 spawn，失败就当「枚举不到」；② **用临时文件接 stdout**，完全不碰管道。
 */
function defaultExec() {
  return async (cmd, args, opts = {}) => {
    const { spawn } = await import('node:child_process')
    let outFile = ''
    let timer = null
    try {
      const os = await import('node:os')
      const path = await import('node:path')
      const fs = await import('node:fs')
      outFile = path.join(os.tmpdir(), 'me-exec-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.out')
      const fd = fs.openSync(outFile, 'w')
      let child
      try {
        child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', fd, 'ignore'] })
      } finally {
        try { fs.closeSync(fd) } catch { /* 子进程已继承则关父进程副本 */ }
      }
      // 超时必须能掐断子进程：issue #30 实测 Windows 上 Get-NetTCPConnection 无条件要 4–7.5 秒
      // （一次 13.6 秒），而调用方（接管清场）的 8000ms 预算根本管不住它 —— 于是决策基于过期数据。
      const tm = Number(opts && opts.timeoutMs) || 0
      if (tm > 0) timer = setTimeout(() => { try { child.kill() } catch { /* 已经在退出 */ } }, tm)
      await new Promise((resolve) => {
        child.on('error', () => resolve(''))
        child.on('close', () => resolve(''))
      })
      try { return fs.readFileSync(outFile, 'utf8') } catch { return '' }
    } catch {
      return ''   // 受限环境：宁可「枚举不到」，也不能把调用方（如 --reap）崩掉
    } finally {
      if (timer) clearTimeout(timer)
      if (outFile) { try { (await import('node:fs')).unlinkSync(outFile) } catch { /* 清理失败无妨 */ } }
    }
  }
}

/**
 * 回收历史遗留的孤儿看门狗（新锁只能防新增，管不了升级前已经在跑的）。
 * 只杀「命令行是 watchdog.js + 端口相同 + pid 不是自己 + 不在锁里存活」的进程。
 * @returns {Promise<{scanned:number, killed:number[], skipped:number[]}>}
 */
export async function reapStaleWatchdogs({ port = 7999, keepPid = process.pid, env = process.env, exec, list, listWebs, kill } = {}) {
  const runExec = exec || defaultExec()
  const procs = list ? await list() : await listWatchdogProcesses(runExec)
  // issue #11 补充实测：**孤儿不只 watchdog，还有 web**。watchdog 先死 + 锁文件丢失时，配置端口上
  // 那个 web 的 PPID=1、锁里没有它 —— stop/restart 读锁槽找不到目标，而 reap 过去只认 watchdog.js，
  // 于是三条收敛入口都够不着它，用户只能手动 kill。这里把自家 web 也纳入回收范围。
  const webs = listWebs ? await listWebs() : await listWatchdogProcesses(runExec, process.platform, 'web.js')
  const lock = readWatchdogLock(env)
  const lockedAlive = new Set(lock.watchdogs.filter((w) => isPidAlive(w.pid)).map((w) => Number(w.pid)))
  // 只保护「托管者还活着」的 web：watchdog 已死（陈旧槽）时它才是孤儿，正是要收的对象
  const lockedAliveWeb = new Set(lock.watchdogs.filter((w) => isPidAlive(w.pid)).map((w) => Number(w.webPid)).filter((n) => n > 0))
  // 绝不能杀自己（也不杀父进程）：直接跑 lib/watchdog.js --reap 时，调用者自己的命令行
  // 就含 watchdog.js + 同端口、且不在锁里 —— 早期实现在这里把自己 SIGTERM 了，
  // 表现为「没有任何输出 + 退出码 1」。并发 reap 的另一个进程同理：命令行带 --reap 就放过。
  const protectedPids = new Set([Number(keepPid), process.pid, process.ppid].filter((n) => n > 0))
  const killFn = kill || ((pid) => { try { process.kill(pid, 'SIGTERM'); return true } catch { return false } })
  const killed = []
  const skipped = []
  for (const p of procs) {
    if (Number(p.port) !== Number(port)) { skipped.push(p.pid); continue }
    if (protectedPids.has(Number(p.pid))) { skipped.push(p.pid); continue }
    if (String(p.command || '').includes('--reap')) { skipped.push(p.pid); continue } // 另一个正在 reap 的进程
    if (lockedAlive.has(Number(p.pid))) { skipped.push(p.pid); continue } // 锁里活着的是当前合法实例
    if (!isPidAlive(p.pid)) { skipped.push(p.pid); continue }
    if (killFn(p.pid)) killed.push(p.pid); else skipped.push(p.pid)
  }
  // 自家 web：同样的保护集合，外加「托管者还活着就不许动」
  const webKilled = []
  for (const w of webs) {
    if (Number(w.port) !== Number(port)) { skipped.push(w.pid); continue }
    if (protectedPids.has(Number(w.pid))) { skipped.push(w.pid); continue }
    if (String(w.command || '').includes('--reap')) { skipped.push(w.pid); continue }
    if (lockedAliveWeb.has(Number(w.pid))) { skipped.push(w.pid); continue }
    if (!looksLikeOurWeb(w.command)) { skipped.push(w.pid); continue }
    if (!isPidAlive(w.pid)) { skipped.push(w.pid); continue }
    if (killFn(w.pid)) webKilled.push(w.pid); else skipped.push(w.pid)
  }
  return { scanned: procs.length + webs.length, scannedWatchdogs: procs.length, scannedWebs: webs.length, killed, webKilled, skipped }
}

/**
 * `--reap` 的输出摘要（纯函数，便于单测）。
 *
 * 为什么单独抽出来：0.10.13 加了 web 回收，但 CLI 文案还在说「扫描到 N 个 watchdog 进程、
 * 清理孤儿 killed.length 个」—— `scanned` 已经含 web、`webKilled` 又完全没打印，
 * 于是**真收了 web 却显示「清理孤儿 0 个」**（实测反馈：alario-tang 在 macOS 上看到
 * 「扫描到 1 个 watchdog 进程，清理孤儿 0 个」而端口事实上已经释放）。计数口径与文案必须一起改。
 *
 * @param {{scanned?:number, scannedWatchdogs?:number, scannedWebs?:number, killed?:number[], webKilled?:number[], skipped?:number[]}} out
 */
export function formatReapSummary(out = {}) {
  const scanned = Number(out.scanned) || 0
  const wd = Number.isFinite(out.scannedWatchdogs) ? Number(out.scannedWatchdogs) : scanned
  const webs = Number.isFinite(out.scannedWebs) ? Number(out.scannedWebs) : 0
  const killed = Array.isArray(out.killed) ? out.killed : []
  const webKilled = Array.isArray(out.webKilled) ? out.webKilled : []
  const skipped = Array.isArray(out.skipped) ? out.skipped : []
  const cleaned = []
  if (killed.length) cleaned.push('watchdog ' + killed.length + ' 个（pid ' + killed.join(', ') + '）')
  if (webKilled.length) cleaned.push('web ' + webKilled.length + ' 个（pid ' + webKilled.join(', ') + '）')
  return '扫描 ' + scanned + ' 个进程（watchdog ' + wd + ' / web ' + webs + '），清理孤儿 '
    + (cleaned.length ? cleaned.join(' / ') : '0 个')
    + '，保留 ' + skipped.length + ' 个（锁中登记的活跃实例 / 其它端口 / 无关进程不会被动）'
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

/**
 * 探测端口上**实际服务**的那个进程加载的包版本（issue #23）。
 *
 * 为什么必须问端口而不是读锁文件：锁里的 pkgVersion 是 watchdog 自己写的，
 * 与端口上真正跑着的代码无关 —— 升级后旧 web 仍占着端口时，status 会骗人地报新版本。
 * /overview 的 version 字段由被探测进程自己（lib/web.js 模块加载时读 package.json）给出。
 *
 * @returns {Promise<string>} 取不到返回空串
 */
export async function probeServedVersion(port, timeoutMs = 1200) {
  // issue #31/#33 第②层：`/overview` 会碰数据库，库只读/损坏时它 500 —— 于是「端口上明明活着、
  // 版本却拿不到」：verify 报「（无响应）」、status 甚至误判成「v0.10.4 之前的旧版」，进而触发
  // 一轮又一轮无效替换。`/version-check` **不碰库**（只读 package.json + 缓存 + 自探），先问它。
  //
  // 再叠一层**重试**（issue #30 第五轮实测）：报告者看到「同一时刻 version-check 200、2 秒后
  // status 说没有服务」—— 单发探测撞上重启窗口/瞬时拒绝就会得出相反结论。这里退避重试 3 次
  // （每次约 150/300ms），让**只调一次**的那些调用方（status / inspectResident / 面板）不再被瞬时抖动骗到。
  const tries = 3
  for (let i = 0; i < tries; i++) {
    try {
      const v = await probeViaVersionCheck(port, timeoutMs)
      if (v) return v
    } catch { /* 回落到 /overview */ }
    try {
      const info = await probe(port, timeoutMs)
      if (info && typeof info.version === 'string' && info.version) return info.version
    } catch { /* 继续重试 */ }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 150 * (i + 1)))
  }
  return ''
}

/** 问 `/version-check` 要「端口上那个进程加载的版本」（不碰数据库；旧版没有该路由时返回空串）。 */
async function probeViaVersionCheck(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: `${API_PREFIX}/version-check`, method: 'GET', timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) return resolve('')
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (data && data.ok === true && typeof data.loaded === 'string' && data.loaded) return resolve(data.loaded)
          resolve('')
        } catch { resolve('') }
      })
      res.on('error', () => resolve(''))
    })
    req.on('error', () => resolve(''))
    req.on('timeout', () => { req.destroy(); resolve('') })
    req.end()
  })
}

/**
 * 轮询等到端口上的服务版本等于期望值（restart 后的自检，issue #23 建议 2）。
 *
 * @returns {Promise<{ok:boolean, version:string, waitedMs:number}>}
 */
export async function waitForServedVersion(port, expect, { timeoutMs = 15000, intervalMs = 500, probeFn } = {}) {
  const probeVersion = probeFn || probeServedVersion
  const start = Date.now()
  let version = ''
  for (;;) {
    version = String((await probeVersion(port)) || '')
    if (version && version === String(expect || '')) return { ok: true, version, waitedMs: Date.now() - start }
    if (Date.now() - start >= Math.max(0, Number(timeoutMs) || 0)) return { ok: false, version, waitedMs: Date.now() - start }
    await new Promise((r) => setTimeout(r, Math.max(50, Number(intervalMs) || 500)))
  }
}

/**
 * 等「**新实例真的接管了**」：端口服着期望版本 **且** 锁里出现一个不在 `beforePids` 里的活看门狗。
 *
 * 为什么不能只看版本（issue #28 的根）：升级前后版本号常常相同、或旧实例本来就是这个版本 ——
 * 那时「端口服着 vX」与「替换还没发生」同时为真，只看版本的自检会立刻通过。实测现场：
 * `restart` 打印「自检通过：端口 7999 正在服务 v0.10.16（等待 0s）」，紧接着 `status` 说
 * 「锁文件里没有登记的看门狗（没有常驻实例）」—— 状态自相矛盾，面板据此给出的结论也会是错的。
 *
 * @returns {Promise<{ok:boolean, version:string, waitedMs:number, tookOver:boolean}>}
 */
export async function waitForTakeover(port, expect, {
  env = process.env, beforePids = new Set(), timeoutMs = 25000, intervalMs = 500,
  probe, sleep, readLock,
} = {}) {
  const p = Number(port) || 0
  const want = String(expect || '')
  const probeVersion = probe || probeServedVersion
  const sleepFn = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const lockOf = readLock || ((e) => readWatchdogLock(e))
  const start = Date.now()
  let version = ''
  for (;;) {
    // 单次给较小的超时：内层 probeServedVersion 自己会退避重试，外层还要轮询多轮（别把窗口吃光）
    try { version = String((await probeVersion(p, 800)) || '') } catch { version = '' }
    let fresh = []
    try {
      fresh = lockOf(env).watchdogs.filter((w) => Number(w.port) === p && isPidAlive(w.pid) && !beforePids.has(Number(w.pid)))
    } catch { fresh = [] }
    if (version && version === want && fresh.length) return { ok: true, version, waitedMs: Date.now() - start, tookOver: true }
    if (Date.now() - start >= Math.max(0, Number(timeoutMs) || 0)) return { ok: false, version, waitedMs: Date.now() - start, tookOver: false }
    await sleepFn(Math.max(50, Number(intervalMs) || 500))
  }
}

// -- 常驻实例的「版本漂移自愈」--------------------------------------------------
//
// 为什么需要它：常驻 web（默认 7999）**比 DSH 宿主活得久**。升级 npm 包只换磁盘上的
// 文件，端口上那个进程仍在跑「启动时加载进内存」的旧代码；而 index.js 的启动策略是
// 「同端口已有活着的 watchdog 就让位（delegated）」，于是重启 DSH 多少次都不会替换它 ——
// 表现就是「启动 dsh 后，运行中依旧是旧版本」（issue #19 / #23）。
//
// 自愈的正确形态是「用新代码重启那个常驻进程」，**不是**热替换内存里的模块：ESM 模块缓存 +
// 闭包状态（settings / vault 路由 / SSE hub / fs.watch / 已监听的端口）没法安全热换，
// 缓存失效重 import 只会得到第二份模块图（双实例、双监听、双写）。
//
// 由此定下接口：
//   inspectResident()       体检：端口上真正服务的版本 / 占用者 / 常驻看门狗
//   decideResidentAction()  纯函数决策：delegate | spawn | restart | warn
//   restartResident()       执行替换：spawn 一个 --replace 助手，再自检新版本
//   clearResidentForTakeover()  --replace 助手的主体：收掉旧实例 → 等端口空出来

/**
 * 常驻实例体检（宿主启动自愈与 /restart-self 共用）。
 *
 * 版本一律**问端口**而不是读锁：锁里的 pkgVersion 是 watchdog 自己写的自述，
 * 与端口上真正跑着的代码无关（issue #23）。
 *
 * @param {{env?:object, port:number, probeVersion?:Function, findListener?:Function}} opts
 * @returns {Promise<{port:number, served:string, occupant:{pid:number,command:string}|null,
 *   occupantIsOurs:boolean, watchdog:object|null, watchdogAlive:boolean, residentStartedAt:number}>}
 */
export async function inspectResident({ env = process.env, port, probeVersion, findListener, retries = 3, retryDelayMs = 500, sleepFn } = {}) {
  const p = Number(port) || 0
  const entry = readWatchdogLock(env).watchdogs.find((w) => Number(w.port) === p && isPidAlive(w.pid)) || null
  let served = ''
  if (p) {
    // issue #29 建议 3：一次探针打空（实例正忙 / GC / 冷启动）**不能**当成「旧版不自报版本」——
    // 那个结论会直接触发漂移替换，于是每次启动都多起一次常驻实例。退避重试后再下结论。
    const wait = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)))
    for (let i = 0; ; i++) {
      try { served = String((await (probeVersion || probeServedVersion)(p)) || '') } catch { served = '' }
      if (served || i >= Math.max(0, Number(retries) || 0)) break
      await wait(Math.max(0, Number(retryDelayMs) || 0))
    }
  }
  let occupant = null
  // 只有「探不到版本」时才需要问端口占用者：能自报版本就已经证明是我们的服务了
  if (p && !served) {
    try { occupant = await (findListener || findPortListener)(p) } catch { occupant = null }
  }
  const occupantIsOurs = Boolean(occupant && occupant.pid && looksLikeOurWeb(occupant.command))
  // issue #44 建议 3：锁里「有活着的 watchdog」不等于端口有人应答 —— 例如 brew 升级 node 后
  // 那个 watchdog 还在、但它 spawn web 每次都 ENOENT（路径已删）。决策前必须单独问一次端口。
  let portServing = null
  if (p) {
    try { portServing = Boolean(served) || Boolean(await probeTcp(p)) } catch { portServing = served ? true : null }
  }
  return {
    port: p,
    served,
    portServing,
    occupant,
    occupantIsOurs,
    watchdog: entry,
    watchdogAlive: Boolean(entry),
    residentStartedAt: entry ? (Date.parse(String(entry.startedAt || '')) || 0) : 0,
  }
}

/**
 * 「端口上的常驻实例该拿它怎么办」的纯决策（便于单测，不含任何 IO）。
 *
 * @param {object} o
 * @param {string} [o.served]         端口上**真正服务**的版本（取不到 = 空串）
 * @param {string} [o.expect]         本机磁盘上的包版本
 * @param {boolean} [o.watchdogAlive] 同端口是否有活着的常驻 watchdog
 * @param {boolean} [o.occupantIsOurs] 占用端口的进程是不是本插件的 web
 * @param {boolean} [o.autoRestart]   autoRestartOnDrift 开关
 * @param {number} [o.residentStartedAt] 现有 watchdog 的启动时间（做防抖）
 * @param {number} [o.now]
 * @param {number} [o.debounceMs]
 * @returns {{action:'delegate'|'spawn'|'restart'|'warn', stale:boolean, reason:string}}
 */
export function decideResidentAction({
  served = '', expect = '', watchdogAlive = false, occupantIsOurs = false, portServing = null,
  autoRestart = true, residentStartedAt = 0, now = Date.now(), debounceMs = 60000,
} = {}) {
  const s = String(served || '')
  const e = String(expect || '')
  // ① 版本一致：端口上跑的就是本机这份代码
  if (s && e && s === e) return { action: 'delegate', stale: false, reason: 'up-to-date' }
  // ①b 「登记说活着、端口却没人应答」(#44)：这是**僵尸看门狗**（典型原因：brew 升级 node 后
  // 它 spawn web 每次都 ENOENT，而调用方静默吞错）。绝不能 delegate —— 那正是「记忆自动沉淀
  // 静默停摆、日志里只写 delegated」的现场。交给重启流程，由助手用当前 node 重新拉起。
  if (!s && watchdogAlive && portServing === false) {
    if (!autoRestart) return { action: 'warn', stale: true, reason: 'watchdog-port-dead' }
    return { action: 'restart', stale: true, reason: 'watchdog-port-dead' }
  }
  // ② 读不到本机版本 → 没有判据，绝不乱动常驻实例（宁可不换，也不误杀）
  if (!e) {
    if (s) return { action: 'delegate', stale: false, reason: 'expect-unknown' }
    return { action: watchdogAlive ? 'delegate' : 'spawn', stale: false, reason: 'expect-unknown' }
  }
  // ③ 漂移：自报版本不同，或干脆不自报版本（< v0.10.4 的旧 web）却占着端口
  const drift = s ? s !== e : Boolean(occupantIsOurs)
  if (!drift) {
    if (s) return { action: 'delegate', stale: false, reason: 'up-to-date' }
    return { action: watchdogAlive ? 'delegate' : 'spawn', stale: false, reason: 'port-idle' }
  }
  if (!autoRestart) return { action: 'warn', stale: true, reason: 'auto-restart-off' }
  // ④ 防抖：刚替换过（新 watchdog 才起来）就别在效果重跑时反复重启
  if (residentStartedAt && now - residentStartedAt < Math.max(0, Number(debounceMs) || 0)) {
    return { action: 'delegate', stale: true, reason: 'debounced' }
  }
  return { action: 'restart', stale: true, reason: s ? 'version-drift' : 'resident-silent-version' }
}

/**
 * spawn 一个 detached 的 `watchdog.js --replace` 助手。
 *
 * 为什么替换要交给子进程：调用方很可能**就是**端口上那个旧 web（/restart-self 由独立页发出），
 * 就地收掉自己会让后面的「抢锁 + 拉起新 web」永远执行不到。助手不在锁里、也不占端口，
 * 因此不会被自己收掉。失败不抛：调用方的版本自检会把「没换成功」如实报出来。
 */
export function spawnReplaceHelper({ port = 7999, vaultRoot, interval = 5000, maxRestart = 10, spawnFn, bin } = {}) {
  const script = path.join(__dirname, 'watchdog.js')
  const args = [script, '--replace', '--port', String(port), '--interval', String(interval), '--max-restart', String(maxRestart)]
  if (vaultRoot) args.push('--vault', vaultRoot)
  const child = (spawnFn || spawn)(bin || nodeBinary(), args, {
    detached: true,
    stdio: 'ignore',
    env: childEnv({ MEMORY_VAULT_DIR: vaultRoot || process.env.MEMORY_VAULT_DIR || '' }),
    windowsHide: true,
  })
  if (child && typeof child.on === 'function') child.on('error', () => { /* 由调用方的自检暴露 */ })
  if (child && typeof child.unref === 'function') child.unref()
  return child
}

/**
 * 用新代码重启常驻实例（= 「更新运行中的程序」唯一安全形态）。
 *
 * 步骤：spawn `--replace` 助手 → 助手收掉旧 watchdog / 旧 web、等端口空出来、抢锁、拉起新 web
 * → 本进程轮询自检「端口上真正服务的版本 == 本机版本」（issue #23 建议 2）。
 * 调用方若正是被替换的那个进程，会先被助手收掉（响应已发出），自检结论由新实例给出。
 *
 * @returns {Promise<{ok:boolean, stage:string, expect:string, served:string, waitedMs:number,
 *   helperPid:number, before:Array<object>, error?:string}>}
 */
export async function restartResident({
  port = 7999, vaultRoot, interval = 5000, maxRestart = 10, env = process.env,
  expectVersion, timeoutMs = 25000, deps = {},
} = {}) {
  const p = Number(port) || 7999
  const expect = String(expectVersion !== undefined ? expectVersion : currentPkgVersion())
  const before = readWatchdogLock(env).watchdogs.filter((w) => Number(w.port) === p)
  // 替换**前**就存在的 pid（看门狗 + 它拉起的 web）：自检时用来区分「还是那个旧实例」与「新实例接管了」
  const beforePids = new Set(before.flatMap((w) => [Number(w.pid), Number(w.webPid) || 0]).filter((n) => n > 0))
  // 替换前的登记快照：失败时写回去（issue #30 实测：失败的 restart 会把锁文件删掉，
  // 现场从此看起来像「从来没有过常驻实例」，而端口上那个 web 还在跑）。
  const lockSnapshot = before.slice()
  // issue #30（受限环境现场）：锁文件写不进去时，接管**无法登记**新实例 —— 继续做只会留下
  // 「有 web 在跑、却没有任何登记」的孤儿（机器上实测：锁目录 EPERM，重启后现场什么都没变、
  // 用户却以为已经替换过）。这里前置拒绝，并说清两种出路。
  if (!deps.skipLockPreflight) {
    const probeLock = deps.probeLockWritable || probeLockWritable
    let lockOk = true
    try { lockOk = Boolean(probeLock(env).writable) } catch { lockOk = true }
    if (!lockOk) {
      return {
        ok: false, stage: 'lock-unwritable', expect, served: '', waitedMs: 0, helperPid: 0, before, lockRestored: false, occupant: null,
        error: '看门狗锁文件写不进去（' + (() => { try { return probeLock(env).path || '' } catch { return '' } })() + '）→ 接管无法登记，已拒绝执行（避免留下"有 web 在跑、却没登记"的孤儿）。请先修复该目录权限，或前台观察：dsh-memory watchdog --port ' + p,
      }
    }
  }
  // 单飞互斥（issue #30 第六轮实测）：接管还在进行中时**不要再拉第二个助手** ——
  // 宿主 tick 与 CLI 同时来的时候，两个助手会互相收对方的 web，现场反而更难复盘。
  if (!deps.ignoreClaim) {
    try {
      const inflight = readReplaceClaim(env)
      if (inflight && Number(inflight.pid) !== process.pid && isPidAlive(inflight.pid) && Date.now() - Number(inflight.at || 0) < 60000) {
        return {
          ok: false, stage: 'in-flight', expect, served: '', waitedMs: 0, helperPid: 0, before, lockRestored: false, occupant: null,
          error: '已有接管正在进行中（pid ' + inflight.pid + '，' + Math.round((Date.now() - Number(inflight.at || Date.now())) / 1000) + 's 前启动）→ 本次不再重复拉起助手；稍后可再试 dsh-memory restart --port ' + p,
        }
      }
    } catch { /* 读不到 claim 就当没有 */ }
  }
  let helperPid = 0
  try {
    const child = (deps.spawnHelper || spawnReplaceHelper)({ port: p, vaultRoot, interval, maxRestart })
    helperPid = Number(child && child.pid) || 0
  } catch (error) {
    return { ok: false, stage: 'spawn-helper', expect, served: '', waitedMs: 0, helperPid: 0, before, error: String(error?.message || error) }
  }
  let check = { ok: false, version: '', waitedMs: 0 }
  try {
    // 只看版本会被**旧实例**骗过（版本号常常没变）→ 自检必须等到「新看门狗接管」才认成功（#28）
    check = await (deps.waitForTakeover || waitForTakeover)(p, expect, {
      env, beforePids, timeoutMs,
      probe: deps.probeServedVersion,
      sleep: deps.sleep,
      readLock: deps.readLock,
    })
  } catch { check = { ok: false, version: '', waitedMs: 0 } }
  // 失败善后：把替换前的登记写回去 + 报告端口上现在是谁（免得用户面对「锁没了、web 还在」的孤儿现场）
  let lockRestored = false
  let occupant = null
  if (!check.ok) {
    try { lockRestored = restoreWatchdogLock({ env, port: p, watchdogs: lockSnapshot }) } catch { lockRestored = false }
    try { occupant = await (deps.findListener || findPortListener)(p) } catch { occupant = null }
  }
  const who = occupant && occupant.pid ? occupant.pid + '（' + (occupant.command || '命令行未知') + '）' : ''
  const occupantText = who ? '；端口上现在是 pid ' + who : ''
  const lockText = (!check.ok && lockSnapshot.length)
    ? (lockRestored ? '；已把替换前的锁登记写回（不再出现「锁没了、web 还在」）' : '；锁登记未能写回（受限环境禁止写锁文件）')
    : ''
  const failMsg = (check.version === expect && !check.tookOver)
    ? '端口 ' + p + ' 服务着 v' + check.version + '，但没有新看门狗接管它（端口上可能仍是替换前的旧实例或孤儿）'
    : '端口 ' + p + ' 上服务的版本是 ' + (check.version || '（无响应）') + '，本机是 ' + (expect || '?')
  return {
    ok: Boolean(check.ok),
    stage: check.ok ? 'done' : 'verify',
    expect,
    served: String(check.version || ''),
    waitedMs: Number(check.waitedMs) || 0,
    helperPid,
    before,
    lockRestored,
    occupant,
    // 失败原因：版本不对（旧实例还在服务）vs 没人接管（端口服务着期望版本却没有新看门狗）；
    // 并补上「端口上现在是谁」与「锁有没有写回」—— #30 现场最缺的就是这两句。
    error: check.ok ? undefined : (failMsg + occupantText + lockText),
    tookOver: Boolean(check.tookOver),
  }
}

/**
 * `--replace` 助手的主体：收掉同端口的旧常驻实例 → 等端口真的空出来。
 *
 * 本进程既不在锁里、也不占端口，所以不会被自己收掉。
 * portFree=false 时调用方必须**中止接管**：端口没空出来，新 web 只能退让到 port+1，
 * 旧代码继续在目标端口上服务 —— 那正是「升级静默不生效」和「孤儿 web」的同一处病根。
 */
export async function clearResidentForTakeover({ port = 7999, env = process.env, timeoutMs = 8000, deps = {} } = {}) {
  const p = Number(port) || 7999
  const findListener = deps.findListener || findPortListener
  // 枚举本身要能被时间预算约束（否则 8s 预算被一次 13.6s 的 PowerShell 查询吃光，决策基于过期数据）
  const listenerOpts = { timeoutMs: Math.max(500, Math.min(2500, Number(timeoutMs) || 8000)) }
  const out = { stopped: [], webStopped: [], portStopped: [], warnings: [], failed: [], portFree: false }
  const rawKill = deps.kill || ((pid) => { try { process.kill(pid, 'SIGTERM'); return true } catch { return false } })
  // 记下「已经判定收不掉」的 pid：立刻再来一次只会同样失败，白折腾还可能误导用户以为是权限抖动
  const failedKills = new Set()
  const killFn = (pid) => { const ok = rawKill(pid); if (!ok) failedKills.add(Number(pid)); return ok }
  try {
    const r = await (deps.stop || stopWatchdogs)({
      env, port: p, checkPort: true, forcePortOccupant: true,
      // 探测与杀戮都走同一个注入口：单测里既不能真去问生产端口，更不能真杀生产进程
      kill: killFn, isAlive: deps.isAlive, sleep: deps.sleep, listProcesses: deps.listProcesses, findListener,
    })
    out.stopped = r.stopped || []
    out.webStopped = r.webStopped || []
    out.portStopped = r.portStopped || []
    out.warnings = (r.warnings || []).slice()
    out.failed = r.failed || []
  } catch (error) {
    out.warnings.push('停止旧实例失败：' + String(error?.message || error))
  }
  const wait = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  let left = null
  try { left = await findListener(p, listenerOpts) } catch { left = null }
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  // 只对「确认是本插件的 web」下手：别人的进程占着端口时只如实报告，不误杀（同 issue #23 的口径）。
  // 已经判定收不掉的 pid 不再重试 —— 立刻再来一次只会同样失败。
  while (left && left.pid && looksLikeOurWeb(left.command) && !failedKills.has(Number(left.pid)) && Date.now() < deadline) {
    if (!killFn(left.pid)) break
    await wait(200)
    try { left = await findListener(p, listenerOpts) } catch { left = null }
  }
  if (left && left.pid) {
    out.portFree = false
    out.warnings.push(`端口 ${p} 仍被 pid ${left.pid} 占用（${left.command || '命令行未知'}）`)
  } else {
    // 枚举不到 ≠ 端口是空的（issue #30 现场）：受限环境/被拒的进程查询会让 findListener 返回 null，
    // 旧实现据此认为"端口已空出" → 新 web 绑不上 7999 → 退让或失败 → 自检「（无响应）」+ 锁被清空。
    // 这里用**不依赖枚举**的 TCP 探测复核：还在监听就坚决不算空。
    const probe = deps.probeTcp || probeTcp
    let listening = false
    try { listening = Boolean(await probe(p)) } catch { listening = false }
    if (listening) {
      out.portFree = false
      out.warnings.push(`端口 ${p} 仍在监听，但占用者无法识别（进程枚举被拒/不可用）—— 已中止接管，且未改动任何锁登记`)
    } else {
      out.portFree = true
    }
  }
  return out
}

/**
 * 解析 `lsof -Fpcn` 的输出（每个进程一段：p<pid> / c<command> / n<name>）。
 * 纯函数，便于单测（POSIX 侧探测端口占用者用它）。
 */
export function parseLsofFields(text) {
  const out = []
  let cur = null
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const tag = line[0]
    const val = line.slice(1)
    if (tag === 'p') {
      if (cur) out.push(cur)
      cur = { pid: Number(val) || 0, command: '', name: '' }
    } else if (!cur) {
      continue
    } else if (tag === 'c') cur.command = val
    else if (tag === 'n') cur.name = val
  }
  if (cur) out.push(cur)
  return out.filter((p) => p.pid > 0)
}

/**
 * 查「谁正占着这个端口」（不依赖锁文件，issue #23 建议 3）。
 *
 * 锁里没登记 webPid 的旧实例、或 pid 复用导致的登记失效，只有直接问操作系统
 * 才能发现 —— 这正是「restart 打印成功、端口上还是旧代码」的漏网处。
 *
 * @param {number} port
 * @param {{exec?: (cmd:string,args:string[])=>Promise<string>}} [opts]
 * @returns {Promise<{pid:number, command:string}|null>}
 */
export async function findPortListener(port, { exec, platform = process.platform, timeoutMs = 4000 } = {}) {
  const p = Number(port)
  if (!Number.isFinite(p) || p <= 0) return null
  const runExec = exec || defaultExec()
  const execOpts = { timeoutMs: Math.max(200, Number(timeoutMs) || 4000) }
  try {
    if (platform === 'win32') {
      const out = await runExec('powershell', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`], execOpts)
      const pid = Number(String(out || '').split(/\r?\n/).map((s) => s.trim()).find((s) => /^\d+$/.test(s))) || 0
      if (!pid) return null
      const cmd = await runExec('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine)`], execOpts)
      return { pid, command: String(cmd || '').trim() }
    }
    const fields = await runExec('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-Fpcn'], execOpts)
    const list = parseLsofFields(fields)
    if (!list.length) return null
    const pid = list[0].pid
    // lsof 的 `c` 字段是**进程名**（node），不是命令行 —— 而「要不要收掉它」的判据（looksLikeOurWeb）
    // 要求命令行里含 memory-eternal 或本机 web.js 的绝对路径。只拿进程名 → 判据恒假 →
    //「端口被自家孤儿 web 占着」在 macOS/Linux 上永远收不掉（issue #11 补充实测：
    //  stop/restart/reap 三条入口都够不着，用户只能手动 kill）。这里补一次 ps 取完整命令行；
    // ps 拿不到时才退回旧行为（name + 监听地址），宁可不杀也不误杀。
    let full = ''
    try { full = String((await runExec('ps', ['-p', String(pid), '-o', 'args='])) || '').trim().split(/\r?\n/)[0] || '' } catch { full = '' }
    return { pid, command: full || (list[0].command + (list[0].name ? ' ' + list[0].name : '')).trim() }
  } catch { return null }
}

/**
 * 这个占用者看起来是不是本插件拉起的 web（只按命令行判定，用于「收不收」的门禁）。
 *
 * 判据必须收紧到「本插件自己的 web.js」：早先只要命令行里出现 `web.js` 就算命中，
 * 而 `node web.js` 是别的项目里极常见的写法 —— `dsh-memory restart --port N` 时，
 * 恰好占着 N 端口的外来进程会被**误杀**（issue #23 的修复不能引入新的误杀）。
 * 现在只在两种情况下放行：
 *   ① 命令行里带 `memory-eternal`（包名 / 安装路径 / pnpm store 路径）；
 *   ② 命令行里出现**本进程加载的** lib/web.js 绝对路径 —— 同一次安装拉起的 web 必然命中
 *      （watchdog spawn 用的就是同一个 WEB_JS，见 spawnWeb）。
 * 认不出来的一律只告警、不动手：宁可不杀，也不误杀。
 *
 * @param {string} command 占用者的命令行
 * @param {{webJs?: string}} [opts] webJs 默认本文件同级的 web.js（单测注入用）
 */
export function looksLikeOurWeb(command, { webJs = WEB_JS } = {}) {
  const s = String(command || '')
  if (!s) return false
  if (/memory-eternal/i.test(s)) return true
  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase()
  const target = norm(webJs)
  return Boolean(target) && norm(s).includes(target)
}

/**
 * 退让端口窗口：配置端口 + 紧随其后的若干个。
 *
 * web 在目标端口被占时会退到 port+1…（见 startWatchdog 的 findFreePort），这些落点正是
 * 「孤儿 web」的诞生地：退让出来的那个 web 一旦失去托管它的 watchdog，就再没人来认领它。
 */
export function fallbackPortWindow(port, span = 9) {
  const base = Number(port) || 0
  const n = Math.max(0, Number(span) || 0)
  const out = []
  for (let i = 1; i <= n; i++) out.push(base + i)
  return out
}

/**
 * 收掉「本插件拉起、但没有任何托管者认领」的孤儿 web。
 *
 * 为什么必须单独做这件事：web 子进程是 detached 启动的（stdio ignore + unref），watchdog 被
 * 硬终止时（Windows 上 process.kill(pid,'SIGTERM') 就是无条件终止）它的退出处理器不会执行；
 * 若该 web 当初退让到了 port+1，登记它的锁条目也随 watchdog 一起消失 —— 于是它会一直占着
 * 8001/8002 之类的端口，`status` 只探配置端口，永远发现不了它。0.10.4 起 stop/restart 会按
 * 「端口占用者」兜底，但那只覆盖配置端口本身。
 *
 * 三道门缺一不可（宁可漏收，绝不误杀）：
 *   ① 端口落在 [port+1, port+span] 窗口内 —— 配置端口上的服务不归它管；
 *   ② 命令行确实是本插件的 web（复用收紧过的 looksLikeOurWeb，别人的 node web.js 不动）；
 *   ③ 该 pid 不在锁文件里任何 watchdog 的 pid / webPid 上 —— 登记在案的一律不动。
 *
 * @param {{env?:object, port:number, span?:number, kill?:Function, isAlive?:Function, findListener?:Function, lock?:object}} opts
 * @returns {Promise<{killed:number[], kept:Array<{pid:number,port:number,reason:string}>, warnings:string[]}>}
 */
export async function sweepOrphanWebs({ env = process.env, port, span = 9, kill, isAlive, findListener, lock } = {}) {
  const alive = isAlive || isPidAlive
  const killFn = kill || ((pid) => { try { process.kill(pid, 'SIGTERM'); return true } catch { return false } })
  const probeListener = async (p) => {
    try { return findListener ? await findListener(p) : await findPortListener(p) } catch { return null }
  }
  const entries = lock && Array.isArray(lock.watchdogs) ? lock.watchdogs : readWatchdogLock(env).watchdogs
  const registered = new Set()
  for (const w of entries) {
    if (Number(w.pid) > 0) registered.add(Number(w.pid))
    if (Number(w.webPid) > 0) registered.add(Number(w.webPid))
  }
  const killed = []
  const kept = []
  const warnings = []
  for (const p of fallbackPortWindow(port, span)) {
    const found = await probeListener(p)
    if (!found || !found.pid) continue
    const pid = Number(found.pid)
    const command = String(found.command || '')
    if (!looksLikeOurWeb(command)) { kept.push({ pid, port: p, reason: 'not-ours' }); continue }
    if (registered.has(pid)) { kept.push({ pid, port: p, reason: 'registered' }); continue }
    if (!alive(pid)) { kept.push({ pid, port: p, reason: 'already-exited' }); continue }
    if (!killFn(pid)) { warnings.push(`端口 ${p} 上的孤儿 web（pid ${pid}）未能终止，请手工处理`); continue }
    killed.push(pid)
  }
  return { killed, kept, warnings }
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
 * 「这一 tick 该拿端口怎么办」的纯决策（便于单测）。
 *
 * 关键：**`/overview` 非 200 ≠ 端口死了**。`/overview` 会碰数据库，库只读/损坏（issue #31/#33）
 * 时它返回 500，而老实现据此判「离线」→ 调 spawnWeb()（开头先 SIGTERM 掉自己的上一个 child）→
 * 自杀自拉、端口从 7999 漂到 8006。所以只要 **TCP 还能连**，就视为存活（API 降级而已）。
 *
 * @returns {{action:'keep'|'respawn'|'stop'|'skip', reason:string}}
 */
export function decideTickAction({ overviewOk = false, tcpAlive = false, restartCount = 0, maxRestart = 10, autoStart = true } = {}) {
  if (overviewOk) return { action: 'keep', reason: 'healthy' }
  if (tcpAlive) return { action: 'keep', reason: 'api-degraded-but-listening' }
  if (Number(restartCount) >= Number(maxRestart)) return { action: 'stop', reason: 'max-restart' }
  if (!autoStart) return { action: 'skip', reason: 'no-restart' }
  return { action: 'respawn', reason: 'dead' }
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
    // 目标端口上已经有**本插件自己的** web（上一代 watchdog 留下的、或正在启动还没来得及回
    // /overview 的那个）→ 本轮不重复拉起，更不退让到 port+1：退让出来的那个一旦失去托管者
    // 就是孤儿（8001/8002 的来历）。保活交给 tick 的探活，等它真的死了再起。
    try {
      const found = await findPortListener(port)
      if (found && found.pid && looksLikeOurWeb(found.command)) {
        log(`端口 ${port} 上已有本插件的 web（pid ${found.pid}）→ 本轮不重复拉起（不制造退让实例）`)
        return port
      }
    } catch { /* 探测失败按原逻辑继续 */ }
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
      if (child === c) child = null
      if (child === null) updateWatchdogSlot({ patch: { webPid: 0, webPort: 0 } })
      if (!stopped && code !== 0) log(`web exited code=${code} sig=${sig}`)
    })
    c.unref()
    spawned.set(c, targetPort)
    child = c
    ownedByUs = true
    // 记进锁：stop 时即便 watchdog 被硬终止（Windows 无真信号），也能找到并收掉这个 web
    updateWatchdogSlot({ patch: { webPid: c.pid, webPort: targetPort } })
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
    // issue #31/#33 第①层：`/overview` 非 200 **不等于**端口死了。库只读/损坏时它返回 500，
    // 而老实现据此判定「离线」→ 走 spawnWeb()（开头先 SIGTERM 掉自己的上一个 child）→
    // **自杀自拉**、端口一路从 7999 漂到 8006（实测 6 个实例）。所以先补一次不碰库的 TCP 探测。
    const tcpAlive = alive ? false : await probeTcp(port)
    const decision = decideTickAction({ overviewOk: Boolean(alive), tcpAlive, restartCount, maxRestart, autoStart })
    if (decision.action === 'keep') {
      if (!ownedByUs) {
        log(`port ${port} 已存活（外部实例）→ 切换为保活模式（不接管）`)
        ownedByUs = true // 至少逻辑上"知道"它活了
      }
      if (decision.reason === 'api-degraded-but-listening') {
        log(`port ${port} 的 /overview 非 200（多为库不可用），但 TCP 可连 → 视为存活，不重拉`)
        restartCount = 0
      }
      reapExtraChildren()
      return
    }
    if (decision.action === 'stop') {
      log(`restart 次数达上限 ${maxRestart} → 退出看门狗（请人工排查）`)
      stop()
      return
    }
    if (decision.action === 'skip') {
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
        // 库不可用时新实例同样吐 500 —— 只要端口在监听就算起来了（否则下一个 tick 又会把它杀掉，成死循环）
        if (await probeTcp(newPort)) {
          log(`web 在 ${newPort} 已监听（/overview 非 200：多为库不可用）→ 视为就绪`)
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

  // 启动时顺手回收「上一代退让到 port+1… 的孤儿 web」——不这么做的话，那些 web 会一直占着
  // 8001/8002 之类的端口，而 tick 只探配置端口，永远发现不了它们（它们当初的托管者已退出）。
  ;(async () => {
    try {
      const sweep = await sweepOrphanWebs({ port })
      if (sweep.killed.length) log(`已回收上一代的孤儿 web：pid ${sweep.killed.join(', ')}（端口 ${fallbackPortWindow(port).join('/')} 窗口）`)
      for (const w of sweep.warnings) log(`⚠ ${w}`)
    } catch { /* 回收失败不影响保活主流程 */ }
  })()

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

/**
 * 助手是被 detached + stdio ignore 拉起的，stderr 没人看 —— 关键结论必须落进 capture 日志，
 * 否则「重启了却没生效」又会变成一条无迹可查的静默失败。
 */
async function noteReplace(action, reason, env = process.env) {
  try {
    const { appendCaptureLog } = await import('./capture-log.js')
    await appendCaptureLog({ time: Date.now(), sessionId: 'system', action, reason }, env)
  } catch { /* 日志失败不影响接管 */ }
}

// 脚本入口：node lib/watchdog.js [--port N] [--interval MS] [--max-restart N] [--vault DIR] [--replace]
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

  /** 正常启动路径：抢锁 → 成为看门狗（--replace 接管成功后也走这里）。 */
  const bootWatchdog = () => {
    const lock = acquireWatchdogLock({ port, vault: vaultRoot || '', pkgVersion: currentPkgVersion() })
    if (!lock.acquired) {
      log('同端口已有看门狗在跑（pid ' + (lock.previous && lock.previous.pid) + '，启动于 ' + (lock.previous && lock.previous.startedAt) + '）→ 本次启动退出，避免进程堆积')
      process.exitCode = 0
      return
    }
    if (lock.previous) log('清理陈旧看门狗记录（pid ' + lock.previous.pid + ' 已不存在）')
    process.on('exit', () => releaseWatchdogLock())
    startWatchdog({ port, interval, maxRestart, vaultRoot, autoStart })
    log('看门狗已启动（pid ' + process.pid + '，端口 ' + port + '）')
  }

  if (argv.includes('--reap')) {
    const out = await reapStaleWatchdogs({ port, keepPid: 0 })
    const msg = `回收孤儿看门狗：扫描 ${out.scanned} 个，清理 ${out.killed.length} 个${out.killed.length ? '（pid ' + out.killed.join(', ') + '）' : ''}，保留 ${out.skipped.length} 个`
    // 必须同步写：process.exit() 会截断 stderr 的异步写入（重定向/管道时表现为「完全没有输出」）
    try { fs.writeSync(2, `[watchdog] ${msg}\n`) } catch { log(msg) }
    process.exitCode = 0
  } else if (argv.includes('--replace')) {
    // 单飞互斥（issue #30 第六轮实测：宿主 tick 与 CLI 各拉一个助手互相踩）：
    // 抢不到 claim 就**直接退出**，把接管让给已经在跑的那个；抢到就在退出时释放。
    const slotClaim = claimReplaceSlot({ port })
    if (!slotClaim.claimed) {
      log('跳过本次接管：' + slotClaim.reason + '（避免两个助手互相收对方的 web）')
      process.exitCode = 0
    } else {
    if (slotClaim.holder) log(slotClaim.reason)
    process.on('exit', () => { try { releaseReplaceClaim() } catch { /* 无妨 */ } })
    // 版本漂移自愈：先收掉旧常驻实例，再作为新一代看门狗接管（见 clearResidentForTakeover 的说明）。
    const cleared = await clearResidentForTakeover({ port })
    for (const w of cleared.warnings) log('⚠ ' + w)
    const summary = `替换常驻实例：停止旧看门狗 ${cleared.stopped.length} 个`
      + `、旧 web ${cleared.webStopped.length + cleared.portStopped.length} 个`
      + `（端口 ${port}${cleared.portFree ? ' 已空出' : ' 仍被占用'}）`
    log(summary)
    if (cleared.failed.length) log('⚠ 未能停止：pid ' + cleared.failed.join(', '))
    if (!cleared.portFree) {
      // issue #30：**清场失败也必须留下登记**。老实现直接 exit(1)，于是锁里什么都没有 ——
      // 而 restartResident 的自检要求「锁里出现新看门狗」，必然超时，用户看到的永远是「（无响应）」。
      // 登记一条（pid 已退出时会自动落成 endedAt 记录，不挡后续），现场从此可复盘。
      const claim = acquireWatchdogLock({ port, vault: vaultRoot || '', pkgVersion: currentPkgVersion(), force: true })
      if (claim.acquired) log('已登记本次替换尝试（端口仍被占用，看门狗未启动）：pid ' + process.pid)
      else log('⚠ 未能登记本次替换（锁不可写？）：' + (claim.file || ''))
      const why = `${summary} —— 端口没空出来，已中止接管（不退让到 port+1，避免又留一个孤儿 web）`
      await noteReplace('fail', why)
      process.exit(1)
    }
    await noteReplace('boot', summary)
    bootWatchdog()
    // 接管**已完成**（助手从此就是常驻看门狗，不退出）→ 立刻释放 claim。
    // 否则 claim 会一直留到「60s 过期」：下次 restart 在窗口内会被自己挡住，报 in-flight（实测踩到）。
    releaseReplaceClaim()
    }
  } else {
    bootWatchdog()
  }
}