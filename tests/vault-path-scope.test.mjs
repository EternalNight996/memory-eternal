// 多租户路径作用域（审计 S1 / H5 / H6 的服务端契约）。
//
// 背景：`/vaults/export`、`/vaults/import-into`、`/vaults/transfer`、`/vaults/switch`
// 的路径**全部来自请求**，旧实现直接 `path.resolve(用户传的值)` 就开库 ——
// 云端多租户下任何合法租户都能读写别人的库（多租户隔离归零）。
//
// 守三件事：
//   ① 云端模式（pathScope.mode='cloud'）：别人的租户目录一律 403 path-not-allowed；
//   ② 本地模式（缺省）：当前库 + 同级历史库副本仍可读（保住「把旧库上传到云端」的能力），
//      越界路径 403；
//   ③ tenantVault 拒绝 `.` / `..`（否则租户库根会跳到 cloud-vaults 的父目录）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApi, API_PREFIX } from '../lib/api.js'
import { ensureVault, writeCard } from '../lib/vault.js'
import { closeAllDb, DB_FILE } from '../lib/db.js'
import { startWebServer } from '../lib/web.js'
import { tenantVault, cloudRoot } from '../lib/cloud-auth.js'
import { validateInstallerPath, runSilentInstall } from '../lib/ollama-install.js'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'me-scope-'))
process.env.DSH_HOME = tmpHome

after(async () => {
  closeAllDb()
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* Windows 句柄延迟，忽略 */ }
})

/** 极简 res 桩：够 createApi 的 json() 用。 */
function fakeRes() {
  const out = { status: 0, body: '', headers: {} }
  out.writeHead = (s, h) => { out.status = s; if (h) out.headers = { ...out.headers, ...h } }
  out.setHeader = (k, v) => { out.headers[k] = v }
  out.end = (b) => { out.body = String(b || '') }
  out.on = () => {}
  out.once = () => {}
  out.emit = () => {}
  return out
}

/** 调一次 api：body 为 null 表示不带体。 */
const callApi = async (api, url, { method = 'GET', body = null, headers = {} } = {}) => {
  const res = fakeRes()
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body))]
  const req = {
    url,
    method,
    headers: { 'content-type': 'application/json', ...headers },
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c },
  }
  await api(req, res)
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch { /* 非 JSON */ }
  return { status: res.status, body: res.body, json: parsed, headers: res.headers }
}

/** 造一个「有卡片的库」，返回它的根目录。 */
async function makeVault(dir, title) {
  await ensureVault(dir)
  await writeCard(dir, {
    kind: 'knowledge',
    title,
    tags: ['scope'],
    body: `${title} 的正文：用于验证路径作用域；内容足够长以便正常写入知识库。`,
    status: 'approved',
  }, { dedup: false })
  return dir
}

// ── ① 云端模式：只能碰自己的库 ────────────────────────────────────────────────
test('云端模式：export 别人的租户路径 → 403 path-not-allowed（S1 主场景）', async () => {
  const mine = await makeVault(path.join(tmpHome, 'cloud-vaults', 'alice'), 'Alice 的私房卡')
  const theirs = await makeVault(path.join(tmpHome, 'cloud-vaults', 'bob'), 'Bob 的私房卡')
  // 云端实例的注入方式与 lib/cloud-server.js 完全一致
  const api = createApi({
    vaultDir: () => mine,
    vaultRoots: () => [{ name: 'alice', root: mine }],
    getSettings: () => ({}),
    pathScope: { mode: 'cloud', roots: [mine] },
  })
  // 自己的库：正常导出
  const own = await callApi(api, API_PREFIX + '/vaults/export')
  assert.equal(own.status, 200)
  assert.equal(own.json.vault, path.resolve(mine))

  // 别人的库：必须 403，且**不能**回任何卡片内容
  const evil = await callApi(api, API_PREFIX + '/vaults/export?path=' + encodeURIComponent(theirs))
  assert.equal(evil.status, 403, '跨租户导出必须 403')
  assert.equal(evil.json.ok, false)
  assert.equal(evil.json.error, 'path-not-allowed')
  assert.equal(evil.json.code, 'PATH_NOT_ALLOWED')
  assert.doesNotMatch(evil.body, /私房卡/, '拒绝时一个字节的卡片内容都不许漏')
})

