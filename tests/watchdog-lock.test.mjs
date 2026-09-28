// dm#6 / #11 回归：看门狗单例锁（多槽）+ 孤儿回收（--reap）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { acquireWatchdogLock, releaseWatchdogLock, readWatchdogLock, isPidAlive, watchdogLockPath, parseWatchdogProcesses, reapStaleWatchdogs } from '../lib/watchdog.js'

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
      kill: (pid) => { killed.push(pid); return true },
    })
    assert.deepEqual(killed, [child.pid], '只应清掉那个孤儿')
    assert.equal(out.scanned, 3)
    assert.ok(out.skipped.includes(process.pid) && out.skipped.includes(process.ppid), '自己与父进程都不得被杀')
  } finally {
    try { child.kill('SIGKILL') } catch {}
  }
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
    kill: (pid) => { killed.push(pid); return true },
  })
  assert.deepEqual(killed, [], '锁中登记的活跃实例不能被 reap 掉')
  assert.equal(out.skipped.length, 1)
})
