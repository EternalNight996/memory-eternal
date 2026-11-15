// 服务端自动生成管理令牌（免人工 openssl rand）+ 面板「服务端密钥管理」守卫。
//
// 背景（用户原话）：「MEMORY_CLOUD_ADMIN_TOKEN 一般谁生成？然后怎么填？有没有方便点的方法？在 UI 上操作？」
// 旧状态：云端管理面（/cloud/keys、/cloud/config）只能 ssh 上去 curl；面板里只有"使用密钥"的输入框，
// 没有签发/吊销界面；管理令牌要人工生成再写 env。
//
// 本文件守七件事：
//   ① 没配 env 时**首次启动自动生成**令牌并落 `$DSH_HOME/cloud-admin-token`（≤0600，wx 独占），
//      stderr **只打印一次**；`/cloud/config` 带这把令牌可用，且 `adminTokenSource='generated'`；
//   ② 同一 DSH_HOME 再构造（= 重启）**不重新生成**，值不变、也不再打印令牌；
//   ③ 配了 env → `adminTokenSource='env'`、**不创建也不覆盖**文件，文件里的旧值不再能进管理面；
//   ④ 用生成/文件令牌能 `POST /cloud/keys` 签发（明文 `me_` 一次），列表**不含**明文与 hash；
//   ⑤ 无令牌 + 伪造 `X-Forwarded-For` → 403（回归审计 S2）；真回环直连仍免令牌（旧行为不变）；
//   ⑥ `/cloud/config` 响应体里**扫不到**令牌值与任何 64 位 hex；
//   ⑦ 前端源码里「服务端密钥管理」块存在：localStorage key、`type=password`、一次性明文文案、
//      `DELETE /cloud/keys/:id`，且请求**刻意绕开**全局 fetch 包装（否则会被注入租户令牌而 403）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCloudServer } from '../lib/cloud-server.js'

const TOKEN_FILE = 'cloud-admin-token'
const JSON_HEADERS = { 'content-type': 'application/json' }

/** 临时 DSH_HOME（云端租户目录、密钥台账、管理令牌都从这里派生）。 */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-admui-'))
  fs.writeFileSync(path.join(home, 'cloud-keys.json'), JSON.stringify({ version: 1, keys: [], mengbot: {} }), { mode: 0o600 })
  return home
}
const rmHome = (home) => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 句柄未关时忽略 */ } }

/** 干净 env：本次测试里所有"未配置"的用例都必须真的没有 env 令牌（宿主机可能配过）。 */
function envOf(home, extra = {}) {
  const env = { ...process.env, DSH_HOME: home, ...extra }
  if (!Object.prototype.hasOwnProperty.call(extra, 'MEMORY_CLOUD_ADMIN_TOKEN')) delete env.MEMORY_CLOUD_ADMIN_TOKEN
  return env
}

/** 造一个最小 req/res，跑一遍云端 handler，返回 {status, body, text}。 */
function invoke(handler, { method = 'GET', sub = '/cloud/config', headers = {}, remoteAddress = '203.0.113.9', body = '' } = {}) {
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
        try { parsed = JSON.parse(text) } catch { /* 保留原文 */ }
        resolve({ status: this.statusCode, body: parsed, text, headers: this.headers })
      },
    }
    Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 500, body: { error: String(e && e.message) }, text: '' }))
  })
}

/** 捕获构造期的 console.error（令牌只在这一次打印，必须能验证）。 */
function captureStderr(fn) {
  const lines = []
  const orig = console.error
  console.error = (...a) => { lines.push(a.map((x) => String(x)).join(' ')) }
  try { return { value: fn(), lines } } finally { console.error = orig }
}

const tokenFile = (home) => path.join(home, TOKEN_FILE)
const readToken = (home) => fs.readFileSync(tokenFile(home), 'utf8').trim()

