// issue #21 / #22 / #23 / #24 回归：四个都属「看起来正常、其实静默错位」的一类，所以钉死「可见性」。
//   #21 settings.update 抛错（宿主守卫误报）时回读确认，不得把已生效的改动标成失败
//   #22 GET /cards?status=deleted 必须列回收站；未知 status 必须回显（不再静默回落成 approved）
//   #23 restart 的端口兜底：锁里没登记的旧 web 也要能被发现（并能按需收掉）
//   #24 字符串里的裸控制字符要能修复成卡；解析失败要带出 JSON.parse 原始报错与首尾现场
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApi, API_PREFIX } from '../lib/api.js'
import { closeAllDb } from '../lib/db.js'
import { ensureVault, writeCard, deleteCard, listCards } from '../lib/vault.js'
import { patchApplied, applyPatchVerified, waitPendingOutcome, writePendingConfig, clearPendingConfig } from '../lib/config-sync.js'
import { parseCaptureJson, parseCaptureJsonDetailed, looksTruncatedJson, describeOutputExcerpt, maxTokenLadder, summarizeTurnDetailed } from '../lib/capture.js'
import { parseLsofFields, looksLikeOurWeb, findPortListener, probeServedVersion, waitForServedVersion, stopWatchdogs, acquireWatchdogLock, updateWatchdogSlot, readWatchdogLock } from '../lib/watchdog.js'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'me-issues2-'))
after(async () => {
  // 本文件开了多个库（每张卡一个 vault）→ 先全部关掉再删目录，否则 Windows 上 EBUSY
  try { closeAllDb() } catch { /* 已关闭 */ }
  await fs.rm(tmpRoot, { recursive: true, force: true })
})
let seq = 0
const newVault = () => path.join(tmpRoot, 'vault-' + (++seq))

const CARD_BODY = (tail) => `# 正文标题\n\n这一段是给写入校验用的正文，内容本身没有意义，只要求足够长。\n\n${tail}`

// ---- 真实路由处理器驱动（假 req/res，够 json() 用） ----------------------------
function makeRes() {
  return {
    httpStatus: 0, body: null,
    writeHead(status) { this.httpStatus = status },
    end(buf) { this.body = JSON.parse(Buffer.from(buf).toString('utf8')) },
  }
}
async function call(root, route, payload, method = 'GET') {
  const handle = createApi({ vaultDir: () => root })
  const res = makeRes()
  const raw = payload === undefined ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload))
  const iter = (async function* () { if (raw) yield Buffer.from(raw, 'utf8') })()
  await handle(Object.assign(iter, { url: `${API_PREFIX}${route}`, method, headers: {} }), res)
  return { httpStatus: res.httpStatus, ...res.body }
}

// ============================ #22 /cards 的 status ============================
test('#22 /cards?status=deleted 列的是回收站，不再是主库', async () => {
  const root = newVault()
  await ensureVault(root)
  const keep = await writeCard(root, { kind: 'knowledge', title: '保留卡', tags: ['x'], body: CARD_BODY('保留卡专属内容。'), status: 'approved' }, { dedup: false })
  const gone = await writeCard(root, { kind: 'knowledge', title: '待删卡', tags: ['x'], body: CARD_BODY('待删卡专属内容。'), status: 'approved' }, { dedup: false })
  assert.equal(keep.ok, true)
  await deleteCard(root, gone.path)

  const deleted = await call(root, '/cards?status=deleted&limit=10')
  assert.equal(deleted.httpStatus, 200)
  assert.equal(deleted.appliedStatus, 'deleted', '生效的 status 要回显，调用方能自检')
  assert.equal(deleted.total, 1, '回收站里只有 1 张')
  assert.deepEqual(deleted.cards.map((c) => c.path), [gone.path])
  assert.ok(deleted.cards.every((c) => c.status === 'deleted'))

  // 同一个 status 在 /recycle/list 上一直是好的 —— 两个端点的数字必须对得上
  const recycle = await call(root, '/recycle/list')
  assert.equal(recycle.items.length, deleted.total, '/cards 与 /recycle/list 的数量不得打架')

  const all = await call(root, '/cards?status=all&limit=10')
  assert.ok(!all.cards.some((c) => c.path === gone.path), 'status=all 仍应排除回收站')
  assert.equal(all.appliedStatus, 'all')
})

