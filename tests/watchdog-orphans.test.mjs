// 孤儿 web（退让到 port+1… 后失去托管者的 web）的回收：
//   · fallbackPortWindow：退让窗口
//   · sweepOrphanWebs：三道门（窗口内 / 确实是我们家的 web / 不在锁里）
//   · stopWatchdogs(checkPort) 会顺带扫窗口
// 背景：web 子进程 detached 启动，watchdog 被硬终止时无人回收它；若它当初退让到了 8001/8002，
// 登记它的锁条目也随 watchdog 消失 —— 于是那两个端口上会常驻没人认领的 web。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  fallbackPortWindow, sweepOrphanWebs, stopWatchdogs, looksLikeOurWeb,
  acquireWatchdogLock, updateWatchdogSlot, readWatchdogLock,
} from '../lib/watchdog.js'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'me-orphan-'))
after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }) })

let seq = 0
const newEnv = async () => {
  const home = path.join(tmpRoot, 'home-' + (++seq))
  await fs.mkdir(home, { recursive: true })
  return { DSH_HOME: home }
}

const OUR_WEB = (port) => `node C:\\Users\\me\\.dsh\\profiles\\desktop\\node_modules\\memory-eternal\\lib\\web.js --port ${port}`
const FOREIGN = 'node C:\\other\\project\\web.js'

// ============================ 窗口 ============================
test('退让窗口 = 配置端口之后的 span 个端口（含边界）', () => {
  assert.deepEqual(fallbackPortWindow(7999, 2), [8000, 8001])
  assert.deepEqual(fallbackPortWindow(7999, 0), [])
  assert.equal(fallbackPortWindow(7999).length, 9)
  assert.equal(fallbackPortWindow(7999).includes(7999), false, '配置端口本身不在窗口内')
})

// ============================ sweepOrphanWebs ============================
test('孤儿 web：窗口内、是我们家的、且不在锁里 → 收掉', async () => {
  const killed = []
  const listeners = { 8001: { pid: 33333, command: OUR_WEB(8001) } }
  const out = await sweepOrphanWebs({
    env: await newEnv(),
    port: 7999,
    span: 3,
    lock: { watchdogs: [] },
    findListener: async (p) => listeners[p] || null,
    isAlive: () => true,
    kill: (pid) => { killed.push(pid); return true },
  })
  assert.deepEqual(out.killed, [33333])
  assert.deepEqual(killed, [33333])
  assert.deepEqual(out.kept, [])
})

test('孤儿 web：登记在锁里的一律不动（pad/浏览器都可能复用 pid）', async () => {
  const killed = []
  const out = await sweepOrphanWebs({
    env: await newEnv(),
    port: 7999,
    span: 3,
    lock: { watchdogs: [{ pid: 11111, port: 7999, webPid: 33333 }] },
    findListener: async (p) => (p === 8001 ? { pid: 33333, command: OUR_WEB(8001) } : null),
    isAlive: () => true,
    kill: (pid) => { killed.push(pid); return true },
  })
  assert.deepEqual(out.killed, [])
  assert.deepEqual(killed, [])
  assert.deepEqual(out.kept, [{ pid: 33333, port: 8001, reason: 'registered' }])
})

test('孤儿 web：别人的 web.js 绝不误杀（只留 not-ours）', async () => {
  assert.equal(looksLikeOurWeb(FOREIGN), false, '先确认判据本身拦得住')
  const killed = []
  const out = await sweepOrphanWebs({
    env: await newEnv(),
    port: 7999,
    span: 3,
    lock: { watchdogs: [] },
    findListener: async (p) => (p === 8001 ? { pid: 44444, command: FOREIGN } : null),
    isAlive: () => true,
    kill: (pid) => { killed.push(pid); return true },
  })
  assert.deepEqual(out.killed, [])
  assert.deepEqual(killed, [], '外来进程一个都不许杀')
  assert.deepEqual(out.kept, [{ pid: 44444, port: 8001, reason: 'not-ours' }])
})

test('孤儿 web：窗口外的端口根本不探（配置端口上的服务不归它管）', async () => {
  const probed = []
  await sweepOrphanWebs({
    env: await newEnv(),
    port: 7999,
    span: 2,
    lock: { watchdogs: [] },
    findListener: async (p) => { probed.push(p); return null },
    isAlive: () => true,
    kill: () => true,
  })
  assert.deepEqual(probed, [8000, 8001], '只探 7999 之后的窗口，不碰 7999 本身')
})

test('孤儿 web：已经退出 / 杀不掉 各有说法（不静默）', async () => {
  const gone = await sweepOrphanWebs({
    env: await newEnv(), port: 7999, span: 1, lock: { watchdogs: [] },
    findListener: async () => ({ pid: 55555, command: OUR_WEB(8000) }),
    isAlive: () => false,
    kill: () => true,
  })
  assert.deepEqual(gone.killed, [])
  assert.equal(gone.kept[0].reason, 'already-exited')

  const failed = await sweepOrphanWebs({
    env: await newEnv(), port: 7999, span: 1, lock: { watchdogs: [] },
    findListener: async () => ({ pid: 66666, command: OUR_WEB(8000) }),
    isAlive: () => true,
    kill: () => false,
  })
  assert.deepEqual(failed.killed, [])
  assert.equal(failed.warnings.length, 1)
  assert.match(failed.warnings[0], /66666/)
})

// ============================ 与 stopWatchdogs 的联动 ============================
test('stop --port 7999 会顺带收掉 8001 上的孤儿 web（而不是只收配置端口）', async () => {
  const env = await newEnv()
  acquireWatchdogLock({ env, port: 7999, pid: 11111, pkgVersion: '0.10.6' })
  updateWatchdogSlot({ env, pid: 11111, patch: { webPid: 22222, webPort: 7999 } })
  assert.equal(readWatchdogLock(env).watchdogs.length, 1)

  const alive = new Set([11111, 22222, 33333])
  const killed = []
  const listeners = {
    7999: { pid: 22222, command: OUR_WEB(7999) },
    8001: { pid: 33333, command: OUR_WEB(8001) },
  }
  const out = await stopWatchdogs({
    env,
    port: 7999,
    checkPort: true,
    timeoutMs: 1,
    isAlive: (pid) => alive.has(Number(pid)),
    kill: (pid) => { killed.push(Number(pid)); alive.delete(Number(pid)); return true },
    sleep: async () => {},
    listProcesses: async () => [{ pid: 22222, command: OUR_WEB(7999) }],
    findListener: async (p) => listeners[p] || null,
  })
  assert.ok(killed.includes(11111), '登记在锁里的 watchdog 要收')
  assert.ok(killed.includes(33333), '窗口里的孤儿 web 也要收')
  assert.ok(out.portStopped.includes(33333))
  // 只承认自己家的：万一 8001 上是别人的进程，就不该出现在这里
  const foreign = await sweepOrphanWebs({
    env, port: 7999, span: 2, lock: { watchdogs: [] },
    findListener: async (p) => (p === 8001 ? { pid: 99999, command: FOREIGN } : null),
    isAlive: () => true,
    kill: () => true,
  })
  assert.deepEqual(foreign.killed, [])
})
