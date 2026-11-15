// 云端管理面（审计 S2）+ 密钥台账并发（审计 H4）。
//
// S2 的旧行为：未配 `MEMORY_CLOUD_ADMIN_TOKEN` 时，`isLoopback` 把**整个 RFC1918**
// 都当"本机回环"。真实部署（Docker 网桥 172.17.x、K8s Pod 10.x、同机房 VPC、办公室局域网
// 192.168.x）里 `remoteAddress` 正是这些地址 —— 同网段任何人 `POST /cloud/keys {"owner":"受害者"}`
// 就能自签密钥，进而拿下对方全部记忆。
//
// H4 的旧行为：台账是「读 → 改 → 整份写回」，`tmp` 名只带 pid；且 `resolveTenant` **每个请求**
// 都回写 `lastUsedAt` —— 并发时旧快照会把刚写进去的「吊销」覆盖回来（密钥复活）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCloudServer } from '../lib/cloud-server.js'
import { issueKey, resolveTenant, listKeys, revokeKey, mutateStore, keyStorePath } from '../lib/cloud-auth.js'
import { ensureVault, writeCard } from '../lib/vault.js'
import { DB_FILE } from '../lib/db.js'

const homes = []
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-ascope-'))
  homes.push(home)
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  return home
}
after(() => {
  for (const h of homes) { try { fs.rmSync(h, { recursive: true, force: true }) } catch { /* 忽略 */ } }
})

/** 造一个最小 req/res，跑一遍云端 handler，返回 {status, body}。 */
function invoke(handler, { method = 'GET', sub = '/cloud/keys', headers = {}, remoteAddress = '203.0.113.9', body = '' } = {}) {
  return new Promise((resolve) => {
    const chunks = []
    const req = {
      method,
      url: '/memory-eternal/api' + sub,
      headers,
      socket: { remoteAddress },
      on(evt, cb) {
        if (evt === 'data' && body) cb(Buffer.from(body))
        if (evt === 'end') cb()
        return this
      },
      destroy() {},
    }
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}) },
      setHeader() {},
      write() {},
      on() {},
      end(chunk) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = text
        try { parsed = JSON.parse(text) } catch { /* 原文 */ }
        resolve({ status: this.statusCode, body: parsed, headers: this.headers })
      },
    }
    Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 500, body: { error: String(e && e.message) } }))
  })
}

// ── S2 ──────────────────────────────────────────────────────────────────────
test('S2：未配 MEMORY_CLOUD_ADMIN_TOKEN 时，来自 10.x 的 /cloud/keys 一律 403 并指向 token', async () => {
  const home = makeHome()
  const env = { ...process.env, DSH_HOME: home }
  delete env.MEMORY_CLOUD_ADMIN_TOKEN
  const h = createCloudServer({ env })
  for (const ip of ['10.0.0.5', '10.1.2.3', '172.17.0.1', '172.31.9.9', '192.168.1.20']) {
    const r = await invoke(h, {
      method: 'POST', sub: '/cloud/keys', body: '{"owner":"attacker"}',
      headers: { 'content-type': 'application/json' }, remoteAddress: ip,
    })
    assert.equal(r.status, 403, ip + ' 必须被拒（私网不等于本机回环）')
    assert.equal(r.body.code, 'admin_required')
    assert.match(String(r.body.hint), /MEMORY_CLOUD_ADMIN_TOKEN/, '要明确告诉用户去配 token')
  }
  // 真的本机直连仍然放行（不影响运维在服务器上操作）
  const local = await invoke(h, {
    method: 'POST', sub: '/cloud/keys', body: '{"owner":"ops"}',
    headers: { 'content-type': 'application/json' }, remoteAddress: '127.0.0.1',
  })
  assert.equal(local.status, 200)
  assert.match(String(local.body.token || ''), /^me_/, '本机签发仍要能用')
})

