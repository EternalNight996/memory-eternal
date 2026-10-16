// issue #30 第六轮实测：宿主 tick 与 CLI 会**各自拉起一个 --replace 助手**，谁都不写锁、
// 还互相收对方的 web。这里守「单飞互斥」：助手开工前抢 claim，抢不到就退出；
// restartResident 发现接管在进行中也不再重复拉助手。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { claimReplaceSlot, readReplaceClaim, releaseReplaceClaim, replaceClaimPath, restartResident } from '../lib/watchdog.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'me-claim-'))

test('claim：先到先得；持有者活着且没过期时第二个必须让位', () => {
  const dir = mk()
  const env = { DSH_HOME: dir }
  try {
    const a = claimReplaceSlot({ env, port: 7999, pid: process.pid })
    assert.equal(a.claimed, true)
    assert.equal(a.holder, null, '第一条没有前持有者')
    const b = claimReplaceSlot({ env, port: 7999, pid: process.ppid })
    assert.equal(b.claimed, false, '有人在跑就不许抢')
    assert.equal(Number(b.holder.pid), process.pid)
    assert.match(b.reason, /已有接管助手在跑/)
    // 过期（>60s）→ 接管
    const stale = claimReplaceSlot({ env, port: 7999, pid: process.ppid, now: Date.now() + 120000 })
    assert.equal(stale.claimed, true)
    assert.equal(Number(stale.holder.pid), process.pid)
    assert.match(stale.reason, /陈旧 claim/)
    // 同一 pid 再来一次：算自己的，允许（幂等）
    assert.equal(claimReplaceSlot({ env, port: 7999, pid: process.ppid }).claimed, true)
    // 释放：只有持有者能清
    assert.equal(releaseReplaceClaim({ env, pid: process.pid }), false, '不是持有者不许清')
    assert.equal(releaseReplaceClaim({ env, pid: process.ppid }), true)
    assert.equal(readReplaceClaim(env), null)
    assert.match(replaceClaimPath(env), /memory-eternal-replace\.claim$/)
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('claim：死 pid 的陈旧 claim 可以被接管', async () => {
  const dir = mk()
  const env = { DSH_HOME: dir }
  try {
    const { spawn } = await import('node:child_process')
    const { once } = await import('node:events')
    const child = spawn(process.execPath, ['-e', '0'])
    await once(child, 'exit')
    fs.writeFileSync(replaceClaimPath(env), JSON.stringify({ pid: child.pid, port: 7999, at: Date.now() }))
    const got = claimReplaceSlot({ env, port: 7999, pid: process.pid })
    assert.equal(got.claimed, true, '持有者已死 → 接管')
    assert.equal(Number(got.holder.pid), child.pid)
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('restartResident：接管进行中时不再重复拉助手（宿主 tick 与 CLI 抢的同一条路）', async () => {
  const dir = mk()
  const env = { DSH_HOME: dir }
  try {
    // 用另一个活着的进程（父进程）冒充「宿主 tick 那边的助手」—— restartResident 只认别人的 claim
    claimReplaceSlot({ env, port: 7999, pid: process.ppid })
    let spawned = false
    const out = await restartResident({
      port: 7999, env, expectVersion: '0.10.6',
      deps: { spawnHelper: () => { spawned = true; return { pid: 1 } } },
    })
    assert.equal(out.ok, false)
    assert.equal(out.stage, 'in-flight')
    assert.match(out.error, /已有接管正在进行中/)
    assert.equal(spawned, false, '有人在做就不许再拉一个助手')
    // 释放后照常（用注入的 waitForTakeover 让流程走完）
    releaseReplaceClaim({ env, pid: process.ppid })
    const ok = await restartResident({
      port: 7999, env, expectVersion: '0.10.6',
      deps: { spawnHelper: () => ({ pid: 7 }), waitForTakeover: async () => ({ ok: true, version: '0.10.6', waitedMs: 10, tookOver: true }) },
    })
    assert.equal(ok.ok, true)
    assert.equal(ok.helperPid, 7)
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('接线守卫：助手分支要先抢 claim、退出时释放', () => {
  const wd = read('lib/watchdog.js')
  assert.match(wd, /const slotClaim = claimReplaceSlot\(\{ port \}\)/, '助手要抢 claim')
  assert.match(wd, /跳过本次接管：/, '抢不到要让位（不再互相踩）')
  assert.match(wd, /releaseReplaceClaim\(\)/, '退出时要释放 claim')
  assert.match(wd, /stage: 'in-flight'/, 'restartResident 要有 in-flight 分支')
  assert.match(wd, /已有接管正在进行中/, '要如实说明有人在跑')
})
