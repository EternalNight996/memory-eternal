// 云端租户实例的**热切库**（不重启进程、不刷新页面）。
//
// 背景：云端多租户实例（MEMORY_CLOUD=1 → lib/cloud-server.js）原来没给 createApi 注入
// switchVault，于是 `POST /vaults/switch` 走 api.js 的降级分支返回 `hot:false`
// （「已记录，重启后生效」）。一个租户有多个库（/vaults/create 建的命名库）时体验很差。
//
// 这里用**真 handler**（createCloudServer）跑，而不是读源码断言。守七件事：
//   ① 默认 activeRoot = tenantRoot（租户根）；
//   ② 建子库后 switch → hot:true（真的热切了，不是"重启后生效"）；
//   ③ 切完**紧接着**下一次请求读到的就是新库的内容（子库独有卡）；
//   ④ 切到**别的租户**的库 → 403 path-not-allowed（不削弱 S1 隔离）；
//   ⑤ 切到租户根内**不是记忆库**的目录 → 失败，且**不创建任何文件**（审计 H6）；
//   ⑥ 重启（同 DSH_HOME 新实例）→ 仍在切过去的库（.active 生效）；
//   ⑦ 坏 `.active`（越界 / 指向非库目录）→ 回落默认库，不报错、不把租户卡死。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCloudServer } from '../lib/cloud-server.js'
import { ensureVault, writeCard } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'

const DB = 'memory-eternal.db'

/** 临时 DSH_HOME（云端的租户目录就从这里派生：<home>/cloud-vaults/<owner>）。 */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-hot-'))
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  // 给 alice 一份**付费租户** entitlement：免费档 caps.vaults=1，建子库会被 403 quota_exceeded
  // 挡住，就测不了多库/热切（这不是本次改动的缺陷，是套餐配额在正常工作）。
  fs.writeFileSync(path.join(home, 'cloud-entitlement-alice.json'), JSON.stringify({
    owner: 'alice', plan: 'pro', status: 'active', expiresAt: null, version: 10,
    caps: { vaults: 5, cards: 5000, rpm: 300 }, fetchedAt: new Date().toISOString(), source: 'mengbot',
  }, null, 2), { mode: 0o600 })
  return home
}

