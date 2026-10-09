// dm#6 / #11 回归：看门狗单例锁（多槽）+ 孤儿回收（--reap）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { acquireWatchdogLock, releaseWatchdogLock, readWatchdogLock, isPidAlive, watchdogLockPath, parseWatchdogProcesses, reapStaleWatchdogs, watchdogStatus, stopWatchdogs, currentPkgVersion, updateWatchdogSlot } from '../lib/watchdog.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'me-wdlock-'))
const env = { DSH_HOME: tmp }
after(async () => { await fs.rm(tmp, { recursive: true, force: true }) })
const slots = () => readWatchdogLock(env).watchdogs

test('同一端口：第二个看门狗必须让位（堆积的根因）', () => {
  assert.equal(acquireWatchdogLock({ env, port: 7999, pid: process.pid }).acquired, true)
  const second = acquireWatchdogLock({ env, port: 7999, pid: process.ppid })
  assert.equal(second.acquired, false, '同端口已有活着的看门狗时必须让位')
  assert.equal(second.previous.pid, process.pid)
})

test('不同端口可以并存（多槽锁，不再互相覆盖）', () => {
  const other = acquireWatchdogLock({ env, port: 8000, pid: process.ppid })
  assert.equal(other.acquired, true)
  const ports = slots().map((w) => w.port).sort()
  assert.deepEqual(ports, [7999, 8000], '两个端口的槽都要在')
})

test('陈旧记录（pid 已不存在）应被接管并报告', async () => {
  const child = spawn(process.execPath, ['-e', '0'])
  await once(child, 'exit')
  assert.equal(isPidAlive(child.pid), false)
  await fs.writeFile(watchdogLockPath(env), JSON.stringify({ watchdogs: [{ pid: child.pid, port: 8100 }] }))
  const r = acquireWatchdogLock({ env, port: 8100, pid: process.pid })
  assert.equal(r.acquired, true)
  assert.ok(r.reaped.includes(child.pid), '死掉的槽应被记为已回收')
})

test('兼容早期单槽格式；释放只清自己那一槽', async () => {
  await fs.writeFile(watchdogLockPath(env), JSON.stringify({ pid: process.ppid, port: 8200 }))
  assert.equal(slots()[0].pid, process.ppid, '旧格式要能被读成单槽')
  assert.equal(releaseWatchdogLock({ env, pid: process.pid }), false, '不是自己写的不该动')
  assert.equal(releaseWatchdogLock({ env, pid: process.ppid }), true)
  assert.deepEqual(slots(), [])
})

test('parseWatchdogProcesses：POSIX 与 Windows 输出都能解析，且只认 watchdog.js', () => {
  const posix = [
    '  120163       1  08:35:36  node /opt/x/lib/watchdog.js --port 7999 --interval 5000',
    '  999999       1  00:00:01  node /opt/x/lib/web.js --port 7999',
  ].join('\n')
  const a = parseWatchdogProcesses(posix, 'linux')
  assert.equal(a.length, 1, '普通 web 进程不得被当成 watchdog')
  assert.equal(a[0].pid, 120163)
  assert.equal(a[0].port, 7999)
  const win = [
    '"ProcessId","CommandLine"',
    '"4242","node C:\\x\\lib\\watchdog.js --port 8000 --interval 5000"',
    '"4243","node C:\\x\\lib\\web.js --port 8000"',
  ].join('\r\n')
  const b = parseWatchdogProcesses(win, 'win32')
  assert.equal(b.length, 1)
  assert.equal(b[0].pid, 4242)
  assert.equal(b[0].port, 8000)
  assert.equal(parseWatchdogProcesses('', 'linux').length, 0)
})

test('reapStaleWatchdogs：只杀同端口、不在锁里的孤儿（kill 注入，不会真杀）', async () => {
  const env2 = { DSH_HOME: path.join(tmp, 'reap') }
  // 需要一个「真实存活、且不是自己/父进程」的 pid：起一个空转的子进程
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 300))
  try {
    const killed = []
    const out = await reapStaleWatchdogs({
      port: 7999,
      keepPid: process.pid,
      env: env2,
      list: async () => [
        { pid: child.pid, port: 7999, command: 'node watchdog.js --port 7999' },          // 活着的孤儿 → 清
        { pid: process.pid, port: 7999, command: 'node watchdog.js --port 7999 --reap' },  // 自己（正 reap）→ 必须留
        { pid: process.ppid, port: 8000, command: 'node watchdog.js --port 8000' },        // 其它端口 → 留
      ],
      // 这个用例只谈 watchdog：显式声明「没有 web 可收」，否则 reap 会去列本机真实 web（测试不该碰真实进程表）
      listWebs: async () => [],
      kill: (pid) => { killed.push(pid); return true },
    })
    assert.deepEqual(killed, [child.pid], '只应清掉那个孤儿')
    assert.equal(out.scanned, 3)
    assert.ok(out.skipped.includes(process.pid) && out.skipped.includes(process.ppid), '自己与父进程都不得被杀')
  } finally {
    try { child.kill('SIGKILL') } catch {}
  }
})

