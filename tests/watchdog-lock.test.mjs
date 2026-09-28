// dm#6 回归：看门狗单例锁 —— 同端口已有活着的看门狗时，新进程必须让位（否则无限堆积）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { acquireWatchdogLock, releaseWatchdogLock, readWatchdogLock, isPidAlive, watchdogLockPath } from '../lib/watchdog.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'me-wdlock-'))
const env = { DSH_HOME: tmp }
after(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

test('首个看门狗拿到锁；同端口第二个必须拿不到（堆积的根因）', () => {
  const first = acquireWatchdogLock({ env, port: 7999, pid: process.pid })
  assert.equal(first.acquired, true)
  const second = acquireWatchdogLock({ env, port: 7999, pid: process.ppid })
  assert.equal(second.acquired, false, '同端口已有活着的看门狗时必须让位')
  assert.equal(second.previous.pid, process.pid)
})

test('陈旧记录（pid 已不存在）应被接管并报告', async () => {
  const child = spawn(process.execPath, ['-e', '0'])
  await once(child, 'exit')
  assert.equal(isPidAlive(child.pid), false, '已退出的子进程不该算存活')
  await fs.writeFile(watchdogLockPath(env), JSON.stringify({ pid: child.pid, port: 7999, startedAt: 'x' }))
  const r = acquireWatchdogLock({ env, port: 7999, pid: process.pid })
  assert.equal(r.acquired, true)
  assert.equal(r.previous.pid, child.pid)
})

test('不同端口互不影响；释放只清自己的锁', () => {
  acquireWatchdogLock({ env, port: 8000, pid: process.pid })
  assert.equal(releaseWatchdogLock({ env, pid: process.ppid }), false, '不是自己写的锁不能删')
  assert.equal(releaseWatchdogLock({ env, pid: process.pid }), true)
  assert.equal(readWatchdogLock(env), null)
})