// ── ① 自动生成 ───────────────────────────────────────────────────────────────
test('无 env → 首次构造自动生成管理令牌文件（wx/0600），stderr 只打印一次，且能进管理面', () => {
  const home = makeHome()
  try {
    const { value: handler, lines } = captureStderr(() => createCloudServer({ env: envOf(home) }))
    assert.equal(fs.existsSync(tokenFile(home)), true, '应生成 $DSH_HOME/cloud-admin-token')
    const token = readToken(home)
    assert.ok(token.length >= 32, '令牌要够长（≥32 字符），实际 ' + token.length)
    // 0600：Windows 上 Node 只映射只读位，stat 读回来是 666，所以在 POSIX 上严格校验
    const mode = fs.statSync(tokenFile(home)).mode & 0o777
    if (process.platform !== 'win32') assert.equal(mode.toString(8), '600', '令牌文件必须 0600')
    // 写盘用 wx 独占 + 0600（防预先放置符号链接 / 撞名覆盖）
    const src = fs.readFileSync('lib/cloud-server.js', 'utf8')
    assert.match(src, /writeFileSync\(file, token \+ '\\n', \{ flag: 'wx', mode: 0o600 \}\)/, '必须 wx + 0600 落盘')
    // stderr 只打印一次，且带完整令牌（用户要复制它）
    const printed = lines.filter((l) => l.includes('管理令牌：'))
    assert.equal(printed.length, 1, '令牌只打印一次（实际 ' + printed.length + ' 次）')
    assert.match(printed[0], new RegExp(token), '打印的必须就是落盘那把令牌')
    assert.ok(lines.some((l) => l.includes(TOKEN_FILE)), '要告诉用户文件在哪')
    assert.ok(lines.some((l) => l.includes('服务端密钥管理')), '要告诉用户去面板哪里粘贴')
    return { handler, token }
  } catch (e) { rmHome(home); throw e }
})

test('生成的令牌能让**远程来源**进管理面，/cloud/config 返回 adminTokenSource=generated', async () => {
  const home = makeHome()
  try {
    const { value: fresh } = captureStderr(() => createCloudServer({ env: envOf(home) }))
    const token = readToken(home)
    // 远程来源（非回环）：只有带对令牌才 200 —— 这正是"面板能远程签发"的前提
    const noTok = await invoke(fresh, { sub: '/cloud/config', remoteAddress: '203.0.113.9' })
    assert.equal(noTok.status, 403, '不带令牌的远程请求必须 403')
    const ok = await invoke(fresh, { sub: '/cloud/config', headers: { authorization: 'Bearer ' + token }, remoteAddress: '203.0.113.9' })
    assert.equal(ok.status, 200, '带生成令牌应 200：' + JSON.stringify(ok.body))
    assert.equal(ok.body.adminTokenSource, 'generated', '面板据此提示"去服务端日志/文件里找令牌"')
    assert.equal(ok.body.hasAdminToken, true)
  } finally { rmHome(home) }
})

// ── ② 重启不重新生成 ─────────────────────────────────────────────────────────
test('同一 DSH_HOME 再构造（= 重启）→ 不重新生成：值不变、也不再打印令牌', () => {
  const home = makeHome()
  try {
    captureStderr(() => createCloudServer({ env: envOf(home) }))
    const first = readToken(home)
    const { value: second, lines } = captureStderr(() => createCloudServer({ env: envOf(home) }))
    assert.equal(readToken(home), first, '重启后令牌不许变（否则面板里存的那串立刻失效）')
    assert.equal(lines.filter((l) => l.includes(first)).length, 0, '复用文件时绝不能再回显令牌本体')
    // 复用的这把自己就能用
    return invoke(second, { sub: '/cloud/config', headers: { 'x-admin-token': first }, remoteAddress: '203.0.113.9' })
      .then((r) => {
        assert.equal(r.status, 200)
        assert.equal(r.body.adminTokenSource, 'file')
      })
  } finally { rmHome(home) }
})

