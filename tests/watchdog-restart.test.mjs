// 版本漂移自愈回归：常驻 web 比 DSH 活得久，升级只换磁盘文件 ——
// 重启 DSH 换不掉端口上那个旧进程（issue #19/#23 的现场）。
// 覆盖：
//   ① decideResidentAction 的决策矩阵（delegate / spawn / restart / warn + 防抖）
//   ② inspectResident：版本一律问端口，不读锁里的自述
//   ③ restartResident：替换 + 自检（成功 / 自检失败 / 助手 spawn 失败）
//   ④ clearResidentForTakeover：端口没空出来必须如实报告（否则新 web 退让出孤儿）
//   ⑤ /restart-self 路由：已经是最新就别白折腾、先回响应再调度、并发闸门
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  decideResidentAction, inspectResident, restartResident, clearResidentForTakeover,
  acquireWatchdogLock, readWatchdogLock,
} from '../lib/watchdog.js'
import { createApi, compareVersions, parseVersion } from '../lib/api.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'me-wdrestart-'))
after(async () => { await fs.rm(tmp, { recursive: true, force: true }) })
const env = { DSH_HOME: path.join(tmp, 'home') }

/** 起一个立刻退出、拿到一个确定已经死掉的 pid（锁里放陈旧记录用）。 */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'])
  await once(child, 'exit')
  return child.pid
}

// -- ① 决策矩阵 ---------------------------------------------------------------

test('decideResidentAction：版本一致 → delegate（不动常驻实例）', () => {
  const d = decideResidentAction({ served: '0.10.6', expect: '0.10.6', watchdogAlive: true })
  assert.equal(d.action, 'delegate')
  assert.equal(d.stale, false)
  assert.equal(d.reason, 'up-to-date')
})

test('decideResidentAction：版本漂移 → restart（这就是「更新运行中的程序」）', () => {
  const d = decideResidentAction({ served: '0.10.0', expect: '0.10.6', watchdogAlive: true })
  assert.equal(d.action, 'restart')
  assert.equal(d.stale, true)
  assert.equal(d.reason, 'version-drift')
})

test('decideResidentAction：旧版 web 不自报版本但占着端口 → 同样算漂移', () => {
  const d = decideResidentAction({ served: '', expect: '0.10.6', watchdogAlive: true, occupantIsOurs: true })
  assert.equal(d.action, 'restart')
  assert.equal(d.reason, 'resident-silent-version')
})

test('decideResidentAction：autoRestartOnDrift 关闭 → 只告警，不自动重启', () => {
  const d = decideResidentAction({ served: '0.10.0', expect: '0.10.6', watchdogAlive: true, autoRestart: false })
  assert.equal(d.action, 'warn')
  assert.equal(d.stale, true)
})

test('decideResidentAction：刚替换过（防抖窗口内）不再重启，避免效果重跑时反复折腾', () => {
  const d = decideResidentAction({ served: '0.10.0', expect: '0.10.6', watchdogAlive: true, residentStartedAt: 1000, now: 1000 + 5000, debounceMs: 60000 })
  assert.equal(d.action, 'delegate')
  assert.equal(d.reason, 'debounced')
  // 窗口之外照旧重启
  assert.equal(decideResidentAction({ served: '0.10.0', expect: '0.10.6', watchdogAlive: true, residentStartedAt: 1000, now: 1000 + 61000, debounceMs: 60000 }).action, 'restart')
})

test('decideResidentAction：读不到本机版本 / 端口空着 / 端口被别人的进程占着', () => {
  // 没有判据时绝不乱杀：读不到 expect 就只委派
  assert.equal(decideResidentAction({ served: '0.10.0', expect: '', watchdogAlive: true }).action, 'delegate')
  assert.equal(decideResidentAction({ served: '', expect: '', watchdogAlive: false }).action, 'spawn')
  // 端口空着、也没有常驻实例 → 拉起一个
  assert.equal(decideResidentAction({ served: '', expect: '0.10.6', watchdogAlive: false, occupantIsOurs: false }).action, 'spawn')
  // 端口被**别人**占着（不是我们的 web）→ 不算漂移，别去动它
  const foreign = decideResidentAction({ served: '', expect: '0.10.6', watchdogAlive: true, occupantIsOurs: false })
  assert.equal(foreign.action, 'delegate')
  assert.equal(foreign.stale, false)
})

// -- ② 体检：版本问端口，不问锁 ----------------------------------------------

