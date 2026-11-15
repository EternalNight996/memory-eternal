// 运行中热切库（vault switch）+ 云端库切换的服务端契约。
//
// 用户的两条硬要求在这里落成可断言的行为：
//   ① 「切换库不用重启客户端」—— /vaults/switch 之后同一个进程的 /overview 必须报新库；
//   ② 没注入热切换的形态（宿主 / 老实现）不许报错，要回落成「写偏好 + 重启生效」并如实回报 hot:false。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApi, API_PREFIX } from '../lib/api.js'
import { ensureVault, writeCard } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'
import { startWebServer } from '../lib/web.js'
import { readActiveVault, writeActiveVault } from '../lib/vault-pref.js'
import { pickSpawnVault } from '../lib/watchdog.js'
import { resolveVaultDir } from '../lib/vault-resolve.js'

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-switch-'))
// 偏好文件必须落在临时 DSH_HOME 里，绝不能污染开发者本机的真实选库记录
process.env.DSH_HOME = tmpHome
const vaultA = path.join(tmpHome, 'memory-vault-a')
const vaultB = path.join(tmpHome, 'memory-vault-b')

after(async () => {
  closeAllDb()
  await fs.rm(tmpHome, { recursive: true, force: true })
})

/** 极简 res 桩：够 createApi 用（writeHead / end / setHeader）。 */
function fakeRes() {
  const out = { status: 0, body: '', headers: {} }
  out.writeHead = (s, h) => { out.status = s; if (h) out.headers = { ...out.headers, ...h } }
  out.setHeader = (k, v) => { out.headers[k] = v }
  out.end = (b) => { out.body = String(b || '') }
  out.on = () => {}
  out.once = () => {}
  out.emit = () => {}
  return { res: out, out }
}

const callApi = async (api, url, { method = 'GET', body = null, headers = {} } = {}) => {
  const { res, out } = fakeRes()
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    url,
    method,
    headers: { 'content-type': 'application/json', ...headers },
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c },
  }
  await api(req, res)
  let parsed = null
  try { parsed = JSON.parse(out.body) } catch { /* 非 JSON */ }
  return { status: out.status, body: out.body, json: parsed }
}

test('未注入热切换：回落成「写偏好 + 重启生效」，绝不报不支持', async () => {
  await ensureVault(vaultA)
  await ensureVault(vaultB)
  const api = createApi({ vaultDir: () => vaultA, getSettings: () => ({}) })
  const r = await callApi(api, API_PREFIX + '/vaults/switch', { method: 'POST', body: { path: vaultB } })
  assert.equal(r.status, 200, '老形态也要 200，不能把用户卡在一个报错的按钮上')
  assert.equal(r.json.ok, true)
  assert.equal(r.json.hot, false, '如实回报：这次不是热切')
  assert.equal(r.json.needRestart, true)
  assert.equal(r.json.root, path.resolve(vaultB))
  assert.equal(readActiveVault(process.env), path.resolve(vaultB), '偏好要写下来，重启后才生效')
})

test('/vaults 回报 hotSwitch 能力位：注入 true、未注入 false', async () => {
  await ensureVault(vaultA)
  const plain = createApi({ vaultDir: () => vaultA, getSettings: () => ({}) })
  const a = await callApi(plain, API_PREFIX + '/vaults')
  assert.equal(a.json.hotSwitch, false)

  const hot = createApi({ vaultDir: () => vaultA, getSettings: () => ({}), switchVault: async () => ({ ok: true, hot: true }) })
  const b = await callApi(hot, API_PREFIX + '/vaults')
  assert.equal(b.json.hotSwitch, true)
})

test('注入后热切：目标路径原样交给 switchVault，结果原样回给前端', async () => {
  await ensureVault(vaultA)
  let seen = ''
  const api = createApi({
    vaultDir: () => vaultA,
    getSettings: () => ({}),
    switchVault: async (p) => { seen = p; return { ok: true, hot: true, root: path.resolve(p), prev: vaultA, isCurrent: true } },
  })
  const r = await callApi(api, API_PREFIX + '/vaults/switch', { method: 'POST', body: { path: vaultB } })
  assert.equal(seen, vaultB)
  assert.equal(r.status, 200)
  assert.equal(r.json.hot, true)
  assert.equal(r.json.root, path.resolve(vaultB))
})