test('S2：配了 token 后，私网来源只有带对 token 才放行', async () => {
  const home = makeHome()
  const env = { ...process.env, DSH_HOME: home, MEMORY_CLOUD_ADMIN_TOKEN: 'adm_x' }
  const h = createCloudServer({ env })
  const denied = await invoke(h, {
    method: 'POST', sub: '/cloud/keys', body: '{"owner":"x"}',
    headers: { 'content-type': 'application/json' }, remoteAddress: '10.0.0.5',
  })
  assert.equal(denied.status, 403)
  const ok = await invoke(h, {
    method: 'POST', sub: '/cloud/keys', body: '{"owner":"x"}',
    headers: { 'content-type': 'application/json', authorization: 'Bearer adm_x' }, remoteAddress: '10.0.0.5',
  })
  assert.equal(ok.status, 200, '有正确 token 时容器/反代部署仍可用')
})

test('S2：/cloud/config 与 /cloud/keys 同一条闸门（未配 token + 私网 → 403）', async () => {
  const home = makeHome()
  const env = { ...process.env, DSH_HOME: home }
  delete env.MEMORY_CLOUD_ADMIN_TOKEN
  const h = createCloudServer({ env })
  const r = await invoke(h, { sub: '/cloud/config', remoteAddress: '192.168.0.9' })
  assert.equal(r.status, 403)
  assert.equal(r.body.code, 'admin_required')
})

// ── H4 ──────────────────────────────────────────────────────────────────────
test('H4：并发写台账不丢更新（串行化 + 唯一 tmp 名）', async () => {
  const home = makeHome()
  const env = { ...process.env, DSH_HOME: home }
  const N = 24
  await Promise.all(Array.from({ length: N }, (_, i) =>
    mutateStore(env, (store) => {
      store.keys = [...store.keys, { id: 'k_' + i, owner: 'o' + i, hash: 'h' + i, revoked: false }]
    })))
  const keys = listKeys(env)
  assert.equal(keys.length, N, '并发 24 次写入必须全部落盘，不能被旧快照覆盖')
  const ids = new Set(keys.map((k) => k.id))
  for (let i = 0; i < N; i++) assert.ok(ids.has('k_' + i), 'k_' + i + ' 丢了')
  // tmp 文件不许残留（wx + rename 的收尾要干净）
  const leftovers = fs.readdirSync(home).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftovers, [], '临时文件必须已经 rename 走')
})

test('H4：吊销不会被在途请求"复活"（鉴权热路径不再回写整份台账）', () => {
  const home = makeHome()
  const env = { ...process.env, DSH_HOME: home }
  const a = issueKey({ owner: 'alice' }, env)
  const b = issueKey({ owner: 'bob' }, env)
  assert.equal(resolveTenant('Bearer ' + a.token, env).ok, true)
  assert.equal(resolveTenant('Bearer ' + b.token, env).ok, true)
  // bob 的密钥被吊销
  assert.equal(revokeKey(b.key.id, env).ok, true)
  assert.equal(resolveTenant('Bearer ' + b.token, env).ok, false)

  // alice 持续鉴权（旧实现每个请求都 read-modify-write 整份台账）
  for (let i = 0; i < 50; i++) assert.equal(resolveTenant('Bearer ' + a.token, env).ok, true)

  const store = JSON.parse(fs.readFileSync(keyStorePath(env), 'utf8'))
  const bob = store.keys.find((k) => k.id === b.key.id)
  assert.equal(bob.revoked, true, '吊销结果不许被后续鉴权写回旧快照覆盖（密钥复活）')
  assert.equal(resolveTenant('Bearer ' + b.token, env).ok, false, '吊销必须一直有效')
})

test('H4：lastUsedAt 每租户最多 60s 落盘一次（不是每个请求都写盘）', async () => {
  const home = makeHome()
  const env = { ...process.env, DSH_HOME: home }
  const k = issueKey({ owner: 'carol' }, env)
  const file = keyStorePath(env)
  // 第一次鉴权会打一次时间戳（本来就没写过）
  assert.equal(resolveTenant('Bearer ' + k.token, env).ok, true)
  const before = fs.statSync(file).mtimeMs
  const snapshot = fs.readFileSync(file, 'utf8')
  await new Promise((r) => setTimeout(r, 20))
  for (let i = 0; i < 30; i++) assert.equal(resolveTenant('Bearer ' + k.token, env).ok, true)
  const after = fs.statSync(file).mtimeMs
  assert.equal(after, before, '60s 内的后续鉴权不许再写盘（热路径同步 IO 会拖慢每个请求）')
  assert.equal(fs.readFileSync(file, 'utf8'), snapshot, '台账内容也不该被重写')
  assert.match(JSON.parse(snapshot).keys[0].lastUsedAt, /^\d{4}-\d{2}-\d{2}T/, '首次鉴权要记下 lastUsedAt')
})

