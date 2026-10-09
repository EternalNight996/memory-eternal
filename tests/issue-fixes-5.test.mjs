// issue #29 的回归守卫（2026-10-08 实测现场：升级期旧包遗留实例占着 7999 时，
// 宿主 `ensureWebServer` 向后漂到 8000，而自愈又把 8000 上的实例收掉 → `web-info` 悬空在死端口，
// 记忆页 iframe 报「拒绝连接 127.0.0.1」）。三条修法各自锁一遍：
//   ① `looksLikeOurWeb`：宽松识别「自家的 web 但严格探针认不出」的占用者；
//   ② `ensureWebServer`：疑似自家占用者时**先等自愈接管**，不立刻漂端口；
//   ③ 宿主 /web-info 实时收敛 + 记忆库页走 host 同源壳（iframe 与端口解耦）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { looksLikeOurWeb, ensureWebServer } from '../lib/web.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(path.join(root, p), 'utf8')
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.on('error', reject)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})
const serve = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler)
  s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }))
})

test('looksLikeOurWeb：认得出「自家但不自报版本」的实例，认不出别人', async () => {
  const ours = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // 旧版/半启动：有 ok:true，但没有 vaultDir（严格探针会判否 —— 这正是 #29 的现场）
    res.end(JSON.stringify({ ok: true, total: 3 }))
  })
  const foreign = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ hello: 'not-dsh' }))
  })
  const missing = await serve((req, res) => { res.writeHead(404); res.end('nope') })
  try {
    assert.equal(await looksLikeOurWeb(ours.port), true, '自家实例（即使不自报版本）要认得出来')
    assert.equal(await looksLikeOurWeb(foreign.port), false, '别人的服务不能被误认成自家')
    assert.equal(await looksLikeOurWeb(missing.port), false, '404 的服务不是自家')
    assert.equal(await looksLikeOurWeb(await freePort(), 300), false, '没人听 → false')
  } finally { ours.server.close(); foreign.server.close(); missing.server.close() }
})

test('ensureWebServer：自家旧实例占着端口时先等自愈接管，不立刻漂到 port+1（#29 主症状）', async () => {
  let strict = false
  const fake = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // 阶段一：像旧实例 —— 只回 {ok:true}，严格探针认不出（vaultDir 缺失）；
    // 阶段二（自愈接管完成）：开始自报版本与 vaultDir。
    res.end(JSON.stringify(strict ? { ok: true, vaultDir: 'C:/tmp/vault', version: '9.9.9' } : { ok: true }))
  })
  setTimeout(() => { strict = true }, 700)
  try {
    const info = await ensureWebServer({ port: fake.port, vaultRoot: path.join(os.tmpdir(), 'mc-issue29-vault'), takeoverWaitMs: 6000 })
    assert.equal(info.port, fake.port, '要停在被自愈接管后的那个端口，而不是漂到 ' + (fake.port + 1))
    assert.equal(info.spawned, false, '自愈会拉起实例，宿主不该另起一个')
  } finally { fake.server.close() }
})

test('宿主侧：/web-info 实时收敛 + 记忆库页走同源壳（源码守卫）', () => {
  const index = read('index.js')
  assert.match(index, /const reconcileWebInfo = async \(\) =>/, '要有实时收敛函数')
  assert.match(index, /return json\(res, 200, \{ ok: true, \.\.\.\(await reconcileWebInfo\(\)\) \}\)/, 'web-info 必须实时探测后再回报')
  assert.match(index, /API_PREFIX \+ '\/ui\/app'/, '要有 host 同源 UI 路由 /ui/app')
  assert.match(index, /if \(out\.ok\) refreshWebInfo\(\{ url: `http:\/\/127\.0\.0\.1:\$\{wdPort\}`/, '自愈替换成功后要收敛 web-info')
  assert.match(index, /首轮 ensure 可能漂到过别的端口/, 'interval 保活时活着也要回写记录（否则首轮漂移无人校正）')
  const web = read('lib/web.js')
  assert.match(web, /export async function looksLikeOurWeb\(/, '要有宽松识别')
  assert.match(web, /if \(await looksLikeOurWeb\(p\)\) \{/, 'ensureWebServer 要在漂移前先识别自家占用者')
  assert.match(web, /await waitForOurWeb\(p, takeoverWaitMs\)/, '要给自愈留接管窗口')
  const watchdog = read('lib/watchdog.js')
  assert.match(watchdog, /一次探针打空（实例正忙 \/ GC \/ 冷启动）\*\*不能\*\*当成/, '体检要退避重试后再判「不自报版本」')
})

test('客户端：iframe 走同源壳，只有旧宿主才回落常驻实例地址（源码守卫）', () => {
  const client = read('src/client/index.tsx')
  assert.match(client, /useState\(API \+ '\/ui\/app'\)/, 'iframe 默认地址应是同源壳')
  assert.match(client, /fetch\(API \+ '\/ui\/app', \{ method: 'HEAD' \}\)/, '要先探同源壳是否可用')
  assert.match(client, /const fallback = \(\) => fetch\('\/memory-eternal\/api\/web-info'\)/, '旧宿主（404）才回落 web-info')
  assert.match(client, /root\.endsWith\('\/ui\/app'\) \? '\?' : '\/\?'/, '同源壳与独立实例的 ?tab= 拼接都要正确')
})