test('inspectResident：端口自报版本时以它为准，并认出占用者是不是本插件的 web', async () => {
  const envA = { DSH_HOME: path.join(tmp, 'inspect-a') }
  acquireWatchdogLock({ env: envA, port: 7999, pid: process.pid, pkgVersion: '0.10.6' })
  const info = await inspectResident({
    env: envA,
    port: 7999,
    probeVersion: async () => '0.10.0',
    findListener: async () => { throw new Error('能自报版本时不该去问端口占用者') },
  })
  assert.equal(info.served, '0.10.0', '锁里写的是 0.10.6，但端口上真正服务的是 0.10.0')
  assert.equal(info.watchdogAlive, true)
  assert.equal(info.occupant, null)
  assert.ok(info.residentStartedAt > 0)

  const envB = { DSH_HOME: path.join(tmp, 'inspect-b') }
  const ours = await inspectResident({
    env: envB,
    port: 7999,
    probeVersion: async () => '',
    findListener: async () => ({ pid: 4242, command: 'node F:/MyApp/eternal/memory-eternal/lib/web.js --port 7999' }),
  })
  assert.equal(ours.served, '')
  assert.equal(ours.occupantIsOurs, true, '命令行带包名/本插件 web.js 路径 → 是我们自己的 web')
  const foreign = await inspectResident({
    env: envB,
    port: 7999,
    probeVersion: async () => '',
    findListener: async () => ({ pid: 4243, command: 'node C:/other-project/web.js --port 7999' }),
  })
  assert.equal(foreign.occupantIsOurs, false, '别人的 node web.js 不能认成我们的')
})

// -- ③ 替换 + 自检 -------------------------------------------------------------

test('restartResident：spawn 替换助手后自检端口版本，成功才算成功', async () => {
  const envR = { DSH_HOME: path.join(tmp, 'restart') }
  acquireWatchdogLock({ env: envR, port: 7999, pid: process.pid, pkgVersion: '0.10.0' })
  let spawned = null
  const out = await restartResident({
    port: 7999, env: envR, expectVersion: '0.10.6',
    deps: {
      spawnHelper: (o) => { spawned = o; return { pid: 4321 } },
      waitForServedVersion: async (port, expect) => {
        assert.equal(port, 7999)
        assert.equal(expect, '0.10.6')
        return { ok: true, version: '0.10.6', waitedMs: 1500 }
      },
    },
  })
  assert.equal(out.ok, true)
  assert.equal(out.stage, 'done')
  assert.equal(out.helperPid, 4321)
  assert.equal(out.served, '0.10.6')
  assert.equal(spawned.port, 7999)
  assert.equal(out.before.length, 1, '要把被替换的旧实例如实带回去')
})

test('restartResident：端口上还是旧版本 → 必须报失败（不许只看 spawn 成功就报好）', async () => {
  const out = await restartResident({
    port: 7999, env, expectVersion: '0.10.6',
    deps: {
      spawnHelper: () => ({ pid: 1 }),
      waitForServedVersion: async () => ({ ok: false, version: '0.10.0', waitedMs: 25000 }),
    },
  })
  assert.equal(out.ok, false)
  assert.equal(out.stage, 'verify')
  assert.ok(out.error.includes('0.10.0'))
})

test('restartResident：助手 spawn 失败 → 如实报 spawn-helper，不假装重启了', async () => {
  const out = await restartResident({
    port: 7999, env, expectVersion: '0.10.6',
    deps: { spawnHelper: () => { throw new Error('EPERM') }, waitForServedVersion: async () => ({ ok: true, version: '0.10.6', waitedMs: 1 }) },
  })
  assert.equal(out.ok, false)
  assert.equal(out.stage, 'spawn-helper')
  assert.ok(out.error.includes('EPERM'))
})

// -- ④ 接管前清场 --------------------------------------------------------------
// 注意：这一组必须把 findListener / kill 都注进去 —— 用例跑在开发机上时，
// 7999 上正跑着真实插件实例，绝不能真去问真端口、更不能真杀它。

/** 只认死 pid 的 isAlive/kill：防止单测碰到真进程。 */
const inertDeps = (listener) => ({
  findListener: async () => listener,
  kill: () => true,
  isAlive: () => false,
  sleep: async () => {},
})

test('clearResidentForTakeover：清掉陈旧锁槽并确认端口空出来', async () => {
  const envC = { DSH_HOME: path.join(tmp, 'takeover-ok') }
  acquireWatchdogLock({ env: envC, port: 7999, pid: await deadPid(), pkgVersion: '0.10.0' })
  const out = await clearResidentForTakeover({ port: 7999, env: envC, timeoutMs: 0, deps: inertDeps(null) })
  assert.equal(out.portFree, true)
  assert.deepEqual(readWatchdogLock(envC).watchdogs, [], '陈旧锁槽要被清掉')
})

test('clearResidentForTakeover：端口被别人的进程占着 → portFree=false + 告警，绝不误杀', async () => {
  const envC = { DSH_HOME: path.join(tmp, 'takeover-foreign') }
  const killed = []
  const out = await clearResidentForTakeover({
    port: 7999, env: envC, timeoutMs: 0,
    deps: { ...inertDeps({ pid: 4242, command: 'node C:/other-project/web.js --port 7999' }), kill: (pid) => { killed.push(pid); return true } },
  })
  assert.equal(out.portFree, false)
  assert.ok(out.warnings.some((w) => w.includes('4242')), '要说清楚端口被谁占着')
  assert.deepEqual(killed, [], '不是本插件的 web 一个都不许动')
})

