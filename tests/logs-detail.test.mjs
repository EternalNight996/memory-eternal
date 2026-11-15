// 日志「操作明细」验收（用户原话：「日志这块完善 操作明细 自动沉淀的卡片标题要有，
// 用户要知道你大概操作了什么，界面美化」）。
//
// 两块日志各有各的毛病：
//   ① 自动沉淀日志（运行状态页 🪵）：只有「模型判定属于已有卡 → 追加更新」这种干巴巴的原因，
//      用户看不出**操作了哪张卡**；
//   ② 操作日志页（activity_log）：详情列没有动作色标、长 IP 撑列、窄屏挤成一团。
//
// 这里既守源码形状（改了文案/忘了加列立刻红），也跑**真实管线**：把宿主假装起来，
// 真的跑一轮自动沉淀 → 从 /capture-log 读回 entry，验证 created / appended 两行都自带标题。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexSrc = readFileSync(path.join(root, 'index.js'), 'utf8')
const clientSrc = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')

// ────────────────────────────────────────────────────────────────────────────
// 一、服务端：每条写卡/追加记录都必须自带「操作了哪张卡」
// ────────────────────────────────────────────────────────────────────────────

test('服务端：每个 created / appended 的 logCapture 都带 title（≥7 处）', () => {
  // 逐行扫调用点：日志调用在源码里是单行，一行里没有 title: 就是漏了
  const lines = indexSrc.split(/\r?\n/)
  const hits = []
  const missing = []
  lines.forEach((line, i) => {
    if (!/logCapture\(/.test(line)) return
    if (!/'(created|appended)'/.test(line)) return
    hits.push(i + 1)
    if (!/\btitle:/.test(line)) missing.push(`${i + 1}: ${line.trim()}`)
  })
  assert.ok(hits.length >= 7, `created/appended 调用点只有 ${hits.length} 处，是不是被合并回去了？`)
  assert.deepEqual(missing, [], '这些写卡日志没写「哪张卡」：\n' + missing.join('\n'))
})

test('服务端：跳过类至少 3 处带 preview（内容太短/冷却/配额/模型判定不值得保存）', () => {
  const lines = indexSrc.split(/\r?\n/)
  const skips = lines.filter((l) => /logCapture\(/.test(l) && /'skip'/.test(l))
  const withPreview = skips.filter((l) => /\bpreview:/.test(l))
  assert.ok(skips.length >= 3, `skip 调用点只有 ${skips.length} 处，守卫失效`)
  assert.ok(withPreview.length >= 3, `只有 ${withPreview.length}/${skips.length} 处跳过记录带 preview —— 用户看不出「本来要处理什么」`)
})

test('服务端：有 shortTitle / cardTitleOf 工具，且理由文案里带「卡片标题」', () => {
  assert.match(indexSrc, /const shortTitle = \(s, n = 48\)/, '缺少 shortTitle（去换行 + 截断）')
  assert.match(indexSrc, /const cardTitleOf = \(x\) => shortTitle\(x\?\.title \|\| x\?\.card\?\.title \|\| x\?\.duplicate\?\.title/, 'cardTitleOf 要能从写卡结果里尽力取标题')
  // 追加 / 新建 / 兜底的 reason 都必须把标题写进去，而不是只留在 title 字段里
  for (const shape of [/追加更新「\$\{[A-Za-z]+\}」/, /原文卡「\$\{[A-Za-z]+\}」/, /新卡「\$\{[A-Za-z]+\}」/]) {
    assert.match(indexSrc, shape, '理由文案要带上卡片标题：' + shape)
  }
  // 反查已存在卡的标题：追加/去重命中的对象是那张旧卡，不是这次的新草稿
  assert.match(indexSrc, /const titleAtPath = async \(root, rel\)/, '缺少 titleAtPath（按路径反查已有卡标题）')
})

test('服务端：日志只存标题与摘要，不落正文全文', () => {
  // preview(text) 截 60 字、shortTitle 默认 48 字；出现 body: 直接进日志就是事故
  const bad = indexSrc.split(/\r?\n/).filter((l) => /logCapture\(/.test(l) && /\bbody:/.test(l))
  assert.deepEqual(bad, [], '日志里不许出现正文：\n' + bad.join('\n'))
})

// ────────────────────────────────────────────────────────────────────────────
// 二、前端：自动沉淀日志表要有「卡片」列 + 动作胶囊 + 卡片可点开
// ────────────────────────────────────────────────────────────────────────────

const captureBlock = (() => {
  const start = clientSrc.indexOf("🪵 {t('captureLog')}")
  assert.ok(start > 0, '找不到自动沉淀日志面板')
  const end = clientSrc.indexOf("t('captureAgentCards')", start)
  assert.ok(end > start, '找不到自动沉淀日志面板的收尾（captureAgentCards）')
  return clientSrc.slice(start, end)
})()

test('前端：自动沉淀日志表出现 e.title 与「卡片」列，且能点开那张卡', () => {
  assert.match(captureBlock, /e\.title/, '标题列必须读 e.title')
  assert.match(captureBlock, /t\('captureColCard'\)/, '缺少「卡片」列表头')
  assert.match(captureBlock, /t\('captureColDetail'\)/, '明细列要改名成「明细」')
  assert.match(captureBlock, /openCaptureCard\(/, '有 path 时点标题要能打开那张卡')
  assert.match(captureBlock, /t\('captureNoCard'\)/, '没有标题也没有摘要的系统行要有兜底文案（不留空列）')
  assert.match(captureBlock, /e\.preview/, '没有标题时退成内容摘要')
  assert.match(clientSrc, /onOpenCard=\{openCard\}/, 'LibraryAdmin 要拿到 openCard（否则点标题没反应）')
  assert.match(clientSrc, /const openCaptureCard = \(path, title\)/, '需要把点击转成 openCard({ path, title })')
})

test('前端：动作胶囊用令牌色调（不写死 hex），两块日志同一套配色', () => {
  const actions = clientSrc.slice(clientSrc.indexOf('const CAPTURE_ACTIONS = {'), clientSrc.indexOf('const ZOMBIE_ART'))
  assert.ok(actions.length > 100, '找不到 CAPTURE_ACTIONS')
  assert.doesNotMatch(actions, /#[0-9a-fA-F]{3,6}\b/, 'CAPTURE_ACTIONS 里不许再有硬编码 hex')
  for (const tone of ['ok', 'info', 'warn', 'bad', 'mute']) {
    assert.match(actions, new RegExp("'" + tone + "'"), '缺少色调 ' + tone)
  }
  assert.match(clientSrc, /const LOG_ACTION_TONES = \{/, '操作日志页的动作色调映射')
  assert.match(clientSrc, /const logTone = \(action\) =>/, '两块日志要共用 logTone（同一动作同一颜色）')
  for (const cls of ['mc-logpill--ok', 'mc-logpill--info', 'mc-logpill--warn', 'mc-logpill--bad', 'mc-logpill--mute']) {
    assert.match(clientSrc, new RegExp('\\.' + cls + '\\s*\\{'), '缺少胶囊样式 .' + cls)
  }
})

test('前端：表头粘性 + 行 hover + 明细最多两行 + ≤720px 两行卡片', () => {
  assert.match(clientSrc, /\.mc-logtable thead th \{[^}]*position: sticky/, '表头要粘性')
  assert.match(clientSrc, /\.mc-logtable tbody tr:hover td \{ background:/, '自动沉淀日志行要 hover')
  assert.match(clientSrc, /\.mc-logdetail \{[^}]*-webkit-line-clamp: 2/, '长明细最多两行（完整内容放 title）')
  assert.match(clientSrc, /\.mc-logrow:hover \{ background:/, '操作日志行要 hover')
  // 窄屏：时间 + 动作 + 标题一行，智能体 · IP 第二行，不许横向溢出
  assert.match(clientSrc, /grid-template-areas: "time action title" "agent agent ip"/, '≤720px 要退化成两行卡片')
  assert.match(clientSrc, /\.mc-logip \{ color: var\(--me-c-text-dim/, 'IP 列要有自己的样式（中间省略）')
  assert.match(clientSrc, /const midEllipsis = \(s, head = 8, tail = 5\)/, '长 IP 要中间省略')
})

test('前端：两块日志的列头/兜底文案中英各一条（数量一致）', () => {
  const zh = clientSrc.slice(clientSrc.indexOf('export const ZH = {'), clientSrc.indexOf('export const EN = {'))
  const en = clientSrc.slice(clientSrc.indexOf('export const EN = {'), clientSrc.indexOf('const isOtherTypeLabel'))
  assert.ok(zh.length > 1000 && en.length > 1000, '中英两份文案表都应当能找到')
  const keys = [
    'logsColCard', 'logsColDetail', 'logsNoTitle',
    'captureColTime', 'captureColAction', 'captureColCard', 'captureColDetail',
    'captureNoCard', 'captureContentHint',
    'captureAction_boot', 'captureAction_listen', 'captureAction_created',
    'captureAction_appended', 'captureAction_skip', 'captureAction_warn', 'captureAction_fail',
  ]
  const countOf = (block, key) => (block.match(new RegExp('^\\s*' + key + ':', 'gm')) || []).length
  const problems = []
  for (const k of keys) {
    const a = countOf(zh, k)
    const b = countOf(en, k)
    if (a !== 1) problems.push('zh 的 ' + k + ' 出现 ' + a + ' 次')
    if (b !== 1) problems.push('en 的 ' + k + ' 出现 ' + b + ' 次')
  }
  assert.deepEqual(problems, [], '中英文案缺一个都算没做完：\n' + problems.join('\n'))
})

// ────────────────────────────────────────────────────────────────────────────
// 三、真管线：跑一轮自动沉淀，读回 /capture-log，验证 created / appended 自带标题
// ────────────────────────────────────────────────────────────────────────────

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-logs-detail-'))
process.env.DSH_HOME = tmpHome

const { Config, apply } = await import('../index.js')
const { closeAllDb } = await import('../lib/db.js')

const harnesses = []
after(async () => {
  for (const h of harnesses) h.disposeAll()
  closeAllDb()
  await fs.rm(tmpHome, { recursive: true, force: true })
})

function resolveConfig(raw) {
  const result = Config['~standard'].validate(raw)
  assert.ok(!result.issues, 'Config 默认值应能通过校验')
  return result.value
}

function formsService(entryId, state) {
  return {
    writable: true,
    describe: () => [{ ns: entryId, autoGenerate: true, schema: null, value: state.live, revision: state.revision }],
    configure() { return () => {} },
    async update() { },
    async replace() { }, async mutate() { },
  }
}

/** 最小的宿主假件：只要路由 + 事件钩子，够跑通「收尾 → 沉淀 → 写卡 → 日志」。 */
function makeHarness() {
  const live = resolveConfig({
    autoWeb: false,
    watchdogAutoSpawn: false,
    autoMcpSetup: false,
    autoRecall: false,
    // 关掉蒸馏：走零成本「原文卡」路径，不需要 LLM，也不烧 token
    distillEnabled: false,
    auditMode: 'none',
    captureCooldownMs: 0,
    captureMinChars: 60,
  })
  const state = { live, revision: 1, routes: [], sections: [], listeners: new Map(), effects: [] }
  const services = {
    settings: formsService('memory-eternal', state),
    systemPrompt: { section(spec) { state.sections.push(spec); return () => {} } },
    webServer: { register(route) { state.routes.push(route); return () => {} } },
  }
  const ctx = {
    fiber: { entry: { options: { id: 'memory-eternal' } } },
    get: (n) => services[n],
    inject(names, callback) { callback(ctx); return () => {} },
    ...services,
    on(name, fn) {
      if (!state.listeners.has(name)) state.listeners.set(name, new Set())
      state.listeners.get(name).add(fn)
      return () => state.listeners.get(name)?.delete(fn)
    },
    off(name, fn) { state.listeners.get(name)?.delete(fn) },
    emit(name, ...args) { for (const fn of [...(state.listeners.get(name) ?? [])]) fn(...args) },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') state.effects.push(dispose); return dispose },
  }
  const h = {
    ctx, state, live,
    disposeAll: () => { for (const d of state.effects.splice(0)) { try { d() } catch { /* 已卸载 */ } } },
  }
  harnesses.push(h)
  return h
}

function fakeRes() {
  const chunks = []
  return {
    req: { headers: {} },
    status: 0,
    writeHead(status) { this.status = status },
    end(body) { if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body))) },
    json() { return JSON.parse(Buffer.concat(chunks).toString('utf8')) },
  }
}
const fakeGet = (url) => ({ method: 'GET', url, headers: {} })

async function apiGet(h, sub) {
  const route = h.state.routes.find((r) => r.path === '/memory-eternal/api' && r.kind === 'prefix')
  assert.ok(route, '应注册 /memory-eternal/api 前缀路由')
  const res = fakeRes()
  await route.handler(fakeGet('/memory-eternal/api' + sub), res)
  assert.equal(res.status, 200, 'GET ' + sub + ' 应返回 200')
  return res.json()
}

async function waitEntries(h, pred, timeoutMs = 8000) {
  const t0 = Date.now()
  let entries = []
  while (Date.now() - t0 < timeoutMs) {
    const data = await apiGet(h, '/capture-log')
    entries = data.entries || []
    if (pred(entries)) return entries
    await new Promise((r) => setTimeout(r, 40))
  }
  return entries
}

const TURN_TEXT = [
  '用户：日志这块完善一下操作明细，自动沉淀的卡片标题要有，用户要知道你大概操作了什么。',
  '助手：可以分三处改：服务端 logCapture 带上 title 与 preview；自动沉淀日志表加「卡片」列；',
  '操作日志页把动作做成胶囊并支持窄屏两行卡片。服务端要能从写卡结果里取标题，',
  '追加/去重命中时按路径反查已有卡的标题，取不到就退成正文摘要兜底。',
].join('\n')

const agentWith = (sessionId, text) => ({
  id: sessionId,
  workspace: tmpHome,
  session: {
    id: sessionId,
    header: { cwd: tmpHome },
    events: [
      { seq: 0, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } },
      { seq: 1, type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: '好的，按三处改。' }] } },
    ],
  },
})

test('真管线：写卡成功的那一行自带卡片标题与内容摘要，并且能顺着 path 找到那张卡', async () => {
  const h = makeHarness()
  apply(h.ctx, h.live)
  h.ctx.emit('agent/turn-stopping', { agent: agentWith('sess-logs-created', TURN_TEXT) })

  const entries = await waitEntries(h, (list) => list.some((e) => e.action === 'created' && e.path))
  const created = entries.find((e) => e.action === 'created' && e.path)
  assert.ok(created, '应当有一次 created 记录：\n' + JSON.stringify(entries.slice(0, 5), null, 2))

  assert.ok(String(created.title || '').trim(), 'created 必须带卡片标题（不能只剩一句「原文卡」）')
  assert.ok(String(created.title).length <= 48, '标题要截断，别把整段正文塞进日志')
  assert.ok(!/\n/.test(String(created.title)), '标题里的换行要压掉')
  assert.match(created.reason, /「/, '理由文案里也要有标题，不然列表里仍看不出是哪张卡')
  assert.ok(created.reason.includes(created.title), '理由里的标题要与 title 字段一致')
  assert.ok(String(created.preview || '').trim(), 'created 需要内容摘要（preview）')
  assert.ok(String(created.preview).length <= 60, '摘要只存开头，不落正文')

  // 顺着 path 真的能读到那张卡（标题不是凭空编的）
  const card = await apiGet(h, '/card?path=' + encodeURIComponent(created.path))
  assert.equal(card.ok, true, '日志里的 path 应当能打开对应的卡')
  assert.ok(String(card.text || '').includes(String(created.title).replace(/…$/, '').slice(0, 8)), '卡片标题与日志标题应当对得上')
})

test('真管线：去重命中的那一行指向**已有那张卡**，标题不是这次的新草稿', async () => {
  const h = makeHarness()
  apply(h.ctx, h.live)
  // 同一会话、同一段内容写两遍：第二遍必然命中内容去重 → appended
  h.ctx.emit('agent/turn-stopping', { agent: agentWith('sess-logs-append', TURN_TEXT) })
  const first = await waitEntries(h, (list) => list.some((e) => e.action === 'created' && e.path))
  const created = first.find((e) => e.action === 'created' && e.path)
  assert.ok(created, '第一轮应当写卡成功')

  // 改动一个字符让内容「几乎相同」（近似命中），模拟真实的一轮补充对话
  h.ctx.emit('agent/turn-stopping', { agent: agentWith('sess-logs-append', TURN_TEXT + '。') })
  const entries = await waitEntries(h, (list) => list.some((e) => e.action === 'appended'))
  const appended = entries.find((e) => e.action === 'appended')
  assert.ok(appended, '第二轮应当命中去重并追加：\n' + JSON.stringify(entries.slice(0, 5), null, 2))
  assert.ok(String(appended.title || '').trim(), 'appended 必须带标题（否则用户只看到「追加更新」）')
  assert.match(appended.reason, /追加更新「/, '追加的理由要写成「追加更新「标题」（原因）」')
  assert.ok(appended.reason.includes(appended.title), '理由里的标题要与 title 字段一致')
  assert.equal(appended.path, created.path, '追加的对象是同一张卡')
})