test('H4：写盘失败不影响鉴权（lastUsedAt 只是运维观测字段）', () => {
  const home = makeHome()
  const env = { ...process.env, DSH_HOME: home }
  const k = issueKey({ owner: 'dave' }, env)
  const file = keyStorePath(env)
  // 文件**可读但不可替换**：chmod 只读 → rename 覆盖会 EPERM/EACCES（Windows 上就是只读属性）。
  // 这样「读得到密钥、写不进账" 的场景就能稳定复现。
  try { fs.chmodSync(file, 0o444) } catch { /* 某些文件系统不支持，下面的断言仍然成立 */ }
  try {
    const r = resolveTenant('Bearer ' + k.token, env)
    assert.equal(r.ok, true, '台账写不进去也必须能鉴权通过')
    assert.equal(r.owner, 'dave')
  } finally {
    try { fs.chmodSync(file, 0o644) } catch { /* 忽略 */ }
  }
})

// ── S1 端到端：真跑一遍 cloud-server，租户 A 读不到租户 B 的库 ────────────────
test('S1 端到端：cloud-server 注入的作用域让"别人的租户目录"403（不是靠路径不存在蒙的）', async () => {
  const home = makeHome()
  const env = { ...process.env, DSH_HOME: home }
  delete env.MEMORY_CLOUD_ADMIN_TOKEN
  // 造一个**真实存在**的受害者库（有 .db、有卡片）：如果少了作用域闸门，导出会 200
  const victimDir = path.join(home, 'cloud-vaults', 'victim')
  await ensureVault(victimDir)
  await writeCard(victimDir, {
    kind: 'knowledge',
    title: '受害者的私房卡',
    tags: ['x'],
    body: '这张卡只属于 victim 租户，attacker 一个字节都不该看到。正文要够长以便正常写库。',
    status: 'approved',
  }, { dedup: false })
  assert.equal(fs.existsSync(path.join(victimDir, DB_FILE)), true)

  const h = createCloudServer({ env })
  // attacker 自己的库也真的建出来（证明「能导出自己的」不是靠空库蒙的）
  const attackerDir = path.join(home, 'cloud-vaults', 'attacker')
  await ensureVault(attackerDir)
  await writeCard(attackerDir, {
    kind: 'knowledge',
    title: 'attacker 自己的卡',
    tags: ['y'],
    body: '这是 attacker 自己的记忆，导出自己的库必须照常可用。正文要够长以便正常写库。',
    status: 'approved',
  }, { dedup: false })
  // 本机管理员给 attacker 签一把密钥
  const issued = await invoke(h, {
    method: 'POST', sub: '/cloud/keys', body: '{"owner":"attacker"}',
    headers: { 'content-type': 'application/json' }, remoteAddress: '127.0.0.1',
  })
  assert.equal(issued.status, 200)
  const token = issued.body.token
  assert.match(String(token || ''), /^me_/)

  // attacker 用这把合法密钥去读 victim 的库
  const evil = await invoke(h, {
    sub: '/vaults/export?path=' + encodeURIComponent(victimDir),
    headers: { authorization: 'Bearer ' + token }, remoteAddress: '203.0.113.50',
  })
  assert.equal(evil.status, 403, '跨租户导出必须 403：' + JSON.stringify(evil.body))
  assert.equal(evil.body.error, 'path-not-allowed')
  assert.doesNotMatch(JSON.stringify(evil.body), /私房卡/, '拒绝时不许漏卡片内容')

  // attacker 自己的库仍然能正常导出（不是把所有导出都关了）
  const own = await invoke(h, {
    sub: '/vaults/export',
    headers: { authorization: 'Bearer ' + token }, remoteAddress: '203.0.113.50',
  })
  assert.equal(own.status, 200, '自己的库要能导出：' + JSON.stringify(own.body))
  assert.equal(own.body.ok, true)
})