// -- issue #19：锁里带版本 / status / 显式 stop ---------------------------------
test('锁槽写入 pkgVersion，status 能报出「常驻实例是旧版」', () => {
  const envV = { DSH_HOME: path.join(tmp, 'ver') }
  const staleVersion = '0.0.1-旧版'
  assert.notEqual(staleVersion, currentPkgVersion())
  acquireWatchdogLock({ env: envV, port: 7999, pid: process.pid, pkgVersion: staleVersion })
  const st = watchdogStatus({ env: envV, port: 7999 })
  assert.equal(st.watchdogs.length, 1)
  assert.equal(st.watchdogs[0].pkgVersion, staleVersion)
  assert.equal(st.watchdogs[0].alive, true)
  assert.equal(st.watchdogs[0].versionMismatch, true, '与磁盘上的包版本不一致要被标出来')
  assert.equal(currentPkgVersion().length > 0, true, '要能读到当前包版本（写进锁做漂移检测）')
  // 端口过滤
  assert.equal(watchdogStatus({ env: envV, port: 8000 }).watchdogs.length, 0)
})

test('stopWatchdogs：SIGTERM 活着的槽、清掉锁槽，不动其它端口', async () => {
  const envS = { DSH_HOME: path.join(tmp, 'stop') }
  acquireWatchdogLock({ env: envS, port: 7999, pid: process.pid, pkgVersion: '0.10.2' })
  acquireWatchdogLock({ env: envS, port: 8000, pid: process.ppid, pkgVersion: '0.10.2' })
  const killed = []
  const alive = new Set([process.pid, process.ppid])
  const out = await stopWatchdogs({
    env: envS, port: 7999,
    isAlive: (pid) => alive.has(Number(pid)),
    kill: (pid) => { killed.push(Number(pid)); alive.delete(Number(pid)); return true },
    sleep: async () => {},
  })
  assert.deepEqual(killed, [process.pid], '只停指定端口')
  assert.deepEqual(out.stopped, [process.pid])
  assert.deepEqual(out.failed, [])
  const rest = readWatchdogLock(envS).watchdogs
  assert.deepEqual(rest.map((w) => w.port), [8000], '只清自己那一槽')
})

test('stopWatchdogs：拒不退出 / 无权限的实例要显式报 failed，不能假装成功', async () => {
  const envF = { DSH_HOME: path.join(tmp, 'stop-fail') }
  acquireWatchdogLock({ env: envF, port: 7999, pid: process.ppid, pkgVersion: '0.10.2' })
  const out = await stopWatchdogs({
    env: envF,
    isAlive: () => true,                       // 永远活着
    kill: () => true,
    sleep: async () => {},
    timeoutMs: 1,
  })
  assert.deepEqual(out.failed, [process.ppid])
  assert.equal(readWatchdogLock(envF).watchdogs.length, 1, '没停掉的实例不能从锁里抹掉')
})

test('stopWatchdogs：锁里已死的陈旧槽直接清理，不算失败', async () => {
  const envD = { DSH_HOME: path.join(tmp, 'stop-dead') }
  acquireWatchdogLock({ env: envD, port: 7999, pid: process.ppid, pkgVersion: '0.10.2' })
  const out = await stopWatchdogs({ env: envD, port: 7999, isAlive: () => false, kill: () => true, sleep: async () => {} })
  assert.deepEqual(out.stopped, [])
  assert.deepEqual(out.failed, [])
  assert.deepEqual(out.skipped, [process.ppid])
  assert.deepEqual(readWatchdogLock(envD).watchdogs, [], '陈旧槽应被清掉')
})