test('#22 /cards 未知 status 不再静默：回显 requestedStatus + unknownStatus', async () => {
  const root = newVault()
  await ensureVault(root)
  await writeCard(root, { kind: 'knowledge', title: '主库卡', tags: [], body: CARD_BODY('主库卡内容。'), status: 'approved' }, { dedup: false })
  const r = await call(root, '/cards?status=deleted2&limit=5')
  assert.equal(r.httpStatus, 200)
  assert.equal(r.appliedStatus, 'approved', '回落行为保留（不破坏老调用方）')
  assert.equal(r.requestedStatus, 'deleted2')
  assert.equal(r.unknownStatus, true, '必须显式告诉调用方「你的参数被忽略了」')
  const ok = await call(root, '/cards?status=approved&limit=5')
  assert.equal(ok.unknownStatus, false)
})

// ============================ #24 裸控制字符 ==================================
const NL = String.fromCharCode(10)
const RAW_JSON = '{"save": true, "title": "DSH 插件装机后需重启生效", "kind": "tool", ' +
  '"tags": ["DSH","plugin"], "body": "# 标题' + NL + NL + '正文第一段' + NL + '- 要点一' + NL + '- 要点二"}'

test('#24 字符串里有裸换行的输出：旧路径必然失败，现在能修成卡', () => {
  // 先确认这就是 issue 里的形态：括号闭合（所以不会有「疑似截断」提示），但 JSON.parse 必拒
  assert.equal(looksTruncatedJson(RAW_JSON), false)
  assert.throws(() => JSON.parse(RAW_JSON), /control character|Unexpected token/i)

  const detailed = parseCaptureJsonDetailed(RAW_JSON)
  assert.equal(detailed.parsed, true, '修复后必须解析成功')
  assert.equal(detailed.repaired, true, '要能区分「走了容错路径」')
  assert.equal(detailed.card.save, true)
  assert.equal(detailed.card.title, 'DSH 插件装机后需重启生效')
  assert.ok(detailed.card.body.includes(NL + '- 要点一'), '正文里的换行与列表要原样还原')
  assert.equal(parseCaptureJson(RAW_JSON).title, 'DSH 插件装机后需重启生效', '旧签名也要能用')
})

test('#24 合法输出不被误判为「修复过」；真截断仍然失败', () => {
  const legit = JSON.stringify({ save: true, title: '合法卡标题', kind: 'knowledge', tags: [], body: '# 合法卡标题' + NL + NL + '这是用 JSON.stringify 正确转义的正文，足够长以通过校验。' })
  const d1 = parseCaptureJsonDetailed(legit)
  assert.equal(d1.repaired, false, '没动过字符就不该标 repaired')
  assert.equal(d1.card.title, '合法卡标题')

  // 字符串外的换行是合法 JSON 空白，不碰
  const pretty = '{\n  "save": true,\n  "title": "美化输出卡",\n  "kind": "knowledge",\n  "tags": [],\n  "body": "美化输出卡的正文内容，长度足够通过写入校验，用于验证字符串外的换行不会被改写。"\n}'
  const d2 = parseCaptureJsonDetailed(pretty)
  assert.equal(d2.repaired, false)
  assert.equal(d2.card.title, '美化输出卡')

  // 真截断（括号没闭合）不能被「修复」成卡
  const torn = '{"save": true, "title": "半截标题", "kind": "tool", "body": "正文还没写完'
  assert.equal(looksTruncatedJson(torn), true)
  const d3 = parseCaptureJsonDetailed(torn)
  assert.equal(d3.card, null)
  assert.equal(d3.parsed, false)
  assert.ok(d3.error.length > 0, '失败要把 JSON.parse 的原始报错带出来')
})

