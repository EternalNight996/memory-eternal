// issue #31 / #33 的回归守卫（AkiMei0721 的三层现场，macOS + `A:\AI\DSH数据\` 受限环境）：
//   ① `/overview` 会碰数据库 → 库只读/损坏时它 500；老实现据此判「端口死」→ 调 spawnWeb()
//      （开头先 SIGTERM 掉自己的上一个 child）→ **自杀自拉 + 端口从 7999 漂到 8006**；
//   ② 版本探测也走 `/overview` → 拿不到版本 → verify 报「（无响应）」、status 误判成旧版；
//   ③ 受限沙箱不允许命名管道 → 默认 `stdio:'pipe'` 在 spawn 时同步抛 EPERM → `--reap` 直接崩、
//      进程枚举永远空名单。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideTickAction, probeServedVersion, probeTcp } from '../lib/watchdog.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')
const serve = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler)
  s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }))
})
const freePort = async () => { const { server, port } = await serve(() => {}); await new Promise((r) => server.close(r)); return port }

test('① 决策：/overview 非 200 但 TCP 可连 → 视为存活（绝不自杀自拉）', () => {
  // 现场：库只读 → /overview 500，端口上其实是健康的 web
  assert.deepEqual(
    decideTickAction({ overviewOk: false, tcpAlive: true, restartCount: 0, maxRestart: 10, autoStart: true }),
    { action: 'keep', reason: 'api-degraded-but-listening' },
  )
  // 真的没人听 → 才允许重拉
  assert.equal(decideTickAction({ overviewOk: false, tcpAlive: false, restartCount: 0, maxRestart: 10, autoStart: true }).action, 'respawn')
  assert.equal(decideTickAction({ overviewOk: true, tcpAlive: false }).reason, 'healthy')
  assert.equal(decideTickAction({ overviewOk: false, tcpAlive: false, restartCount: 10, maxRestart: 10 }).action, 'stop')
  assert.equal(decideTickAction({ overviewOk: false, tcpAlive: false, autoStart: false }).action, 'skip')
})

test('② 版本探测优先 /version-check（不碰库），拿不到才回落 /overview', async () => {
  // 只能"库不可用"的实例：/version-check 正常、/overview 500
  const brokenDb = await serve((req, res) => {
    if (req.url.startsWith('/memory-eternal/api/version-check')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, loaded: '9.9.9', onDisk: '9.9.9' }))
      return
    }
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'attempt to write a readonly database' }))
  })
  // 旧版实例：没有 /version-check 路由，只有 /overview
  const oldOnly = await serve((req, res) => {
    if (req.url.startsWith('/memory-eternal/api/overview')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, version: '0.9.9', vaultDir: '/tmp/vault' }))
      return
    }
    res.writeHead(404); res.end('nope')
  })
  try {
    assert.equal(await probeServedVersion(brokenDb.port), '9.9.9', '库坏掉时也要拿得到版本（第②层的病根）')
    assert.equal(await probeServedVersion(oldOnly.port), '0.9.9', '没有 /version-check 的旧版要回落 /overview')
    assert.equal(await probeServedVersion(await freePort(), 300), '', '没人听 → 空串，不抛')
    const alive = await probeTcp(brokenDb.port)
    assert.equal(alive, true, 'TCP 探测本身可用')
  } finally { brokenDb.server.close(); oldOnly.server.close() }
})

test('#30 第五轮：单发版本探测必须能扛住瞬时失败（否则 status/verify 会得出相反结论）', async () => {
  const { probeServedVersion } = await import('../lib/watchdog.js')
  let hits = 0
  const { server, port } = await serve((req, res) => {
    hits += 1
    // 前两次（含 /version-check 与 /overview 各一次）故意失败：模拟重启窗口/瞬时拒绝
    if (hits <= 2) { res.writeHead(503); res.end('busy'); return }
    if (req.url.startsWith('/memory-eternal/api/version-check')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, loaded: '0.10.32' })); return }
    if (req.url.startsWith('/memory-eternal/api/overview')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, vaultDir: '/v', version: '0.10.32' })); return }
    res.writeHead(404); res.end('')
  })
  try {
    assert.equal(await probeServedVersion(port), '0.10.32', '第一次失败后必须重试并最终拿到版本')
    assert.ok(hits >= 3, '确实发生了重试（命中次数 ' + hits + '）')
    // 真没人听 → 仍然是空串（不能把「没人」变成「有」）
    assert.equal(await probeServedVersion(await freePort(), 300), '')
  } finally { server.close() }
})
test('③ 受限环境：进程执行器不再崩，且不依赖命名管道（源码 + 行为）', async () => {
  const src = read('lib/watchdog.js')
  assert.match(src, /stdio: \['ignore', fd, 'ignore'\]/, 'stdout 走临时文件，不碰管道')
  assert.match(src, /return ''   \/\/ 受限环境：宁可「枚举不到」，也不能把调用方（如 --reap）崩掉/, 'spawn 失败要吞掉（老实现会同步抛 EPERM）')
  // 行为：真的跑一个命令能拿到输出；命令不存在也只是空串
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync(process.execPath, ['-e', "console.log('pipe-free-ok')"], { encoding: 'utf8' })
  assert.match(out, /pipe-free-ok/, '（环境自检）')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'me-exec-'))
  try {
    const leftovers = (await fs.readdir(dir)).filter((n) => n.startsWith('me-exec-'))
    assert.deepEqual(leftovers, [], '执行器不该在仓库/临时目录里留垃圾')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('宿主：stall 判据接入了最短运行时长（刚重启不再误报「收尾事件失效」）', () => {
  const src = read('lib/stall.js')
  assert.match(src, /reason: 'too-early'/, '要有「刚起来还太早」的短路')
  assert.match(src, /minUptimeMs = 30 \* 60 \* 1000/, '默认 30 分钟内不报')
  assert.match(read('index.js'), /processStartedAt: stallBaseline/, '宿主要把本进程基线传进去')
})