test('clearResidentForTakeover：自家旧 web 杀不掉（无权限）也不能抛，如实报端口未空', async () => {
  const envC = { DSH_HOME: path.join(tmp, 'takeover-ours') }
  const attempts = []
  const out = await clearResidentForTakeover({
    port: 7999, env: envC, timeoutMs: 2000,
    deps: {
      ...inertDeps({ pid: 999999, command: 'node F:/MyApp/eternal/memory-eternal/lib/web.js --port 7999' }),
      // kill 返回 false = 无权限/收不掉：必须立刻停手，且把「端口没空出来」如实报出去
      kill: (pid) => { attempts.push(pid); return false },
    },
  })
  assert.equal(out.portFree, false)
  assert.deepEqual(attempts, [999999], '收不掉就不要反复重试')
})

// -- ⑤ /restart-self 路由 ------------------------------------------------------

/** 假响应对象：json() 会读 res.req.headers 做压缩协商，所以 req 也要给上。 */
function fakeRes() {
  const rec = { status: 0, body: '', events: [] }
  const res = {
    req: { headers: {} },
    writeHead(status) { rec.status = status },
    end(b) { rec.body = b ? String(b) : ''; rec.events.push('respond') },
  }
  return { rec, res }
}
const bodyOf = (rec) => { try { return JSON.parse(rec.body) } catch { return null } }

test('/restart-self：常驻实例已经是最新版 → alreadyCurrent，且一次替换都不发起', async () => {
  const restarted = []
  const api = createApi({
    vaultDir: () => tmp,
    getSettings: () => ({ webPort: 7999 }),
    getDshInfo: () => ({ version: '0.10.0' }),
    currentPkgVersion: () => '0.10.6',
    probeServedVersion: async () => '0.10.6',
    restartResident: async () => { restarted.push('restart'); return { ok: true } },
  })
  const { rec, res } = fakeRes()
  await api({ method: 'POST', url: '/memory-eternal/api/restart-self' }, res)
  const d = bodyOf(rec)
  assert.equal(d.ok, true)
  assert.equal(d.alreadyCurrent, true)
  assert.equal(d.served, '0.10.6')
  assert.equal(restarted.length, 0, '已经是最新就不许白折腾常驻实例')
})

test('/restart-self：非 POST → 405', async () => {
  const api = createApi({ vaultDir: () => tmp, getSettings: () => ({ webPort: 7999 }), getDshInfo: () => ({ version: '1' }) })
  const { rec, res } = fakeRes()
  await api({ method: 'GET', url: '/memory-eternal/api/restart-self' }, res)
  assert.equal(rec.status, 405)
})

test('/restart-self：漂移时先回响应再调度替换（本进程可能正是要被替换的旧 web）', async () => {
  const order = []
  const api = createApi({
    vaultDir: () => tmp,
    getSettings: () => ({ webPort: 7999, webCheckIntervalMs: 5000, webMaxRestart: 10 }),
    getDshInfo: () => ({ version: '0.10.0' }),
    currentPkgVersion: () => '0.10.6',
    // 旧版不自报版本（< v0.10.4 的现场）
    probeServedVersion: async () => '',
    restartResident: async ({ port }) => { order.push('restart:' + port); return { ok: true, served: '0.10.6' } },
  })
  const first = fakeRes()
  await api({ method: 'POST', url: '/memory-eternal/api/restart-self' }, first.res)
  const d = bodyOf(first.rec)
  assert.equal(d.scheduled, true)
  assert.equal(d.expect, '0.10.6')
  assert.equal(order.length, 0, '响应返回时替换还没开始（先回响应，否则旧 web 会被自己收掉）')

  // 并发闸门：同一时刻只允许一个替换
  const second = fakeRes()
  await api({ method: 'POST', url: '/memory-eternal/api/restart-self' }, second.res)
  assert.equal(bodyOf(second.rec).alreadyRunning, true)

  await new Promise((r) => setTimeout(r, 700))
  assert.deepEqual(order, ['restart:7999'], '调度到点上必须真的发起替换')
  assert.deepEqual(first.rec.events, ['respond'], '响应在替换之前就已写出')
  // 等 finally 复位闸门，避免影响后续用例
  await new Promise((r) => setTimeout(r, 100))
})

// -- 版本比较（updateAvailable 不再劝人装回旧版） --------------------------------

test('compareVersions / parseVersion：本地未发布版本不该被判成「有新版本」', () => {
  assert.equal(compareVersions('0.10.6', '0.10.7'), -1)
  assert.equal(compareVersions('0.10.7', '0.10.6'), 1)
  assert.equal(compareVersions('0.10.6', '0.10.6'), 0)
  assert.equal(compareVersions('v0.11.0', '0.10.9'), 1, '容忍 v 前缀')
  assert.equal(compareVersions('0.11.0-rc.1', '0.11.0'), -1, '预发布版 < 正式版')
  assert.equal(compareVersions('0.11.0-rc.2', '0.11.0-rc.10'), -1)
  assert.equal(compareVersions('乱七八糟', '0.10.6'), 0, '解析不出来不比大小')
  assert.deepEqual(parseVersion('0.10.6-rc.1').pre, 'rc.1')
  assert.equal(parseVersion('nope'), null)
})