test('#24 制表符 / 回车等控制字符同样修复', () => {
  const TAB = String.fromCharCode(9)
  const CR = String.fromCharCode(13)
  const raw = '{"save": true, "title": "控制字符卡", "kind": "knowledge", "tags": [], "body": "# 控制字符卡' + TAB + '正文' + CR + '第二行内容，长度足够通过校验。"}'
  const d = parseCaptureJsonDetailed(raw)
  assert.equal(d.parsed, true)
  assert.equal(d.repaired, true)
  assert.ok(d.card.body.includes(TAB) && d.card.body.includes(CR), '制表符 / 回车要还原成原字符')
})

test('#24 失败现场：首尾都留、并带出 JSON.parse 原始报错', () => {
  const long = 'H'.repeat(300) + '关键结尾'
  const ex = describeOutputExcerpt(long)
  assert.ok(ex.startsWith('H'.repeat(120)))
  assert.ok(ex.endsWith('关键结尾'), '结尾必须留着（旧实现只留前 160 字）')
  assert.match(ex, /中间省略 \d+ 字/)
  assert.equal(describeOutputExcerpt('短文本'), '短文本')
})

test('#24 summarizeTurnDetailed：解析失败时 message 带原始报错与首尾现场', async () => {
  // 用一段「修复也救不回来」的输出：字符串里有裸引号 + 括号闭合
  const broken = '{"save": true, "title": "带引号的卡", "kind": "knowledge", "tags": [], "body": "正文里引用了 "某段代码" 却没有转义，长度足够长用于触发解析失败。"}'
  const llm = { async *stream() { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: broken }; yield { type: 'finish', reason: { kind: 'stop' } } } }
  // 对话必须够长：<120 字会被早退成 { skip:'too-short' }（那是另一条路径，与本测试无关）
  const conv = [
    '用户：帮我梳理一下 SQLite 图谱缓存的失效策略',
    '助手：可以分三步：',
    '- 第一步：写卡或审核后立即让指纹失效，避免读到陈旧图谱',
    '- 第二步：服务端做 60 秒 TTL 兜底，防止极端情况下反复重建',
    '- 第三步：冷启动时用 brotli 压缩传输，把 3.5MB 的载荷压到 160KB 左右',
    '另外要注意 pending 卡不能进缓存，审核状态翻转会让缓存永久失真，必须排除。',
  ].join('\n')
  const r = await summarizeTurnDetailed(llm, { provider: 'p', model: 'm' }, conv)
  assert.equal(r.card, undefined)
  assert.equal(r.failure.code, 'UNPARSEABLE_OUTPUT')
  assert.match(r.failure.message, /JSON\.parse 原始报错/, '原始报错必须可见（#24 的第二个缺陷）')
})

test('#24 maxTokenLadder：一路翻倍到 schema 上限，不再只翻一次', () => {
  assert.deepEqual(maxTokenLadder(1200, 4000), [2400, 4000])
  assert.deepEqual(maxTokenLadder(1200, 2400), [2400])
  assert.deepEqual(maxTokenLadder(4000, 4000), [], '已在上限就不再重试')
  assert.deepEqual(maxTokenLadder(0, 8000), [4000, 8000], 'start 缺省时按 DEFAULT_CAPTURE_MAX_TOKENS=2000 起算')
})

// ============================ #23 端口兜底与自检 ==============================
test('#23 parseLsofFields：解析 lsof -Fpcn 输出', () => {
  const text = ['p40433', 'cnode', 'n127.0.0.1:7999', 'p1', 'claunchd', 'n*:7999'].join('\n')
  const list = parseLsofFields(text)
  assert.deepEqual(list.map((p) => p.pid), [40433, 1])
  assert.equal(list[0].command, 'node')
  assert.equal(list[0].name, '127.0.0.1:7999')
  assert.deepEqual(parseLsofFields(''), [])
})

