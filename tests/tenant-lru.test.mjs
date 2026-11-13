// 租户实例 LRU：`tenants` 表**不能只增不减**。
//
// 每个 handler 背后是一套 SQLite 连接（db.js 按库路径缓存实例）。
// 只增不减 → 租户越多，打开的库句柄越多，几百个租户就把文件句柄吃干
// （Linux 默认 ulimit -n 1024），进程随后到处 EMFILE。
//
// 守五件事：
//   ① 驻留实例数不超过 MEMORY_TENANT_LRU（默认 32）；
//   ② 命中的租户被提升到队尾（真正的 LRU，不是 FIFO）；
//   ③ 淘汰后该租户**仍能正常访问**（重建实例，不是永久坏掉）；
//   ④ 淘汰时关掉 SQLite 连接（否则换张表而已，句柄照样漏）；
//   ⑤ /cloud/health 暴露 tenants{active,max} 便于运维观察。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createCloudServer } from '../lib/cloud-server.js'

const src = fs.readFileSync('lib/cloud-server.js', 'utf8')

function withServer(env, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-lru-'))
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  const handler = createCloudServer({ env: { ...process.env, ...env, DSH_HOME: home, MEMORY_QUOTA_RPM: '99999' } })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', async () => {
      try { await fn(`http://127.0.0.1:${srv.address().port}`) } finally { srv.close(); resolve() }
    })
  })
}

async function issueToken(base, owner) {
  const r = await fetch(base + '/memory-eternal/api/cloud/keys', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner }),
  })
  const j = await r.json()
  assert.equal(j.ok, true, '签 token 应成功: ' + JSON.stringify(j))
  return j.token
}

async function hit(base, token) {
  return fetch(base + '/memory-eternal/api/overview', { headers: { Authorization: 'Bearer ' + token } })
}

async function stats(base) {
  const r = await fetch(base + '/memory-eternal/api/cloud/health')
  return (await r.json()).tenants
}

test('源码层面：有淘汰逻辑与 closeDb 调用', () => {
  assert.match(src, /MAX_TENANTS/, '要有上限常量')
  assert.match(src, /function evictTenant\(/, '要有淘汰函数')
  assert.match(src, /closeDb\(rec\.vaultRoot\)/, '淘汰时必须关连接')
  assert.match(src, /import \{ closeDb \} from '\.\/db\.js'/, '要静态 import closeDb（异步关会留窗口）')
  assert.match(src, /tenants\.delete\(owner\)[\s\S]{0,80}tenants\.set\(owner, hit\)/, '命中要提升到队尾')
})

test('驻留实例数不超过上限', () => withServer({ MEMORY_TENANT_LRU: '3' }, async (base) => {
  const init = await stats(base)
  assert.equal(init.max, 3)
  assert.equal(init.active, 0)
  for (const o of ['u1', 'u2', 'u3', 'u4', 'u5']) {
    const tok = await issueToken(base, o)
    const r = await hit(base, tok)
    assert.equal(r.status, 200, o + ' 应可访问')
    const s = await stats(base)
    assert.ok(s.active <= 3, `实例数 ${s.active} 不该超过 3`)
  }
  const fin = await stats(base)
  assert.equal(fin.active, 3, '最终应恰好驻留 3 个')
}))

test('命中会被提升（LRU 而不是 FIFO）', () => withServer({ MEMORY_TENANT_LRU: '2' }, async (base) => {
  const t1 = await issueToken(base, 'a')
  const t2 = await issueToken(base, 'b')
  await hit(base, t1)
  await hit(base, t2)          // 顺序: a, b
  await hit(base, t1)          // 提升 a: b, a
  const t3 = await issueToken(base, 'c')
  await hit(base, t3)          // 淘汰 b（最久未用），剩 a, c
  // a 应该还在（若实现是 FIFO 会把 a 淘汰）
  const ra = await hit(base, t1)
  assert.equal(ra.status, 200, 'a 刚被访问过，不该被淘汰')
  const s = await stats(base)
  assert.equal(s.active, 2)
}))

test('被淘汰的租户再访问仍可用（重建实例）', () => withServer({ MEMORY_TENANT_LRU: '1' }, async (base) => {
  const ta = await issueToken(base, 'x')
  const tb = await issueToken(base, 'y')
  await hit(base, ta)          // 驻留 x
  await hit(base, tb)          // 淘汰 x，驻留 y
  const again = await hit(base, ta)   // x 重建
  assert.equal(again.status, 200, '淘汰后重建应正常，不是永久坏掉')
  const s = await stats(base)
  assert.equal(s.active, 1, '重建后仍只驻留 1 个')
}))

test('默认上限 32（未配置 MEMORY_TENANT_LRU 时）', () => withServer({}, async (base) => {
  const s = await stats(base)
  assert.equal(s.max, 32, '默认应为 32')
}))

test('非法 MEMORY_TENANT_LRU 回落默认（不会变成 0 把所有人都淘汰）', () => withServer({ MEMORY_TENANT_LRU: 'abc' }, async (base) => {
  const s = await stats(base)
  assert.equal(s.max, 32, '非法值应回落默认 32')
}))