// ── ③ env 最高优先级 ─────────────────────────────────────────────────────────
test('配了 env → adminTokenSource=env，不创建文件、不覆盖已有文件，文件里的旧值不再能进管理面', async () => {
  const homeA = makeHome()
  const homeB = makeHome()
  try {
    // A：全新 home + env → 不落盘
    const hA = createCloudServer({ env: envOf(homeA, { MEMORY_CLOUD_ADMIN_TOKEN: 'env_admin_token_0123456789abcdef' }) })
    const rA = await invoke(hA, { sub: '/cloud/config', headers: { authorization: 'Bearer env_admin_token_0123456789abcdef' }, remoteAddress: '203.0.113.9' })
    assert.equal(rA.status, 200)
    assert.equal(rA.body.adminTokenSource, 'env', 'env 配了就是 env，不许被文件/生成抢走')
    assert.equal(fs.existsSync(tokenFile(homeA)), false, 'env 模式下绝不落盘（不能把运维的密钥写到磁盘）')

    // B：已有文件（旧令牌）+ 现在配了 env → 文件原样保留，但旧令牌失效
    fs.writeFileSync(tokenFile(homeB), 'old_file_token_0123456789abcdefXYZ\n', { mode: 0o600 })
    const envB = envOf(homeB, { MEMORY_CLOUD_ADMIN_TOKEN: 'env_admin_token_0123456789abcdef' })
    const hB = createCloudServer({ env: envB })
    assert.equal(readToken(homeB), 'old_file_token_0123456789abcdefXYZ', '已有的令牌文件不许被覆盖')
    const withOld = await invoke(hB, { sub: '/cloud/config', headers: { authorization: 'Bearer old_file_token_0123456789abcdefXYZ' }, remoteAddress: '203.0.113.9' })
    assert.equal(withOld.status, 403, 'env 接管后，文件里的旧令牌必须失效（否则等于留了后门）')
    const withEnv = await invoke(hB, { sub: '/cloud/config', headers: { authorization: 'Bearer env_admin_token_0123456789abcdef' }, remoteAddress: '203.0.113.9' })
    assert.equal(withEnv.status, 200)
  } finally { rmHome(homeA); rmHome(homeB) }
})

// ── ④ 签发 / 列表 ────────────────────────────────────────────────────────────
test('用生成令牌签发访问密钥：返回 me_ 明文一次，列表不含明文与 hash', async () => {
  const home = makeHome()
  try {
    captureStderr(() => createCloudServer({ env: envOf(home) }))
    const admin = readToken(home)
    const h = createCloudServer({ env: envOf(home) })
    const auth = { authorization: 'Bearer ' + admin }

    const issued = await invoke(h, { method: 'POST', sub: '/cloud/keys', body: JSON.stringify({ owner: 'alice', note: '笔记本' }), headers: { ...JSON_HEADERS, ...auth } })
    assert.equal(issued.status, 200, '签发应成功：' + JSON.stringify(issued.body))
    const plain = String(issued.body.token || '')
    assert.match(plain, /^me_/, '明文必须是 me_ 前缀')

    const list = await invoke(h, { sub: '/cloud/keys', headers: auth })
    assert.equal(list.status, 200)
    assert.equal(list.body.keys.length, 1)
    const row = list.body.keys[0]
    assert.equal(row.owner, 'alice')
    assert.equal(row.revoked, false)
    assert.equal('hash' in row, false, '列表不许带 hash')
    assert.equal('token' in row, false, '列表不许带明文')
    const text = JSON.stringify(list.body)
    assert.equal(text.includes(plain), false, '列表里绝不许出现明文密钥')
    assert.doesNotMatch(text, /[0-9a-f]{64}/, '列表里不许出现 token 的 sha256')

    // 明文确实是一把能用的密钥（真打一次业务面）
    const who = await invoke(h, { sub: '/cloud/whoami', headers: { authorization: 'Bearer ' + plain } })
    assert.equal(who.status, 200, '签出来的密钥必须真的能用：' + JSON.stringify(who.body))
    assert.equal(who.body.owner, 'alice')
  } finally { rmHome(home) }
})