test('switch 的边界：GET 405、空路径 400、异常变成 400 而不是 500', async () => {
  await ensureVault(vaultA)
  const api = createApi({ vaultDir: () => vaultA, getSettings: () => ({}), switchVault: async () => { throw new Error('boom') } })
  const g = await callApi(api, API_PREFIX + '/vaults/switch', { method: 'GET' })
  assert.equal(g.status, 405)
  const empty = await callApi(api, API_PREFIX + '/vaults/switch', { method: 'POST', body: {} })
  assert.equal(empty.status, 400)
  const boom = await callApi(api, API_PREFIX + '/vaults/switch', { method: 'POST', body: { path: vaultB } })
  assert.equal(boom.status, 400, '切库失败给 400 + 原因，不要 500')
  assert.match(String(boom.json && boom.json.error), /boom/)
})

test('端到端：运行中的 web server 换库后就地生效（进程没重启、数据真的换了）', async () => {
  await ensureVault(vaultA)
  await ensureVault(vaultB)
  await writeCard(vaultA, { kind: 'knowledge', title: 'A-only', tags: ['t'], body: '只在 A 库里的知识卡片，用来证明切库之后读的确实是另一个库的数据。', status: 'approved' })
  // 两张卡的内容要**明显不同**：写卡会做相似度去重，措辞相近的两张会被合并成一张（踩过一次）
  await writeCard(vaultB, { kind: 'knowledge', title: 'B-only-1', tags: ['t'], body: 'SQLite 的 WAL 模式下，读事务不会被写事务阻塞；节点崩溃后由 wal 文件重放补齐。', status: 'approved' })
  await writeCard(vaultB, { kind: 'project', title: 'B-only-2', tags: ['t'], body: '发布窗口定在每周四凌晨三点，回滚脚本与备份清单必须提前一天演练完毕并留档。', status: 'approved' })

  const port = 19500 + Math.floor(Math.random() * 300)
  const srv = await startWebServer({ port, vaultRoot: vaultA, host: '127.0.0.1', webRoot: path.resolve('web') })
  const base = 'http://127.0.0.1:' + port + API_PREFIX
  try {
    const before = await (await fetch(base + '/overview')).json()
    assert.equal(before.vaultDir, path.resolve(vaultA))
    assert.equal(before.total, 1, '切库前看到的是 A 库的 1 张卡')

    const sw = await (await fetch(base + '/vaults/switch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: vaultB }),
    })).json()
    assert.equal(sw.ok, true)
    assert.equal(sw.hot, true, '独立 web 是支持热切换的形态')

    const after = await (await fetch(base + '/overview')).json()
    assert.equal(after.vaultDir, path.resolve(vaultB), '同一个进程，vaultDir 必须已经指向新库')
    assert.equal(after.total, 2, '数据真的换了（B 库 2 张），不是只改了个标签')

    const list = await (await fetch(base + '/vaults')).json()
    assert.equal(list.current, path.resolve(vaultB))
    assert.equal(list.hotSwitch, true)
    assert.equal(readActiveVault(process.env), path.resolve(vaultB), '偏好同步落盘：重启后仍是这个库')

    // 切回 A：来回切都得成立（不是一次性的）
    const back = await (await fetch(base + '/vaults/switch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: vaultA }),
    })).json()
    assert.equal(back.hot, true)
    const again = await (await fetch(base + '/overview')).json()
    assert.equal(again.total, 1, '切回来又是 A 库的 1 张卡')
  } finally {
    await new Promise((r) => srv.server.close(r))
  }
})
// ── 配置持久化：切库不只要能"当下生效"，重启后也必须是这个库 ─────────────────
// 只写共享偏好是不够的：偏好排在「配置 vaultDir / activeVault 命中的 profile / 启动参数 --vault」之后，
// 常驻实例恰恰是由宿主或看门狗用 --vault 拉起来的 —— 只写偏好 = 重启后自己跳回旧库。