test('云端模式：import-into 写别人的库 → 403；transfer 两端越界 → 403', async () => {
  const mine = await makeVault(path.join(tmpHome, 'cloud-vaults', 'carol'), 'Carol 的卡')
  const theirs = await makeVault(path.join(tmpHome, 'cloud-vaults', 'dave'), 'Dave 的卡')
  const api = createApi({
    vaultDir: () => mine,
    getSettings: () => ({}),
    pathScope: { mode: 'cloud', roots: [mine] },
  })
  const into = await callApi(api, API_PREFIX + '/vaults/import-into', {
    method: 'POST',
    body: { target: theirs, cards: [{ title: '注入卡', kind: 'knowledge', body: '污染别人召回的内容，足够长以便写入。' }] },
  })
  assert.equal(into.status, 403)
  assert.equal(into.json.error, 'path-not-allowed')

  const transfer = await callApi(api, API_PREFIX + '/vaults/transfer', {
    method: 'POST',
    body: { source: theirs, target: mine },
  })
  assert.equal(transfer.status, 403, '从别人的库搬卡也必须拒')
  assert.equal(transfer.json.error, 'path-not-allowed')

  const transferOut = await callApi(api, API_PREFIX + '/vaults/transfer', {
    method: 'POST',
    body: { source: mine, target: theirs },
  })
  assert.equal(transferOut.status, 403, '往别人的库写也必须拒')

  // 自己的两个库之间搬运仍然可用（命名库在租户根之下）
  const named = await makeVault(path.join(mine, 'vaults', 'work'), 'Carol 的工作库卡')
  const ok = await callApi(api, API_PREFIX + '/vaults/transfer', {
    method: 'POST',
    body: { source: named, target: mine, dryRun: true },
  })
  assert.equal(ok.status, 200, '租户自己的命名库不能被误伤：' + ok.body)
  assert.equal(ok.json.dryRun, true)
})

test('云端模式：switch 到别人的租户库 → 403（请求根本没走到热切换）', async () => {
  const mine = await makeVault(path.join(tmpHome, 'cloud-vaults', 'erin'), 'Erin 的卡')
  const theirs = await makeVault(path.join(tmpHome, 'cloud-vaults', 'frank'), 'Frank 的卡')
  let hotCalled = 0
  const api = createApi({
    vaultDir: () => mine,
    getSettings: () => ({}),
    switchVault: async () => { hotCalled++; throw new Error('越界请求不该走到热切换') },
    pathScope: { mode: 'cloud', roots: [mine] },
  })
  const r = await callApi(api, API_PREFIX + '/vaults/switch', { method: 'POST', body: { path: theirs } })
  assert.equal(r.status, 403)
  assert.equal(r.json.error, 'path-not-allowed')
  assert.equal(hotCalled, 0, '越界请求必须在闸门处就停，不许进入热切换')
})