// ── ⑤ S2 回归 + 旧行为不变 ───────────────────────────────────────────────────
test('无令牌 + 伪造 X-Forwarded-For → 403（S2 回归）；真回环直连仍免令牌', async () => {
  const home = makeHome()
  try {
    captureStderr(() => createCloudServer({ env: envOf(home) }))
    const h = createCloudServer({ env: envOf(home) })
    // 回环 + 反代头：真实来源无法确认 → 不许当本机（这正是 S2 那条）
    const spoof = await invoke(h, {
      method: 'POST', sub: '/cloud/keys', body: '{"owner":"attacker"}',
      headers: { ...JSON_HEADERS, 'x-forwarded-for': '203.0.113.9' }, remoteAddress: '127.0.0.1',
    })
    assert.equal(spoof.status, 403, '带反代头的一律按非本机处理')
    assert.equal(spoof.body.code, 'admin_required')
    // 生成令牌并不会放宽"仅本机"：没带令牌的私网来源照样 403
    const lan = await invoke(h, { method: 'POST', sub: '/cloud/keys', body: '{"owner":"attacker"}', headers: JSON_HEADERS, remoteAddress: '10.0.0.5' })
    assert.equal(lan.status, 403, '私网 != 本机回环')
    // 旧行为不变：服务器上 localhost curl 仍然免令牌能用
    const local = await invoke(h, { method: 'POST', sub: '/cloud/keys', body: '{"owner":"ops"}', headers: JSON_HEADERS, remoteAddress: '127.0.0.1' })
    assert.equal(local.status, 200, '本机直连仍应免令牌放行')
  } finally { rmHome(home) }
})

// ── ⑥ 令牌不外泄 ─────────────────────────────────────────────────────────────
test('/cloud/config 响应体里不出现令牌值、也不出现任何 64 位 hex', async () => {
  const home = makeHome()
  try {
    captureStderr(() => createCloudServer({ env: envOf(home) }))
    const token = readToken(home)
    const h = createCloudServer({ env: envOf(home) })
    const r = await invoke(h, { sub: '/cloud/config', headers: { authorization: 'Bearer ' + token }, remoteAddress: '203.0.113.9' })
    assert.equal(r.status, 200)
    assert.equal(r.text.includes(token), false, '/cloud/config 绝不许回显管理令牌')
    assert.doesNotMatch(r.text, /[0-9a-f]{64}/, '响应体里不许出现像令牌/hash 的 64 位 hex')
    assert.equal(JSON.stringify(r.body).includes(token), false)
    assert.equal(r.body.adminTokenSource, 'file', '只给来源，不给值')
    // 失败的 403 响应同样只给来源
    const denied = await invoke(h, { sub: '/cloud/config', remoteAddress: '203.0.113.9' })
    assert.equal(denied.status, 403)
    assert.equal(denied.text.includes(token), false, '403 响应也不许带令牌')
  } finally { rmHome(home) }
})

// ── ⑦ 前端源码守卫 ───────────────────────────────────────────────────────────
const SRC = fs.readFileSync('src/client/index.tsx', 'utf8')