test('#23 looksLikeOurWeb：只收本插件自己的 web，别人的 web.js 不许误杀', () => {
  // ① 安装路径里带包名 → 认（npm / pnpm store / 开发目录都含 memory-eternal）
  assert.equal(looksLikeOurWeb('node /opt/x/memory-eternal/lib/web.js --port 7999'), true)
  assert.equal(looksLikeOurWeb('"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\.dsh\\profiles\\web\\node_modules\\memory-eternal\\lib\\web.js --port 7999'), true)
  // ② 带本插件自己的 lib/web.js 绝对路径（大小写 / 斜杠方向都不敏感）
  assert.equal(looksLikeOurWeb('node E:/Dev/plug/lib/web.js --port 7999', { webJs: 'E:\\Dev\\plug\\lib\\web.js' }), true)
  // ③ 别人的 web.js：命令行里同样有 web.js，但既不是我们的路径、也不含包名 → 必须 false
  //    （否则 restart 会误杀恰好占着该端口的外来进程）
  assert.equal(looksLikeOurWeb('node /opt/x/lib/web.js --port 7999'), false)
  assert.equal(looksLikeOurWeb('node C:\\other\\project\\web.js'), false)
  assert.equal(looksLikeOurWeb('/usr/sbin/nginx: worker process'), false)
  assert.equal(looksLikeOurWeb(''), false)
})

test('#23 findPortListener：两个平台都能从注入的 exec 拿到占用者', async () => {
  const fakeExec = async (cmd, args) => {
    if (cmd === 'powershell') {
      const script = String(args[args.length - 1])
      return script.includes('OwningProcess') ? '40433\r\n' : 'node C:\\x\\lib\\web.js --port 7999\r\n'
    }
    if (cmd === 'lsof') return 'p40433\ncnode\nn127.0.0.1:7999'
    return ''
  }
  const found = await findPortListener(7999, { exec: fakeExec })
  assert.equal(found.pid, 40433)
  assert.match(found.command, /web\.js/)
  const none = await findPortListener(7999, { exec: async (cmd, args) => (cmd === 'powershell' ? '' : '') })
  assert.equal(none, null)
  assert.equal(await findPortListener(0, { exec: fakeExec }), null)
})

test('#23 probeServedVersion：问的是端口上真正服务的进程版本', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith(API_PREFIX + '/overview')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, vaultDir: '/x', version: '0.0.0-test' }))
      return
    }
    res.writeHead(404); res.end('{}')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    assert.equal(await probeServedVersion(port), '0.0.0-test')
  } finally {
    await new Promise((r) => srv.close(r))
  }
})

test('#23 waitForServedVersion：等到版本对上才算通过', async () => {
  let n = 0
  const ok = await waitForServedVersion(7999, '1.2.3', { timeoutMs: 500, intervalMs: 5, probeFn: async () => (++n < 3 ? '1.0.0' : '1.2.3') })
  assert.equal(ok.ok, true)
  assert.equal(ok.version, '1.2.3')
  const bad = await waitForServedVersion(7999, '9.9.9', { timeoutMs: 30, intervalMs: 5, probeFn: async () => '1.0.0' })
  assert.equal(bad.ok, false)
  assert.equal(bad.version, '1.0.0')
})

test('#23 stopWatchdogs：锁里没登记的端口占用者也能被发现（并可收掉）', async () => {
  const envS = { DSH_HOME: path.join(tmpRoot, 'wd-port') }
  acquireWatchdogLock({ env: envS, port: 7999, pid: 11111, pkgVersion: '0.10.2' })
  const alive = new Set([11111, 22222])
  const killed = []
  const out = await stopWatchdogs({
    env: envS,
    port: 7999,
    checkPort: true,
    forcePortOccupant: true,
    timeoutMs: 1,
    isAlive: (pid) => alive.has(Number(pid)),
    kill: (pid) => { killed.push(Number(pid)); alive.delete(Number(pid)); return true },
    sleep: async () => {},
    listProcesses: async () => [],   // 锁里的 webPid 查不到 → 旧实现会漏掉这个旧 web
    findListener: async () => (alive.has(22222) ? { pid: 22222, command: 'node /opt/x/memory-eternal/lib/web.js --port 7999' } : null),
  })
  assert.deepEqual(out.stopped, [11111])
  assert.deepEqual(out.portOwners.map((o) => o.pid), [22222], '要按端口找出「锁里没登记」的旧 web')
  assert.deepEqual(out.portStopped, [22222], '本插件的旧 web 要一起收掉')
  assert.deepEqual(out.warnings, [], '收干净了就不该留告警')
  assert.deepEqual(killed, [11111, 22222])
  assert.deepEqual(readWatchdogLock(envS).watchdogs, [])
})