/** 用注入的 writeConfig 抓「切库时到底写了什么配置」。 */
const withWriter = (settings, extra = {}) => {
  const calls = []
  const api = createApi({
    vaultDir: () => vaultA,
    getSettings: () => settings,
    writeConfig: async (patch) => { calls.push(patch); return { applied: Object.keys(patch) } },
    switchVault: async (p) => ({ ok: true, hot: true, root: path.resolve(p), prev: vaultA, isCurrent: true }),
    ...extra,
  })
  return { api, calls }
}

test('切库落配置：没有同名 profile → 写 vaultDir 并清掉 activeVault（否则 profile 继续赢）', async () => {
  await ensureVault(vaultA); await ensureVault(vaultB)
  const { api, calls } = withWriter({ vaultDir: vaultA, activeVault: 'old', vaultProfiles: [] })
  const r = await callApi(api, API_PREFIX + '/vaults/switch', { method: 'POST', body: { path: vaultB } })
  assert.equal(r.status, 200)
  assert.equal(r.json.persisted && r.json.persisted.ok, true, '要把持久化结果如实回给前端')
  assert.equal(calls.length, 1, '该写一次配置')
  assert.equal(calls[0].vaultDir, path.resolve(vaultB))
  assert.equal(calls[0].activeVault, '', 'activeVault 必须清空，否则 profile 永远压过 vaultDir')
})

test('切库落配置：路径命中某 profile → 写 activeVault（不并排塞一份 vaultDir）', async () => {
  await ensureVault(vaultA); await ensureVault(vaultB)
  const { api, calls } = withWriter({ vaultDir: '', activeVault: '', vaultProfiles: [{ name: 'work', path: vaultB }] })
  const r = await callApi(api, API_PREFIX + '/vaults/switch', { method: 'POST', body: { path: vaultB } })
  assert.equal(r.json.persisted.ok, true)
  assert.deepEqual(calls[0], { activeVault: 'work' })
})

test('切库落配置：配置里已经是这个库 → skipped，不白写一次（不触发宿主 drain）', async () => {
  await ensureVault(vaultA); await ensureVault(vaultB)
  const { api, calls } = withWriter({ vaultDir: path.resolve(vaultB), activeVault: '', vaultProfiles: [] })
  const r = await callApi(api, API_PREFIX + '/vaults/switch', { method: 'POST', body: { path: vaultB } })
  assert.equal(r.json.persisted.skipped, true)
  assert.equal(calls.length, 0)
})

test('切库落配置：MEMORY_VAULT_DIR 存在时如实回报 envOverride（写了也压不过环境变量）', async () => {
  await ensureVault(vaultA); await ensureVault(vaultB)
  const prev = process.env.MEMORY_VAULT_DIR
  process.env.MEMORY_VAULT_DIR = vaultA
  try {
    const { api } = withWriter({ vaultDir: vaultA, activeVault: '', vaultProfiles: [] })
    const r = await callApi(api, API_PREFIX + '/vaults/switch', { method: 'POST', body: { path: vaultB } })
    assert.equal(r.json.persisted.envOverride, true)
  } finally {
    if (prev === undefined) delete process.env.MEMORY_VAULT_DIR
    else process.env.MEMORY_VAULT_DIR = prev
  }
})