test('updateWatchdogSlot：就地记下 web 子进程 pid；槽不存在返回 null', () => {
  const envU = { DSH_HOME: path.join(tmp, 'slot') }
  assert.equal(updateWatchdogSlot({ env: envU, pid: 424242, patch: { webPid: 1 } }), null, '槽不存在时不得凭空造一条')
  acquireWatchdogLock({ env: envU, port: 7999, pid: process.pid, pkgVersion: '0.10.2' })
  const hit = updateWatchdogSlot({ env: envU, pid: process.pid, patch: { webPid: process.ppid, webPort: 7999 } })
  assert.equal(hit.webPid, process.ppid)
  const st = watchdogStatus({ env: envU, port: 7999 })
  assert.equal(st.watchdogs[0].webPid, process.ppid)
  assert.equal(st.watchdogs[0].webPort, 7999)
  assert.equal(st.watchdogs[0].webAlive, true)
})

test('stopWatchdogs：连 watchdog 拉起的 web 一起收（Windows 硬终止会留下占端口的孤儿）', async () => {
  const envW = { DSH_HOME: path.join(tmp, 'stop-web') }
  acquireWatchdogLock({ env: envW, port: 7999, pid: process.pid, pkgVersion: '0.10.2' })
  updateWatchdogSlot({ env: envW, pid: process.pid, patch: { webPid: process.ppid, webPort: 7999 } })
  const alive = new Set([process.pid, process.ppid])
  const killed = []
  const out = await stopWatchdogs({
    env: envW, port: 7999,
    isAlive: (pid) => alive.has(Number(pid)),
    kill: (pid) => { killed.push(Number(pid)); alive.delete(Number(pid)); return true },
    sleep: async () => {},
    listProcesses: async () => [{ pid: process.ppid, port: 7999, command: 'node E:/x/lib/web.js --port 7999' }],
  })
  assert.deepEqual(out.stopped, [process.pid])
  assert.deepEqual(out.webStopped, [process.ppid], 'watchdog 拉起的 web 必须一起停')
  assert.deepEqual(killed, [process.pid, process.ppid])
  assert.deepEqual(readWatchdogLock(envW).watchdogs, [], '锁槽要清干净')
})

test('stopWatchdogs：pid 复用防护 —— 枚举不到对应 web.js 就不杀', async () => {
  const envX = { DSH_HOME: path.join(tmp, 'stop-web-guard') }
  acquireWatchdogLock({ env: envX, port: 7999, pid: process.pid, pkgVersion: '0.10.2' })
  updateWatchdogSlot({ env: envX, pid: process.pid, patch: { webPid: process.ppid, webPort: 7999 } })
  const killed = []
  const out = await stopWatchdogs({
    env: envX, port: 7999,
    timeoutMs: 1,
    isAlive: () => true,
    kill: (pid) => { killed.push(Number(pid)); return true },
    sleep: async () => {},
    listProcesses: async () => [],
  })
  assert.deepEqual(killed, [process.pid], '只停 watchdog 本身；未确认的 webPid 一个都不许杀')
  assert.ok(out.skipped.includes(process.ppid))
  assert.deepEqual(out.webStopped, [])
})

test('parseWatchdogProcesses：marker 可切换（用 web.js 确认 web 子进程）', () => {
  const text = [
    '"100","node C:\\x\\lib\\watchdog.js --port 7999"',
    '"200","node C:\\x\\lib\\web.js --port 7999 --vault C:\\v"',
  ].join('\r\n')
  assert.deepEqual(parseWatchdogProcesses(text, 'win32').map((p) => p.pid), [100])
  const webs = parseWatchdogProcesses(text, 'win32', 'web.js')
  assert.deepEqual(webs.map((p) => p.pid), [200])
  assert.equal(webs[0].port, 7999)
})

test('reapStaleWatchdogs：锁里登记且活着的实例不得被误杀', async () => {
  const env3 = { DSH_HOME: path.join(tmp, 'reap2') }
  acquireWatchdogLock({ env: env3, port: 7999, pid: process.pid })
  const killed = []
  const out = await reapStaleWatchdogs({
    port: 7999,
    keepPid: 0,
    env: env3,
    list: async () => [{ pid: process.pid, port: 7999, command: 'node watchdog.js --port 7999' }],
    listWebs: async () => [],
    kill: (pid) => { killed.push(pid); return true },
  })
  assert.deepEqual(killed, [], '锁中登记的活跃实例不能被 reap 掉')
  assert.equal(out.skipped.length, 1)
})