test('#23 stopWatchdogs：不是本插件的进程只告警、不动手', async () => {
  const envF = { DSH_HOME: path.join(tmpRoot, 'wd-foreign') }
  acquireWatchdogLock({ env: envF, port: 7999, pid: 11111, pkgVersion: '0.10.2' })
  const alive = new Set([11111, 33333])
  const killed = []
  const out = await stopWatchdogs({
    env: envF,
    port: 7999,
    checkPort: true,
    forcePortOccupant: true,
    timeoutMs: 1,
    isAlive: (pid) => alive.has(Number(pid)),
    kill: (pid) => { killed.push(Number(pid)); return true },
    sleep: async () => {},
    listProcesses: async () => [],
    findListener: async () => ({ pid: 33333, command: '/usr/sbin/nginx: worker process' }),
  })
  assert.deepEqual(out.portStopped, [], '非本插件的进程绝不能自动杀')
  assert.deepEqual(killed, [11111], '只停了看门狗自己')
  assert.ok(out.warnings.some((w) => w.includes('33333')), '要留一条可诊断的告警')
})

test('#23 stopWatchdogs：要收却没收的 web 必须留一行告警（不再静默）', async () => {
  const envK = { DSH_HOME: path.join(tmpRoot, 'wd-skipped') }
  acquireWatchdogLock({ env: envK, port: 7999, pid: 11111, pkgVersion: '0.10.2' })
  updateWatchdogSlot({ env: envK, pid: 11111, patch: { webPid: 22222, webPort: 7999 } })
  const alive = new Set([11111, 22222])
  const out = await stopWatchdogs({
    env: envK, port: 7999, timeoutMs: 1,
    isAlive: (pid) => alive.has(Number(pid)),
    kill: (pid) => { alive.delete(Number(pid)); return true },
    sleep: async () => {},
    listProcesses: async () => [],   // 枚举不到 → 按「防 pid 复用误杀」原则不杀
  })
  assert.deepEqual(out.webStopped, [], '没确认到就不该杀')
  assert.ok(out.skipped.includes(22222))
  assert.ok(out.warnings.some((w) => w.includes('22222')), '要留一条能解释「为什么没杀」的告警')
})

test('#23 stopWatchdogs：checkPort 关闭时不做端口探测（老行为不变）', async () => {
  const envQ = { DSH_HOME: path.join(tmpRoot, 'wd-quiet') }
  acquireWatchdogLock({ env: envQ, port: 7999, pid: 11111 })
  let probed = 0
  const out = await stopWatchdogs({
    env: envQ, port: 7999, timeoutMs: 1,
    isAlive: (pid) => Number(pid) === 11111,
    kill: () => true,
    sleep: async () => {},
    listProcesses: async () => [],
    findListener: async () => { probed++; return null },
  })
  assert.equal(probed, 0)
  assert.deepEqual(out.portOwners, [])
  assert.deepEqual(out.warnings, [])
})

