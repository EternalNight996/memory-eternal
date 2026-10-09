// issue #11 补充实测（alario-tang，macOS arm64）的回归守卫：
//   「watchdog 先死 + 锁文件丢失」时留下的孤儿 **web.js**，三条收敛入口都够不着它。
//
// 两个具体缺口，各锁一条：
//   ① POSIX 侧 findPortListener 只拿到**进程名**（lsof 的 c 字段 = node），
//      而「要不要收」的判据要求命令行含 memory-eternal / 本机 web.js 绝对路径 → 判据恒假 → 永不杀；
//   ② `--reap` 只认 watchdog.js，配置端口上的孤儿 web 不在匹配范围。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  findPortListener, looksLikeOurWeb, reapStaleWatchdogs,
  acquireWatchdogLock, updateWatchdogSlot,
} from '../lib/watchdog.js'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'me-orphanweb-'))
const procs = []
const idle = () => { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], { stdio: 'ignore', windowsHide: true }); procs.push(c); return c.pid }
after(async () => {
  for (const c of procs) { try { c.kill() } catch { /* 已退出 */ } }
  try { await fs.rm(tmpRoot, { recursive: true, force: true }) } catch { /* Windows 句柄未释放时忽略 */ }
})
let seq = 0
const newEnv = async () => { const home = path.join(tmpRoot, 'home-' + (++seq)); await fs.mkdir(home, { recursive: true }); return { DSH_HOME: home } }
const OUR_WEB = (port) => '/Users/harrytang/.dsh/profiles/desktop/node_modules/memory-eternal/lib/web.js --port ' + port + ' --vault /Users/harrytang/.dsh/memory-vault'
const FOREIGN_WEB = '/Users/harrytang/other-project/web.js --port 7999'

test('① POSIX：端口占用者要拿**完整命令行**（只给进程名时判据恒假 → 永远收不掉）', async () => {
  const exec = async (cmd, args) => {
    if (cmd === 'lsof') return 'p73857\ncnode\nn127.0.0.1:7999\n'
    if (cmd === 'ps') return 'node ' + OUR_WEB(7999) + '\n'
    return ''
  }
  const hit = await findPortListener(7999, { exec, platform: 'linux' })
  assert.equal(hit.pid, 73857)
  assert.match(hit.command, /memory-eternal\/lib\/web\.js/, 'ps 的完整命令行要带出来')
  assert.equal(looksLikeOurWeb(hit.command), true, '完整命令行必须能过「是不是自家 web」的判定')

  // ps 拿不到（容器里没 ps / 进程已退出）→ 退回旧行为：仍是占用者，但判据为假 → 只告警不杀
  const execNoPs = async (cmd) => (cmd === 'lsof' ? 'p73857\ncnode\nn127.0.0.1:7999\n' : '')
  const fallback = await findPortListener(7999, { exec: execNoPs, platform: 'darwin' })
  assert.equal(fallback.pid, 73857)
  assert.equal(fallback.command, 'node 127.0.0.1:7999')
  assert.equal(looksLikeOurWeb(fallback.command), false, '宁可不认，也不误杀')
})

test('② reap：配置端口上「托管者已死」的孤儿 web 要被收掉', async () => {
  const env = await newEnv()
  const webPid = idle()
  const killed = []
  const out = await reapStaleWatchdogs({
    env, port: 7999, keepPid: process.pid,
    list: async () => [],
    listWebs: async () => [{ pid: webPid, port: 7999, command: OUR_WEB(7999) }],
    kill: (pid) => { killed.push(Number(pid)); return true },
  })
  assert.deepEqual(out.webKilled, [webPid], '孤儿 web 必须进回收名单')
  assert.deepEqual(killed, [webPid])
  assert.equal(out.scanned, 1, '扫描计数要含 web')
})

test('② 托管者还活着（登记在锁里）→ 不许动它的 web', async () => {
  const env = await newEnv()
  const watchdogPid = idle()
  const webPid = idle()
  acquireWatchdogLock({ env, port: 7999, pid: watchdogPid, pkgVersion: '0.10.12' })
  updateWatchdogSlot({ env, pid: watchdogPid, patch: { webPid, webPort: 7999 } })
  const killed = []
  const out = await reapStaleWatchdogs({
    env, port: 7999, keepPid: process.pid,
    list: async () => [],
    listWebs: async () => [{ pid: webPid, port: 7999, command: OUR_WEB(7999) }],
    kill: (pid) => { killed.push(Number(pid)); return true },
  })
  assert.deepEqual(out.webKilled, [], '有托管者的 web 不是孤儿')
  assert.deepEqual(killed, [])
  assert.ok(out.skipped.includes(webPid))
})

test('② 别的端口 / 别人的 web.js：一个都不许动', async () => {
  const env = await newEnv()
  const otherPort = idle()
  const foreign = idle()
  const killed = []
  const out = await reapStaleWatchdogs({
    env, port: 7999, keepPid: process.pid,
    list: async () => [],
    listWebs: async () => [
      { pid: otherPort, port: 8001, command: OUR_WEB(8001) },
      { pid: foreign, port: 7999, command: FOREIGN_WEB },
    ],
    kill: (pid) => { killed.push(Number(pid)); return true },
  })
  assert.deepEqual(out.webKilled, [])
  assert.deepEqual(killed, [], '别的端口 / 外来进程都不动')
})

test('② 自己 / 父进程 / 带 --reap 的同类进程永不在回收范围内', async () => {
  const env = await newEnv()
  const self = idle()
  const killed = []
  const out = await reapStaleWatchdogs({
    env, port: 7999, keepPid: self,
    list: async () => [],
    listWebs: async () => [
      { pid: self, port: 7999, command: OUR_WEB(7999) },
      { pid: idle(), port: 7999, command: OUR_WEB(7999) + ' --reap' },
    ],
    kill: (pid) => { killed.push(Number(pid)); return true },
  })
  assert.deepEqual(out.webKilled, [])
  assert.deepEqual(killed, [], 'keepPid 与 --reap 同类进程都要放过')
})
