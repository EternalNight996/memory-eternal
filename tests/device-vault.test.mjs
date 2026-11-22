// 多设备云端：每台设备一份激活库（`.active.<deviceId>`）。
//
// 回归背景（2026-11-23 复盘）：服务端 351c9ef 已按 `X-Device-Id` 各存一份，但客户端从头到尾
// **没发过这个头** —— 两台设备实际共用全局 `.active`，切库照样互相覆盖（就是那个 bug 的原始现象）。
// 这里同时盯两件事：
//   ① 服务端行为：A 切库不影响 B；无 device 的请求读全局兜底快照；标记文件落盘。
//   ② 客户端源码：fetch 包装必须真的把 `X-Device-Id` 发出去（防再次漏接线）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCloudServer } from '../lib/cloud-server.js'
import crypto from 'node:crypto'

const WEBHOOK_SECRET = 'whsec_dev_multi'
const sign = (body) => 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body, 'utf8').digest('hex')

async function withCloud(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-dev-'))
  // /vaults 与 /vaults/create 读的是 process.env.DSH_HOME（生产 = 服务进程 env），
  // 只把 DSH_HOME 塞给 createCloudServer({env}) 不够 —— 这里按真实部署形态设置进程 env。
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  const handler = createCloudServer({
    env: {
      ...process.env,
      DSH_HOME: home,
      MEMORY_CLOUD_PUBLIC_URL: 'http://127.0.0.1',
      MEMORY_CLOUD_ACCESS_LOG: '0',
      MEMORY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    },
  })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/memory-eternal/api`
  try {
    await fn(base, home)
  } finally {
    await new Promise((r) => srv.close(r))
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
}

async function call(base, p, { method = 'GET', body, token, device } = {}) {
  const headers = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (device) headers['X-Device-Id'] = device
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const r = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

test('两台设备各切各的库，互不覆盖；无 device 的请求读全局兜底', async () => {
  await withCloud(async (base, home) => {
    const kj = await call(base, '/cloud/keys', { method: 'POST', body: { owner: 'dev@example.com' } })
    assert.equal(kj.body.ok, true, JSON.stringify(kj.body))
    const token = kj.body.token
    assert.ok(token, '要拿到租户令牌')

    // 初始化租户库（首次访问会建库）
    const init = await call(base, '/overview', { token, device: 'devA' })
    assert.equal(init.status, 200, '租户库应可用：' + JSON.stringify(init.body).slice(0, 160))
    const defaultRoot = init.body.vaultDir
    assert.ok(defaultRoot, 'overview 要返回当前库路径')

    // 免费档默认只读（订阅过期策略）—— 推一条 entitlement 让租户拿到可写套餐
    const payload = JSON.stringify({
      id: 'evt_dev_1', event: 'entitlement.updated', account: 'dev@example.com',
      plan: 'pro', status: 'active', version: 1,
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      caps: { cards: 100000, rpm: 300, vaults: 5 },
    })
    const wh = await fetch(base + '/cloud/webhook/mengbot', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MengBot-Signature': sign(payload),
        'X-MengBot-Event': 'entitlement.updated',
        'X-MengBot-Event-Id': 'evt_dev_1',
      },
      body: payload,
    })
    assert.equal(wh.status, 200)

    // 建一个命名库 v2
    const v2 = await call(base, '/vaults/create', { method: 'POST', body: { name: 'v2' }, token, device: 'devA' })
    assert.equal(v2.body.ok, true, JSON.stringify(v2.body))
    const v2root = v2.body.root
    assert.ok(v2root, '创建库要返回 root')

    // A 切到 v2。注意：写入时同时刷全局 `.active` 作为兜底快照 ——
    // 所以「还没自己选过库」的新设备会跟随最近一次切换（这是设计约定，不是 bug）。
    const sw = await call(base, '/vaults/switch', { method: 'POST', body: { path: v2root }, token, device: 'devA' })
    assert.equal(sw.body.ok, true, JSON.stringify(sw.body))
    const inherit = await call(base, '/overview', { token, device: 'devB' })
    assert.equal(inherit.body.vaultDir, v2root, '没选过库的新设备跟随全局兜底快照')

    // B 自己选回默认库之后，两台设备各自独立，互不覆盖（原 bug 的场景）
    const swB = await call(base, '/vaults/switch', { method: 'POST', body: { path: defaultRoot }, token, device: 'devB' })
    assert.equal(swB.body.ok, true, JSON.stringify(swB.body))

    const ca = await call(base, '/overview', { token, device: 'devA' })
    const cb = await call(base, '/overview', { token, device: 'devB' })
    const c0 = await call(base, '/overview', { token })
    assert.equal(ca.body.vaultDir, v2root, 'A 应保持自己选的库，不被 B 的切换影响')
    assert.equal(cb.body.vaultDir, defaultRoot, 'B 应保持自己选的库，不被 A 的切换影响（原 bug）')
    assert.equal(c0.body.vaultDir, defaultRoot, '无 device 的请求读全局兜底快照（最后一次切换）')

    // 标记文件落盘：A 有专属标记，全局兜底也在
    const marks = []
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.active(\.[A-Za-z0-9._-]+)?$/.test(e.name)) marks.push(p)
      }
    }
    walk(home)
    assert.ok(marks.some((p) => path.basename(p) === '.active.devA'), '要写设备 A 的专属标记：' + marks.join(','))
    assert.ok(marks.some((p) => path.basename(p) === '.active'), '全局兜底标记也要写')
  })
})

test('源码守卫：云端熔断回退只重载一次（防 401 无限刷新）', () => {
  const src = fs.readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  // 没有闸门时：重载 → 探活又失败 → 再发事件 → 再重载，页面一直闪。
  assert.match(src, /me-cloud-fallback-reload/, '要有一次性重载标记')
  assert.match(src, /if \(already\) return/, '已经重载过就不再重载')
  assert.match(src, /removeItem\('me-cloud-fallback-reload'\)/, '云端恢复后要清标，下次真失败还能重载一次')
})

test('源码守卫：客户端必须真的把 X-Device-Id 发出去', () => {
  const src = fs.readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.match(src, /const DEVICE_ID = \(function/, '要有设备标识（localStorage 持久化）')
  assert.match(src, /me-device-id/, '设备标识要落 localStorage')
  assert.match(src, /headers\['X-Device-Id'\] = DEVICE_ID/, 'fetch 包装必须注入 X-Device-Id（只做服务端等于没修）')
  // 相对路径改写和「绝对地址的 cloudApi 调用」两条路都要覆盖：
  // 云端切库走的是 fetch(cloudApi('/vaults/switch'))，只改相对路径的拦截器管不到它。
  assert.match(src, /new URL\(input\)\.origin === origin/, '绝对地址的云端调用也要带设备头')
})