test('切库失败不改配置：目标库打不开时不许把用户配置改成那个坏路径', async () => {
  await ensureVault(vaultA)
  const calls = []
  const api = createApi({
    vaultDir: () => vaultA,
    getSettings: () => ({ vaultDir: vaultA, activeVault: '', vaultProfiles: [] }),
    writeConfig: async (patch) => { calls.push(patch); return {} },
    switchVault: async () => ({ ok: false, error: '目标库打不开' }),
  })
  const r = await callApi(api, API_PREFIX + '/vaults/switch', { method: 'POST', body: { path: vaultB } })
  assert.equal(r.status, 400)
  assert.equal(calls.length, 0, '失败时一次配置都不该写')
})
test('切库落配置：MEMORY_VAULT_DIR 指的就是这个库 → 不算被环境钉住（托管部署里它必然存在）', async () => {
  await ensureVault(vaultA); await ensureVault(vaultB)
  const prev = process.env.MEMORY_VAULT_DIR
  process.env.MEMORY_VAULT_DIR = path.resolve(vaultB)
  try {
    const { api } = withWriter({ vaultDir: vaultA, activeVault: '', vaultProfiles: [] })
    const r = await callApi(api, API_PREFIX + '/vaults/switch', { method: 'POST', body: { path: vaultB } })
    assert.equal(r.json.persisted.envOverride, false, '同一个库不该报「被环境变量钉住」')
  } finally {
    if (prev === undefined) delete process.env.MEMORY_VAULT_DIR
    else process.env.MEMORY_VAULT_DIR = prev
  }
})