// ============================ #21 配置回读确认 ================================
test('#21 patchApplied：全中才算已生效', () => {
  assert.equal(patchApplied({ a: 1, b: ['x'] }, { a: 1, b: ['x'] }), true)
  assert.equal(patchApplied({ a: 1, b: ['x'] }, { a: 1, b: ['y'] }), false, '数组不同不算生效')
  assert.equal(patchApplied({ a: 1 }, { a: 1, b: 2 }), false, '少一个键就不算')
  assert.equal(patchApplied({ a: 1 }, {}), false)
  assert.equal(patchApplied({}, {}), false, '空 patch 不构成「已生效」')
  assert.equal(patchApplied(null, { a: 1 }), false)
})

test('#21 applyPatchVerified：抛错但回读已生效 → 按成功处理（不再重试到 dropped）', async () => {
  let config = { auditExemptKinds: [] }
  const repaired = []
  const r = await applyPatchVerified({ auditExemptKinds: ['project'] }, {
    // 真实场景：dsh-tui 守卫在 settings.update 内部的 describe() 上抛，但写入已经落库
    apply: () => { config = { auditExemptKinds: ['project'] }; throw new Error('dsh-tui: root.events.emit is unavailable from a plugin activation') },
    read: () => config,
    delayMs: 1,
    onRepaired: (e) => repaired.push(String(e.message)),
  })
  assert.deepEqual(r, { applied: true, repaired: true })
  assert.equal(repaired.length, 1, '守卫误报要被记一笔，便于上游修复后回收这条兜底')

  // 真失败（回读对不上）必须原样抛出，交给上层重试 / 上报
  await assert.rejects(() => applyPatchVerified({ auditExemptKinds: ['tool'] }, {
    apply: () => { throw new Error('boom') },
    read: () => ({ auditExemptKinds: [] }),
    delayMs: 1,
  }), /boom/)
})

test('#21 waitPendingOutcome：分清「已应用 / 排队中 / 已放弃」', async () => {
  const env = { DSH_HOME: path.join(tmpRoot, 'pending-home') }
  await fs.mkdir(env.DSH_HOME, { recursive: true })
  clearPendingConfig(env)
  assert.equal(await waitPendingOutcome(env, { timeoutMs: 20, intervalMs: 5 }), 'applied')
  writePendingConfig(env, { a: 1 })
  assert.equal(await waitPendingOutcome(env, { timeoutMs: 20, intervalMs: 5 }), 'queued', 'DSH 没跑时是「排上队了」，不是「已应用」')
  writePendingConfig(env, { a: 1 }, Date.now(), 5, { dropped: true, lastError: 'root.events.emit is unavailable' })
  assert.equal(await waitPendingOutcome(env, { timeoutMs: 20, intervalMs: 5 }), 'failed')
  clearPendingConfig(env)
})

test('#21 独立 Web 端 POST /config：不再无条件声称「已应用」', async () => {
  const root = newVault()
  const home = path.join(tmpRoot, 'pending-api')
  await fs.mkdir(home, { recursive: true })
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const handle = createApi({ vaultDir: () => root })
    const res = makeRes()
    const payload = JSON.stringify({ patch: { auditExemptKinds: ['project'] }, expectedRevision: 0 })
    const iter = (async function* () { yield Buffer.from(payload, 'utf8') })()
    // 这个 DSH_HOME 里没有任何宿主心跳（等价于 Codex / 只跑 dsh-memory serve）：
    // v0.10.5 起不再回「等下次启动生效」那种空头承诺，而是直接写共享配置（见 issue-fixes-3）。
    // 宿主活着时仍然只写 pending —— 那一路由 issue-fixes-3 覆盖。
    await handle(Object.assign(iter, { url: API_PREFIX + '/config', method: 'POST', headers: {} }), res)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.pendingOutcome, 'applied-direct')
    assert.equal(res.body.appliedDirect, true)
    assert.match(res.body.note, /直接写入共享配置/)
    assert.deepEqual(res.body.pending, [], '已直写就不该再留在待应用里')
    const shared = JSON.parse(await fs.readFile(path.join(home, 'memory-eternal-config.json'), 'utf8'))
    assert.deepEqual(shared.auditExemptKinds, ['project'], '共享配置必须真的被改到')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }
})