const req = async (base, sub, { token = '', method = 'GET', body = null } = {}) => {
  const headers = {}
  if (token) headers.Authorization = 'Bearer ' + token
  if (body !== null) headers['Content-Type'] = 'application/json'
  const r = await fetch(base + sub, { method, headers, ...(body !== null ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

/**
 * 起一个云端实例（真 createCloudServer + 真 HTTP），并给 alice 签一把密钥。
 * 每次调用都是**新 handler**（同 home 再调一次 = 模拟进程重启）。
 */
async function boot(home) {
  process.env.DSH_HOME = home            // api.js 的 /vaults/create 读 process.env.DSH_HOME
  const env = { ...process.env, DSH_HOME: home, MEMORY_QUOTA_RPM: '99999' }
  delete env.MEMORY_CLOUD_ADMIN_TOKEN    // 走「仅本机回环可签密钥」那条闸
  const handler = createCloudServer({ env })
  const srv = http.createServer((q, r) => { handler(q, r).catch(() => {}) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}/memory-eternal/api`
  const issued = await req(base, '/cloud/keys', { method: 'POST', body: { owner: 'alice' } })
  assert.equal(issued.status, 200, '签密钥应成功：' + JSON.stringify(issued.body))
  return {
    base,
    token: issued.body.token,
    call: (sub, opt = {}) => req(base, sub, { token: issued.body.token, ...opt }),
    async close() { await new Promise((r) => srv.close(r)) },
  }
}

/** 每个用例的完整环境：临时 home + 云端实例；结束时关库、删目录。 */
async function withCloud(fn) {
  const home = makeHome()
  const tenantRoot = path.join(path.resolve(home), 'cloud-vaults', 'alice')
  const srv = await boot(home)
  try {
    await fn({ home, tenantRoot, ...srv, namedWorkRoot: path.join(tenantRoot, 'vaults', 'work') })
  } finally {
    await srv.close()
    await new Promise((r) => setTimeout(r, 30))
    closeAllDb()                       // Windows：连接开着删目录会 EBUSY
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 句柄未关时忽略 */ }
  }
}

test('① 默认 activeRoot = tenantRoot（whoami / vaults / overview 三处一致）', () => withCloud(async (c) => {
  await ensureVault(c.tenantRoot)

  const who = await c.call('/cloud/whoami')
  assert.equal(who.status, 200)
  assert.equal(path.resolve(who.body.vaultRoot), path.resolve(c.tenantRoot), '默认应指向租户根')

  const vs = await c.call('/vaults')
  assert.equal(path.resolve(vs.body.current), path.resolve(c.tenantRoot))
  assert.equal(vs.body.hotSwitch, true, '云端实例必须声明可热切（前端据此决定提示语）')

  const ov = await c.call('/overview')
  assert.equal(ov.status, 200)
  assert.equal(path.resolve(ov.body.vaultDir), path.resolve(c.tenantRoot))
  assert.equal(path.resolve(ov.body.dbPath), path.join(path.resolve(c.tenantRoot), DB))
}))

/** 建子库 + 往子库里放一张默认库没有的卡；返回子库路径。 */
async function seedWorkVault(c) {
  await ensureVault(c.tenantRoot)                       // 默认库
  const created = await c.call('/vaults/create', { method: 'POST', body: { name: 'work' } })
  assert.equal(created.status, 200, '建子库应成功：' + JSON.stringify(created.body))
  assert.equal(created.body.created, true)
  assert.equal(path.resolve(created.body.root), path.resolve(c.namedWorkRoot))
  // 子库放一张默认库里没有的卡（用来断言"真的读的是新库"，而不是空库碰巧没卡）
  await writeCard(c.namedWorkRoot, {
    kind: 'knowledge', title: '子库独有卡', tags: ['hot'],
    body: '这张卡只存在于 alice 的 work 子库，切过去之后必须能读到它。正文要够长以便正常写库。',
    status: 'approved',
  }, { dedup: false })
}

test('② 建子库后 switch 返回 hot:true（真的热切，不是"重启后生效"）', () => withCloud(async (c) => {
  await seedWorkVault(c)

  const before = await c.call('/cards?status=all')
  assert.equal(before.body.total, 0, '切库前默认库里不该有这张卡')

  const sw = await c.call('/vaults/switch', { method: 'POST', body: { path: c.namedWorkRoot } })
  assert.equal(sw.status, 200, 'switch 应成功：' + JSON.stringify(sw.body))
  assert.equal(sw.body.ok, true)
  assert.equal(sw.body.hot, true, '云端实例内的热切必须真的生效（此前这里是 hot:false）')
  assert.equal(path.resolve(sw.body.root), path.resolve(c.namedWorkRoot))
  assert.equal(sw.body.isCurrent, false, 'isCurrent 表示"是不是默认库"')
  assert.match(String(sw.body.prefFile || ''), /\.active$/, '要落 .active 标记（重启后仍然生效）')
}))

test('③ 切完紧接着的下一次请求就读到新库的内容，切回默认库同样立即生效', () => withCloud(async (c) => {
  await seedWorkVault(c)
  const sw = await c.call('/vaults/switch', { method: 'POST', body: { path: c.namedWorkRoot } })
  assert.equal(sw.body.hot, true, '前置：热切应成功')

  const cards = await c.call('/cards?status=all')
  assert.equal(cards.status, 200)
  assert.ok(cards.body.total >= 1, '切完立刻要能看到子库里的卡：' + JSON.stringify(cards.body).slice(0, 300))
  assert.ok(cards.body.cards.some((x) => x.title === '子库独有卡'), '要读到子库独有的那张卡')

  const ov = await c.call('/overview')
  assert.equal(path.resolve(ov.body.vaultDir), path.resolve(c.namedWorkRoot), 'overview 要显示当前库')
  assert.equal(path.resolve(ov.body.dbPath), path.join(path.resolve(c.namedWorkRoot), DB))

  const who = await c.call('/cloud/whoami')
  assert.equal(path.resolve(who.body.vaultRoot), path.resolve(c.namedWorkRoot), 'whoami 不能让面板显示旧库')

  // 切到子库之后，/vaults 仍要列出本租户的**所有**库（否则用户点不回默认库）
  const vs = await c.call('/vaults')
  const byPath = new Map(vs.body.vaults.map((v) => [path.resolve(v.path), v]))
  assert.ok(byPath.has(path.resolve(c.tenantRoot)), '默认库必须还在列表里：' + [...byPath.keys()].join(','))
  assert.ok(byPath.has(path.resolve(c.namedWorkRoot)), '子库必须在列表里')
  assert.equal(byPath.get(path.resolve(c.namedWorkRoot)).isCurrent, true, '当前库要标 isCurrent')

  // 再切回默认库：同样立即生效
  const back = await c.call('/vaults/switch', { method: 'POST', body: { path: c.tenantRoot } })
  assert.equal(back.status, 200)
  assert.equal(back.body.hot, true)
  assert.equal(back.body.isCurrent, true)
  const backCards = await c.call('/cards?status=all')
  assert.equal(backCards.body.total, 0, '切回默认库后不该再看到子库的卡')
}))

test('④ 切到别的租户的库 → 403 path-not-allowed（S1 隔离不被削弱）', () => withCloud(async (c) => {
  await ensureVault(c.tenantRoot)
  const bobRoot = path.join(path.resolve(c.home), 'cloud-vaults', 'bob')
  await ensureVault(bobRoot)
  assert.equal(fs.existsSync(path.join(bobRoot, DB)), true, '受害者库要真实存在（不是靠路径不存在蒙的）')

  const r = await c.call('/vaults/switch', { method: 'POST', body: { path: bobRoot } })
  assert.equal(r.status, 403, '跨租户必须 403：' + JSON.stringify(r.body))
  assert.equal(r.body.error, 'path-not-allowed')

  // 顺手确认没有"切过去一半"：仍在默认库，且没写 .active
  const who = await c.call('/cloud/whoami')
  assert.equal(path.resolve(who.body.vaultRoot), path.resolve(c.tenantRoot))
  assert.equal(fs.existsSync(path.join(c.tenantRoot, '.active')), false, '被拒绝的切换不该留下标记')
}))

test('⑤ 切到租户根内「不是记忆库」的目录 → 失败，且不创建任何文件（H6）', () => withCloud(async (c) => {
  await ensureVault(c.tenantRoot)
  const emptyDir = path.join(c.tenantRoot, 'not-a-vault')
  fs.mkdirSync(emptyDir, { recursive: true })
  const before = fs.readdirSync(emptyDir)

  const r = await c.call('/vaults/switch', { method: 'POST', body: { path: emptyDir } })
  assert.ok(r.status >= 400, '不是记忆库必须失败：' + JSON.stringify(r.body))
  assert.equal(r.body.ok, false)

  assert.deepEqual(fs.readdirSync(emptyDir), before, '拒绝时**不许**在目标目录里建任何文件（绝不 ensureVault）')
  assert.equal(fs.existsSync(path.join(emptyDir, DB)), false)
  assert.equal(fs.existsSync(path.join(c.tenantRoot, '.active')), false, '失败不该写 .active')
  const who = await c.call('/cloud/whoami')
  assert.equal(path.resolve(who.body.vaultRoot), path.resolve(c.tenantRoot), '失败后仍在原库')
}))

test('⑥ 重启（同 DSH_HOME 新实例）→ 默认就在上次切到的库', async () => {
  const home = makeHome()
  const tenantRoot = path.join(path.resolve(home), 'cloud-vaults', 'alice')
  const workRoot = path.join(tenantRoot, 'vaults', 'work')
  try {
    await ensureVault(tenantRoot)
    await ensureVault(workRoot)
    await writeCard(workRoot, {
      kind: 'knowledge', title: '重启后仍在的卡', tags: ['hot'],
      body: '切库后进程重启，默认库应该还是 work —— 靠 cloud-vaults/<owner>/.active 记住选择。正文够长。',
      status: 'approved',
    }, { dedup: false })

    const a = await boot(home)
    const sw = await a.call('/vaults/switch', { method: 'POST', body: { path: workRoot } })
    assert.equal(sw.body.hot, true, '热切应成功：' + JSON.stringify(sw.body))
    const marker = path.join(tenantRoot, '.active')
    assert.equal(fs.existsSync(marker), true, '要落 .active')
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'vaults/work', '.active 内容是一行相对租户根的路径')
    await a.close()

    // 新实例（同 home）＝进程重启
    const b = await boot(home)
    try {
      const who = await b.call('/cloud/whoami')
      assert.equal(path.resolve(who.body.vaultRoot), path.resolve(workRoot), '重启后默认仍应是上次切到的库')
      const cards = await b.call('/cards?status=all')
      assert.ok(cards.body.cards.some((x) => x.title === '重启后仍在的卡'), '重启后直接读到 work 库的内容')
    } finally { await b.close() }
  } finally {
    await new Promise((r) => setTimeout(r, 30))
    closeAllDb()
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

test('⑦ 坏 .active（越界 / 指向非库目录）→ 回落默认库且不报错', async () => {
  const home = makeHome()
  const tenantRoot = path.join(path.resolve(home), 'cloud-vaults', 'alice')
  const marker = path.join(tenantRoot, '.active')
  try {
    await ensureVault(tenantRoot)
    // 越界标记：指向别人的租户目录（存在、也是库）—— 也必须被忽略
    await ensureVault(path.join(path.resolve(home), 'cloud-vaults', 'bob'))

    fs.writeFileSync(marker, '../../bob\n', { mode: 0o600 })
    const a = await boot(home)
    try {
      const who = await a.call('/cloud/whoami')
      assert.equal(path.resolve(who.body.vaultRoot), path.resolve(tenantRoot), '越界标记必须被忽略')
      const ov = await a.call('/overview')
      assert.equal(ov.status, 200, '坏标记不该让面板报错：' + JSON.stringify(ov.body).slice(0, 200))
      assert.equal(path.resolve(ov.body.vaultDir), path.resolve(tenantRoot))
    } finally { await a.close() }

    // 指向「租户根内但不是记忆库」的目录 → 同样回落
    const emptyDir = path.join(tenantRoot, 'empty')
    fs.mkdirSync(emptyDir, { recursive: true })
    fs.writeFileSync(marker, 'empty\n', { mode: 0o600 })
    const b = await boot(home)
    try {
      const who = await b.call('/cloud/whoami')
      assert.equal(path.resolve(who.body.vaultRoot), path.resolve(tenantRoot), '非库目录的标记必须被忽略')
      // 也不该在坏标记指向的目录里建出任何东西
      assert.deepEqual(fs.readdirSync(emptyDir), [], '读标记的过程绝不能 mkdir/建库')
    } finally { await b.close() }
  } finally {
    await new Promise((r) => setTimeout(r, 30))
    closeAllDb()
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})