// ── 看门狗重新拉起 web 时用哪个库 ─────────────────────────────────────────────
/** 只做「目录 + 空的 memory-eternal.db」：readActiveVault 只验证文件存在，不必真开库（避免句柄占用）。 */
const mkDb = (dir) => { mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, 'memory-eternal.db'), '') }
// 切库后 web 崩一次就会被看门狗重新拉起：这时如果还用它**启动那一刻**的 --vault，
// 用户会看到「切库过一会儿自己跳回去了」。
test('pickSpawnVault：切过库 → 用共享偏好里的新库（启动参数只作兜底）', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-spawn-'))
  const home = path.join(dir, 'home')
  mkDb(path.join(dir, 'a')); mkDb(path.join(dir, 'b'))
  writeActiveVault(path.join(dir, 'b'), { DSH_HOME: home })
  try {
    const r = pickSpawnVault({ arg: path.join(dir, 'a'), env: { DSH_HOME: home } })
    assert.equal(r.source, 'pref')
    assert.equal(r.root, path.resolve(path.join(dir, 'b')))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('pickSpawnVault：没切过库（无偏好）→ 退回启动参数', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-spawn2-'))
  const home = path.join(dir, 'home')
  mkDb(path.join(dir, 'a'))
  try {
    const r = pickSpawnVault({ arg: path.join(dir, 'a'), env: { DSH_HOME: home } })
    assert.equal(r.source, 'arg')
    assert.equal(r.root, path.resolve(path.join(dir, 'a')))
    assert.equal(pickSpawnVault({ arg: '', env: { DSH_HOME: home } }).root, '')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})

test('pickSpawnVault：偏好指向的库被删了 → readActiveVault 不采信，退回启动参数', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mc-spawn3-'))
  const home = path.join(dir, 'home')
  mkDb(path.join(dir, 'a'))
  try {
    // 手写一份指向已不存在目录的偏好：坏偏好不能把 web 拉到一个空目录上
    mkdirSync(home, { recursive: true })
    writeFileSync(path.join(home, 'memory-eternal-active-vault.json'), JSON.stringify({ path: path.join(dir, 'gone') }), 'utf8')
    const r = pickSpawnVault({ arg: path.join(dir, 'a'), env: { DSH_HOME: home } })
    assert.equal(r.source, 'arg')
    assert.equal(r.root, path.resolve(path.join(dir, 'a')))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
test('端到端：切库后重启（不带 --vault）→ 仍然是切过去的那个库', async () => {
  // 用独立的两个库：前面的用例也在往 vaultA/vaultB 里写卡，共用会互相干扰计数
  const C = path.join(tmpHome, 'memory-vault-c')
  const D = path.join(tmpHome, 'memory-vault-d')
  await ensureVault(C)
  await ensureVault(D)
  await writeCard(C, { kind: 'knowledge', title: 'C 独有', tags: ['t'], body: 'C 库的独有内容：讲 WAL 与崩溃恢复的边界条件。', status: 'approved' })
  await writeCard(D, { kind: 'knowledge', title: 'D 独有', tags: ['t'], body: 'D 库的独有内容：讲发布窗口与回滚演练清单。', status: 'approved' })
  await writeCard(D, { kind: 'project', title: 'D 第二张', tags: ['t'], body: 'D 库第二张：索引重建安排在离峰时段并预留双倍磁盘。', status: 'approved' })
  await writeCard(D, { kind: 'tool', title: 'D 第三张', tags: ['t'], body: 'D 库第三张：sqlite3 .dump 与 node:sqlite 抄家的差异对比。', status: 'approved' })

  const port = 19800 + Math.floor(Math.random() * 150)
  const base = 'http://127.0.0.1:' + port + API_PREFIX
  const s1 = await startWebServer({ port, vaultRoot: C, host: '127.0.0.1', webRoot: path.resolve('web') })
  try {
    const sw = await (await fetch(base + '/vaults/switch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: D }),
    })).json()
    assert.equal(sw.ok, true)
  } finally { await new Promise((r) => s1.server.close(r)) }

  // 重启：**不传 --vault**（宿主/看门狗那一路会自己解析；这里模拟"没有显式参数"的最干净形态）
  const s2 = await startWebServer({ port, vaultRoot: '', host: '127.0.0.1', webRoot: path.resolve('web') })
  try {
    const ov = await (await fetch(base + '/overview')).json()
    assert.equal(ov.vaultDir, path.resolve(D), '重启后必须还是切过去的库，不能自己跳回默认库')
    assert.equal(ov.total, 3, '读到的也必须是 D 库的数据')
  } finally { await new Promise((r) => s2.server.close(r)) }
})

test('端到端：重启时仍带旧的 --vault → 显式参数依旧赢（这条边界要留着，别偷偷改）', async () => {
  await ensureVault(vaultA)
  await ensureVault(vaultB)
  const port = 19960 + Math.floor(Math.random() * 150)
  const base = 'http://127.0.0.1:' + port + API_PREFIX
  const s1 = await startWebServer({ port, vaultRoot: vaultA, host: '127.0.0.1', webRoot: path.resolve('web') })
  try {
    await fetch(base + '/vaults/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: vaultB }) })
  } finally { await new Promise((r) => s1.server.close(r)) }
  const s2 = await startWebServer({ port, vaultRoot: vaultA, host: '127.0.0.1', webRoot: path.resolve('web') })
  try {
    const ov = await (await fetch(base + '/overview')).json()
    assert.equal(ov.vaultDir, path.resolve(vaultA), '--vault 是显式参数，排在偏好之前（调用方明确指定就该听它的）')
  } finally { await new Promise((r) => s2.server.close(r)) }
  // 补偿手段：看门狗拉起 web 时用 pickSpawnVault 重新解析（见上面的用例），所以它不会再传旧参数
})
// ── 宿主形态：vaultDir() 每请求重算 → 写偏好 + 配置就等于「当场切了」 ─────────────
// 这条是 DSH 内嵌面板（设置 → 记忆 → 实验性）的真实形态：API 跑在 DSH 宿主进程里，
// 没有「改一个变量」的热切，但有「每次请求重新解析」——所以只要写对地方就生效。
test('宿主形态：注入 switchVault 后写偏好+配置，下一次请求的 vaultDir 就是新库（无进程重启）', async () => {
  const C = path.join(tmpHome, 'memory-vault-host-c')
  const D = path.join(tmpHome, 'memory-vault-host-d')
  await ensureVault(C)
  await ensureVault(D)
  await writeCard(D, { kind: 'knowledge', title: 'D 宿主库', tags: ['t'], body: '宿主形态切库后应读到的内容：讲持久化与重算优先级。', status: 'approved' })

  // 宿主里的「当前库」= resolveVaultDir(...)：env > profile > workspace > vaultDir > 偏好 > 默认
  const cfg = { vaultDir: C, activeVault: '', vaultProfiles: [] }
  const currentRoot = () => resolveVaultDir({ profiles: cfg.vaultProfiles, activeVault: cfg.activeVault, configured: cfg.vaultDir, prefRoot: readActiveVault(process.env) }).root
  const api = createApi({
    vaultDir: currentRoot,
    getSettings: () => cfg,
    // 宿主有 settings 服务：writeConfig 直接落到配置（与 index.js 注入的 writeConfig 同语义）
    writeConfig: async (patch) => { Object.assign(cfg, patch); return { applied: Object.keys(patch) } },
    // index.js 注入的实现：确认目标库可用 + 写共享偏好（配置由 api 自己落）
    switchVault: async (rawTarget) => {
      const want = path.resolve(String(rawTarget))
      await ensureVault(want)
      writeActiveVault(want, process.env)
      return { ok: true, hot: true, root: want, prev: C, isCurrent: true }
    },
  })

  const before = await callApi(api, API_PREFIX + '/overview')
  assert.equal(before.json.vaultDir, path.resolve(C))

  const sw = await callApi(api, API_PREFIX + '/vaults/switch', { method: 'POST', body: { path: D } })
  assert.equal(sw.json.ok, true)
  assert.equal(sw.json.hot, true)
  assert.equal(sw.json.persisted.ok, true)

  const after = await callApi(api, API_PREFIX + '/overview')
  assert.equal(after.json.vaultDir, path.resolve(D), '下一次请求必须已经是新库（宿主每请求重算）')
  assert.equal(after.json.total, 1, '读到的也必须是 D 库的数据')
  assert.equal(cfg.vaultDir, path.resolve(D), '配置也要跟着落，否则重启会被旧配置盖回去')
})

// ── 跨进程跟随：宿主面板切库，独立 web（7999）跟着切，不用重启 ────────────────
test('跨进程：别处写了共享偏好 → 运行中的 web 实例几秒内跟过去（不用重启）', async () => {
  const E = path.join(tmpHome, 'memory-vault-follow-e')
  const F = path.join(tmpHome, 'memory-vault-follow-f')
  await ensureVault(E)
  await ensureVault(F)
  await writeCard(E, { kind: 'knowledge', title: 'E', tags: ['t'], body: 'E 库内容：跟随前应该看到这一张。', status: 'approved' })
  await writeCard(F, { kind: 'knowledge', title: 'F1', tags: ['t'], body: 'F 库第一张：跟随之后应该看到它。', status: 'approved' })
  await writeCard(F, { kind: 'tool', title: 'F2', tags: ['t'], body: 'F 库第二张：另一个不相关的话题，避免被去重合并。', status: 'approved' })

  // 先清掉沿用下来的偏好，确保启动时就是 E（否则启动瞬间就被跟随切走了）
  try { fs.rm(path.join(tmpHome, 'memory-eternal-active-vault.json'), { force: true }) } catch { /* 忽略 */ }

  const port = 20100 + Math.floor(Math.random() * 150)
  const base = 'http://127.0.0.1:' + port + API_PREFIX
  const srv = await startWebServer({ port, vaultRoot: E, host: '127.0.0.1', webRoot: path.resolve('web') })
  try {
    const before = await (await fetch(base + '/overview')).json()
    assert.equal(before.vaultDir, path.resolve(E))
    assert.equal(before.total, 1)
    // 模拟「在 DSH 面板里切了库」：只写共享偏好（宿主那一侧就是这么通知别人的）
    writeActiveVault(F, process.env)
    let current = ''
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 500))
      current = (await (await fetch(base + '/overview')).json()).vaultDir
      if (current === path.resolve(F)) break
    }
    assert.equal(current, path.resolve(F), '运行中的实例必须跟着共享偏好切过去（不重启）')
    const after = await (await fetch(base + '/overview')).json()
    assert.equal(after.total, 2, '跟随之后读到的是 F 库的数据')
  } finally {
    await new Promise((r) => srv.server.close(r))
    try { fs.rm(path.join(tmpHome, 'memory-eternal-active-vault.json'), { force: true }) } catch { /* 忽略 */ }
  }
})
