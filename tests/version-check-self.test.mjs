// issue #45（严重回归）：/version-check 与 /restart-self 曾向**自己**发请求 → 无深度限制的递归
//   → listen backlog 打满 → 间歇 ECONNREFUSED（17–37ms）+ TIME_WAIT 静置也涨 + served 反成空串；
//   0.10.36 的「重试 3 次」把它乘以 3。
// issue #44：长命 watchdog 用已删除的 node 路径 spawn web 静默失败；宿主据此误判 delegated。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi } from '../lib/api.js'
import { decideResidentAction } from '../lib/watchdog.js'
import { nodeBinary, binaryUsable } from '../lib/node-bin.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')

const fakeRes = () => {
  const rec = { status: 0, body: '' }
  const res = { writeHead(s) { rec.status = s }, end(b) { rec.body = b ? String(b) : '' }, setHeader() {}, on() {}, once() {}, emit() {} }
  return { rec, res }
}
const bodyOf = (rec) => { try { return JSON.parse(rec.body) } catch { return null } }

test('#45：/version-check 探到「自己」时必须直接作答，绝不再发一条请求（递归源头）', async () => {
  let probed = 0
  const api = createApi({
    vaultDir: () => process.env.TEMP,
    getSettings: () => ({ webPort: 7999 }),
    currentPkgVersion: () => '0.10.37',
    selfPort: () => 7999,
    probeServedVersion: async () => { probed += 1; return '0.10.37' },
    findLatestVersion: async () => '',
    readWatchdogLock: () => ({ watchdogs: [] }),
    probeLockWritable: () => ({ writable: true, path: 'x' }),
  })
  const { rec, res } = fakeRes()
  await api({ method: 'GET', url: '/memory-eternal/api/version-check' }, res)
  const d = bodyOf(rec)
  assert.ok(d && d.ok, '要有正常响应')
  assert.equal(probed, 0, '自探次数必须为 0（否则就是那条递归链）')
  assert.equal(d.resident.probedSelf, true, '要如实标注「问的是自己」')
  assert.equal(d.resident.served, d.loaded, '自己的版本就是 loaded')
})

test('#45：其它端口仍然正常探测（闸门只挡自探）', async () => {
  let probed = 0
  const api = createApi({
    vaultDir: () => process.env.TEMP,
    getSettings: () => ({ webPort: 7999 }),
    currentPkgVersion: () => '0.10.37',
    selfPort: () => 7999,
    probeServedVersion: async () => { probed += 1; return '0.10.30' },
    findLatestVersion: async () => '',
    readWatchdogLock: () => ({ watchdogs: [] }),
    probeLockWritable: () => ({ writable: true, path: 'x' }),
  })
  const { rec, res } = fakeRes()
  await api({ method: 'GET', url: '/memory-eternal/api/version-check?port=7001' }, res)
  const d = bodyOf(rec)
  assert.equal(probed >= 1, true, '问别人时照常探')
  assert.equal(d.resident.served, '0.10.30')
  assert.equal(d.resident.probedSelf, false)
})

test('#44：决策 —— 登记说 watchdog 活着但端口没人应答 → 必须 restart，不许 delegate', () => {
  const dead = decideResidentAction({ served: '', expect: '0.10.37', watchdogAlive: true, portServing: false })
  assert.equal(dead.action, 'restart', '僵尸看门狗要重启（用当前 node 重新拉起）')
  assert.equal(dead.reason, 'watchdog-port-dead')
  const deadNoAuto = decideResidentAction({ served: '', expect: '0.10.37', watchdogAlive: true, portServing: false, autoRestart: false })
  assert.equal(deadNoAuto.action, 'warn', '关掉自动重启时至少要给 warn')
  // 端口确实在应答 → 维持 delegate（不误杀）
  assert.equal(decideResidentAction({ served: '', expect: '0.10.37', watchdogAlive: true, portServing: true }).action, 'delegate')
  // 未知（没探）→ 保持旧语义
  assert.equal(decideResidentAction({ served: '', expect: '0.10.37', watchdogAlive: true }).action, 'delegate')
})

test('#44：node 可执行文件解析要验存在性（brew 升级后旧路径会消失）', () => {
  const bin = nodeBinary()
  assert.equal(typeof bin, 'string')
  assert.equal(binaryUsable(bin), true, '当前进程解析出来的 node 必须是存在的')
  assert.equal(binaryUsable('C:/definitely/not/here/node'), false)
  const src = read('lib/node-bin.js')
  assert.match(src, /cachedSource !== 'env' && !exists\(cachedBinary\)/, '缓存命中前要验存在')
  assert.match(src, /path-fallback/, '旧 execPath 消失时要回退 PATH')
  assert.match(read('index.js'), /portServing: info\.portServing/, '宿主要把端口应答情况喂给决策')
  assert.match(read('bin/dsh-memory.mjs'), /子进程 node：/, 'status 要打印实际用的 node 与存在性')
})