// ── H6：热切库不再对请求里的路径 mkdir / 建库 ────────────────────────────────
test('H6：/vaults/switch 只接受已存在的库，不会在允许根内"现造"一个目录', async () => {
  const root = await makeVault(path.join(tmpHome, 'switch-vault-a'), 'A 库的卡')
  const sibling = await makeVault(path.join(tmpHome, 'switch-vault-b'), 'B 库的卡')
  const port = 21000 + Math.floor(Math.random() * 400)
  const srv = await startWebServer({ port, vaultRoot: root, host: '127.0.0.1', webRoot: path.resolve('web') })
  const base = 'http://127.0.0.1:' + port + API_PREFIX
  try {
    // ① 允许根内但**不存在**的目录：不许创建
    const ghost = path.join(tmpHome, 'switch-vault-ghost')
    const r1 = await (await fetch(base + '/vaults/switch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: ghost }),
    })).json()
    assert.equal(r1.ok, false)
    assert.equal(r1.error, 'path-not-allowed')
    assert.equal(fs.existsSync(ghost), false, '目标不存在时绝不许 mkdir（旧实现会建目录 + 建库）')

    // ② 允许根**之外**的路径：403
    const outside = path.join(tmpHome, '..', 'me-scope-outside')
    const r2 = await (await fetch(base + '/vaults/switch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: outside }),
    })).json()
    assert.equal(r2.ok, false)
    assert.equal(r2.error, 'path-not-allowed')
    assert.equal(fs.existsSync(outside), false)

    // ③ 已存在的同级库：正常热切（老能力保留）
    const ok = await (await fetch(base + '/vaults/switch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: sibling }),
    })).json()
    assert.equal(ok.ok, true, '同级已存在的库必须能切：' + JSON.stringify(ok))
    assert.equal(ok.hot, true)
    const ov = await (await fetch(base + '/overview')).json()
    assert.equal(ov.vaultDir, path.resolve(sibling), '切完立即生效')
  } finally {
    await new Promise((r) => srv.server.close(r))
  }
})

// ── ② 本地模式：同级历史库仍可读（别把老能力改没了）──────────────────────────
test('本地模式：读同级历史库副本 → 200；越界路径 → 403', async () => {
  const cur = await makeVault(path.join(tmpHome, 'memory-vault'), '当前库的卡')
  const history = await makeVault(path.join(tmpHome, 'memory-vault-ok'), '历史副本的卡')
  // 本地形态不注入 pathScope：缺省 = [当前库, 当前库的父目录]
  const api = createApi({ vaultDir: () => cur, getSettings: () => ({}) })

  const sib = await callApi(api, API_PREFIX + '/vaults/export?path=' + encodeURIComponent(history))
  assert.equal(sib.status, 200, '同级历史库必须还能读（上传旧库到云端的能力）')
  assert.equal(sib.json.ok, true)
  assert.ok(sib.json.cards.some((c) => c.title === '历史副本的卡'))

  const cover = await callApi(api, API_PREFIX + '/vaults/export?path=' + encodeURIComponent(path.join(tmpHome, '..', 'etc')))
  assert.equal(cover.status, 403, '父目录之外必须拒')
  assert.equal(cover.json.error, 'path-not-allowed')

  // 相对路径先 resolve 再判：`../` 穿越不许绕过
  const rel = await callApi(api, API_PREFIX + '/vaults/export?path=' + encodeURIComponent('../../../../../../etc'))
  assert.equal(rel.status, 403)
})

test('/vaults 枚举不受作用域收紧影响（自己的库仍然列得出来）', async () => {
  const cur = await makeVault(path.join(tmpHome, 'memory-vault-list'), '枚举测试卡')
  const api = createApi({ vaultDir: () => cur, getSettings: () => ({}) })
  const r = await callApi(api, API_PREFIX + '/vaults')
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.ok(Array.isArray(r.json.vaults))
  assert.equal(r.json.current, path.resolve(cur))
  assert.ok(r.json.vaults.some((v) => v.isCurrent === true), '当前库必须标 isCurrent')
})

// ── ③ tenantVault 拒绝 `.` / `..`（H5）──────────────────────────────────────
test("tenantVault：'.' / '..' / '...' 抛错，且任何 owner 都跳不出 cloud-vaults", () => {
  const env = { ...process.env, DSH_HOME: tmpHome }
  for (const bad of ['.', '..', '...', '', '   ']) {
    assert.throws(() => tenantVault(bad, env), /owner 不合法/, JSON.stringify(bad) + ' 必须抛错')
  }
  // 打平后的穿越仍然留在 cloud-vaults 下面（父目录必须就是 cloud-vaults）
  const root = path.resolve(cloudRoot(env))
  for (const owner of ['../../etc/passwd', '..\\..\\windows', 'a/../../b', '用户一']) {
    const dir = tenantVault(owner, env)
    assert.equal(path.dirname(path.resolve(dir)), root, owner + ' 必须落在一层子目录里')
    assert.ok(path.resolve(dir).startsWith(root + path.sep))
  }
  // 合法的 owner 依旧可用
  assert.equal(path.dirname(path.resolve(tenantVault('alice@example.com', env))), root)
})