test('面板里有「服务端密钥管理」块：折叠卡片 + 管理令牌存 localStorage + 一次明文展示', () => {
  assert.match(SRC, /服务端密钥管理/, '要有这块 UI（注释或文案）')
  assert.match(SRC, /cloudAdminTitle:/, '标题走 i18n')
  // 管理令牌：localStorage key 与租户令牌分开存
  assert.match(SRC, /const CLOUD_ADMIN_KEY = 'me-cloud-admin'/, 'localStorage key 必须是 me-cloud-admin')
  assert.match(SRC, /localStorage\.setItem\(CLOUD_ADMIN_KEY, t\)/, '令牌要真的写进 localStorage')
  // 输入框必须是 password；显示只给前 4 位 + …
  assert.match(SRC, /type="password"\s*\n\s*value=\{admDraft\}/, '管理令牌输入框必须是 type=password')
  assert.match(SRC, /const maskCloudAdminToken = \(t\) => \(t \? String\(t\)\.slice\(0, 4\) \+ '…' : ''\)/, '只显示前 4 位 + …')
  // 一次性明文块：等宽 + 复制 + 醒目提示
  assert.match(SRC, /cloudAdminIssuedOnce/, '要有「只显示这一次」的文案 key')
  assert.match(SRC, /只显示这一次，关掉就再也看不到/, '中文原文要在（用户能看到）')
  assert.match(SRC, /fontFamily: 'ui-monospace,Consolas,monospace', fontSize: 12, wordBreak: 'break-all'/, '明文块用等宽字体')
  assert.match(SRC, /navigator\.clipboard\.writeText\(admSecret\)/, '明文块要有复制按钮')
  // 收起卡片 = 从内存清掉明文
  assert.match(SRC, /setAdmOpen\(\(v\) => !v\); setAdmSecret\(''\)/, '折叠时必须清掉内存里的明文')
  // 明文绝不落 localStorage
  assert.equal((SRC.match(/setItem\(CLOUD_ADMIN_KEY/g) || []).length, 1, '只有管理令牌能进 localStorage，明文密钥不行')
  // 列表列 + 吊销
  for (const col of ['cloudAdminColOwner', 'cloudAdminColNote', 'cloudAdminColVault', 'cloudAdminColCreated', 'cloudAdminColLastUsed', 'cloudAdminColRevoked']) {
    assert.match(SRC, new RegExp("'" + col + "'"), '表格要有 ' + col + ' 列')
  }
  assert.match(SRC, /adminFetch\('\/cloud\/keys\/' \+ encodeURIComponent\(id\), \{ method: 'DELETE' \}\)/, '吊销要打 DELETE /cloud/keys/:id')
  assert.ok(SRC.includes('{k.revoked ? null : ('), '已吊销的行不再给吊销按钮')
  assert.match(SRC, /confirm\(t\('cloudAdminRevokeConfirm'\)\)/, '吊销要二次确认')
})

test('管理面请求刻意绕开全局 fetch 包装（否则被注入租户令牌 → 403 + 熔断）', () => {
  assert.match(SRC, /globalThis\.__meRawFetch\) \|\| globalThis\.fetch/, '必须优先用未打补丁的原始 fetch')
  assert.match(SRC, /const raw = \(typeof globalThis !== 'undefined' && globalThis\.__meRawFetch\) \|\| globalThis\.fetch\s*\n\s*const tok = String\(admStored/, 'adminFetch 里显式取管理令牌')
  assert.match(SRC, /if \(tok\) headers\.Authorization = 'Bearer ' \+ tok/, '管理令牌必须显式写进 Authorization（不靠包装注入）')
  assert.match(SRC, /return raw\(apiPrefix\(\) \+ path,/, '自己拼绝对地址（apiPrefix），不依赖包装重写路径')
  // 反向确认：没有被写成 fetch(API + ...) 那套（那会被注入租户令牌）
  assert.doesNotMatch(SRC, /admStored[\s\S]{0,200}fetch\(API \+ '\/cloud\/keys'/, '不许走会被注入租户令牌的 fetch(API + …)')
})

test('i18n 双语对齐：新增的 cloudAdmin* 每个 key 中英各一条', () => {
  const keys = [
    'cloudAdminTitle', 'cloudAdminHint', 'cloudAdminTokenLabel', 'cloudAdminTokenPlaceholder',
    'cloudAdminTokenSave', 'cloudAdminTokenClear', 'cloudAdminTokenSaved', 'cloudAdminTokenEmpty',
    'cloudAdminTest', 'cloudAdminTestOk', 'cloudAdminList', 'cloudAdminListEmpty', 'cloudAdminIssue',
    'cloudAdminOwnerLabel', 'cloudAdminNoteLabel', 'cloudAdminOwnerInvalid', 'cloudAdminIssuedOnce',
    'cloudAdminCopy', 'cloudAdminRevoke', 'cloudAdminRevokeConfirm', 'cloudAdminRevoked',
    'cloudAdminLocalOnly', 'cloudAdminNeedCloud',
    'cloudAdminColOwner', 'cloudAdminColNote', 'cloudAdminColVault', 'cloudAdminColCreated',
    'cloudAdminColLastUsed', 'cloudAdminColRevoked', 'cloudAdminColOps',
  ]
  for (const k of keys) {
    const n = (SRC.match(new RegExp('\\b' + k + ':', 'g')) || []).length
    assert.equal(n, 2, k + ' 必须中英各一条（实际 ' + n + '）')
  }
  // 403/401 的指引文案里必须给出两条出路（ssh -L 或配 env）
  assert.match(SRC, /ssh -L 7999:127\.0\.0\.1:7999/, '要告诉用户怎么从远程进来')
  assert.match(SRC, /cloudAdminNeedCloud/, '未连云端时只留一句话')
})