test('云端库文件真的还在原处（越界拒绝不是靠"文件不存在"蒙对的）', async () => {
  const theirs = path.join(tmpHome, 'cloud-vaults', 'bob')
  assert.equal(fs.existsSync(path.join(theirs, DB_FILE)), true)
})

// ── ④ S3：请求里的路径不许被当成"可执行文件" ─────────────────────────────────
test('S3：安装器路径校验（绝对路径 + 已存在 + 安装器后缀 + 解释器黑名单）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-inst-'))
  try {
    const okExe = path.join(tmp, 'OllamaSetup.exe')
    fs.writeFileSync(okExe, 'MZ')
    assert.equal(validateInstallerPath(okExe).ok, true, '正常安装器要放行')
    assert.equal(validateInstallerPath(okExe).path, path.resolve(okExe))

    // 后缀/存在性/绝对路径
    assert.match(validateInstallerPath('').code, /setup_not_configured/)
    assert.equal(validateInstallerPath('OllamaSetup.exe').code, 'path_not_absolute', '相对路径必须拒')
    assert.equal(validateInstallerPath(path.join(tmp, 'nope.exe')).code, 'path_not_found', '不存在必须拒')
    const txt = path.join(tmp, 'payload.txt')
    fs.writeFileSync(txt, 'x')
    assert.equal(validateInstallerPath(txt).code, 'path_not_allowed', '非安装器后缀必须拒')
    assert.equal(validateInstallerPath(tmp).code, 'path_not_allowed', '目录必须拒')

    // 审计 S3 的 PoC：任意本机可执行文件（cmd.exe 后缀合法、文件真实存在）
    const shell = process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
      : '/bin/sh'
    assert.equal(validateInstallerPath(shell).ok, false, '通用解释器/加载器必须拒：' + shell)
    const run = await runSilentInstall(shell, { env: { ...process.env, MEMORY_OLLAMA_INSTALL_DRY: '1' } })
    assert.equal(run.ok, false, 'runSilentInstall 的防线要真的生效（不是只有校验函数生效）')
    assert.equal(run.code, 'path_not_allowed')

    // 合法安装器 + dry-run 仍按旧契约返回
    const dry = await runSilentInstall(okExe, { env: { ...process.env, MEMORY_OLLAMA_INSTALL_DRY: '1' } })
    assert.equal(dry.ok, true)
    assert.equal(dry.dry, true)
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }
})

test('S3：/embedding/install-ollama 只认 MEMORY_OLLAMA_SETUP，请求里的 path 一律忽略', () => {
  // 路由层的主控制（本机已装 Ollama 时该端点会短路成 already:true，跑不出 403，
  // 所以这里对"代码形状"做守卫：不许再把 body.path 送进安装器）
  const src = fs.readFileSync(new URL('../lib/api.js', import.meta.url), 'utf8')
  const start = src.indexOf("case '/embedding/install-ollama'")
  assert.ok(start > 0)
  const end = src.indexOf("case '/embedding/service'", start)
  const block = src.slice(start, end > start ? end : start + 4000)
  assert.match(block, /validateInstallerPath\(/, '必须先校验安装器路径')
  assert.match(block, /MEMORY_OLLAMA_SETUP/, '只认环境变量')
  assert.doesNotMatch(block, /String\(body\.path \|\| process\.env\.MEMORY_OLLAMA_SETUP/,
    '不许再把 body.path 当作安装器来源（审计 S3 的原始写法）')
  assert.doesNotMatch(block, /runSilentInstall\(setup/, '不许直接执行请求传来的路径')
  assert.match(block, /ignoredPath/, '忽略请求里的 path 时要在响应里说明')
})
