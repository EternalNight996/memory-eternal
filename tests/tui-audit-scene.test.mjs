// TUI 审核场景回归（dsh-tui-plugin/scene.js + lib/api.js 的 /audit/reject）
//
// issue #50 要求点名补齐：reason 可见、批量二次确认、驳回理由（API 侧透传）、位置文本、发布字段。
// 本机没有 dsh-tui 宿主（node_modules 里没有 @deepseek-harness-tui / tuiScenes 运行时），
// 所以这里不做端到端渲染，只做三层验证：
//   1) scene.js 里抽出来的纯函数（真 import、真断言，不是 grep）；
//   2) 源码/契约守卫（确认态接线、API reason 透传、命令 id 与清单一致）；
//   3) 真实路由处理器（createApi + 临时库）：reason 真的写进 audit_log。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AuditScene,
  auditPayload,
  cardMeta,
  confirmLabel,
  positionLabel,
  reasonFlag,
  reasonLine,
} from '../dsh-tui-plugin/scene.js'
import { API_PREFIX, createApi } from '../lib/api.js'
import { ensureVault, writeCard } from '../lib/vault.js'
import { closeAllDb, getDb } from '../lib/db.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFile(path.join(root, rel), 'utf8')

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'me-tui-audit-'))
const newVault = (() => { let n = 0; return () => path.join(tmpRoot, 'vault-' + (++n)) })()
after(async () => {
  closeAllDb()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

const CARD_BODY = (tail) => '# 审核回归卡\n\n这段正文足够长，用于 TUI 审核场景回归测试，不要求真实语义。\n\n' + tail

// ── 1. 纯函数 ────────────────────────────────────────────────────────────────

test('reasonLine / reasonFlag：蒸馏兜底原文卡能被认出来，没 reason 不占行', () => {
  assert.equal(reasonLine({}), '', '没有 reason 必须返回空串（调用方不渲染空行）')
  assert.equal(reasonLine({ reason: '   ' }), '', '纯空白也算没有')
  assert.equal(reasonLine({ reason: 'AI 自动沉淀（蒸馏卡）' }), '依据：AI 自动沉淀（蒸馏卡）')
  const long = 'x'.repeat(300)
  const shown = reasonLine({ reason: long })
  assert.ok(shown.startsWith('依据：') && shown.length < long.length, '超长 reason 要截断')
  assert.ok(shown.endsWith('…'))

  assert.equal(reasonFlag({ reason: 'AI 自动沉淀（原文卡）' }).includes('原文卡'), true, '#50 核心：兜底原文卡要能区分')
  assert.equal(reasonFlag({ reason: 'AI 自动沉淀（蒸馏卡）' }), '')
  assert.equal(reasonFlag({}), '')
})

test('cardMeta：显示 severity，但 info 是默认值不占位置', () => {
  const meta = cardMeta({ kind: 'content', time: '14:05', source: 'agent', severity: 'info' })
  assert.equal(meta, 'content · 14:05 · agent')
  const warn = cardMeta({ kind: 'knowledge', time: '09:00', source: 'cli', severity: 'warning' })
  assert.ok(warn.includes('严重度 warning'), warn)
  assert.ok(cardMeta({ kind: 'content' }).startsWith('content'), '缺字段不炸')
})

test('positionLabel：列表标题的 起-止/总数', () => {
  assert.equal(positionLabel(0, 7, 12), '1-7/12')
  assert.equal(positionLabel(5, 7, 12), '6-12/12', '最后一屏要夹到总数')
  assert.equal(positionLabel(0, 0, 0), '0/0')
  assert.equal(positionLabel(0, 5, 3), '1-3/3')
  assert.equal(positionLabel(-3, 2, 9), '1-2/9', '负 start 夹回 0')
  assert.equal(positionLabel(99, 5, 9), '9-9/9', '越界 start 夹到最后一张')
})

test('confirmLabel / auditPayload：二次确认文案与请求体', () => {
  const approve = confirmLabel('approve', 3)
  assert.ok(approve.includes('确认批准 3 张'), approve)
  assert.ok(approve.includes('Enter') && approve.includes('Esc'), '必须告诉用户怎么确认/取消')

  const reject = confirmLabel('reject', 2, '重复内容')
  assert.ok(reject.includes('驳回 2 张'), reject)
  assert.ok(reject.includes('重复内容'), '驳回态要把已输入理由回显出来')

  assert.deepEqual(auditPayload('approve', 'a.md', '理由会被忽略'), { path: 'a.md' })
  assert.deepEqual(auditPayload('reject', 'b.md', '  内容重复  '), { path: 'b.md', reason: '内容重复' })
  assert.deepEqual(auditPayload('reject', 'c.md'), { path: 'c.md', reason: '' }, '理由可空')
  assert.equal(typeof AuditScene, 'function')
})

// ── 2. 源码/契约守卫（宿主不在本机，只能守接线） ─────────────────────────────

test('scene.js：reason/severity 显示、确认态、驳回理由输入、位置文本都接上了', async () => {
  const src = await read('dsh-tui-plugin/scene.js')
  for (const fn of ['cardMeta(', 'reasonLine(', 'reasonFlag(', 'positionLabel(', 'confirmLabel(', 'auditPayload(']) {
    assert.ok(src.includes(fn), `scene.js 必须调用 ${fn})`)
  }
  assert.ok(src.includes('severity'), '要读 /cards 的 severity')
  assert.ok(src.includes('reason:'), '要读 /cards 的 reason')
  assert.ok(src.includes('setConfirm({ action'), '必须进入确认态，而不是按 a/r 直接提交')
  assert.ok(!/if \(input === 'a'[^\n]*\) \{ void apply/.test(src), '不允许按 a 立即执行旧逻辑')
  assert.ok(src.includes('runConfirm'), 'Enter 提交必须走独立函数')
  assert.ok(/if \(enter\)/.test(src), '确认态必须处理 Enter')
  assert.ok(src.includes("'/audit/' + (action === 'reject' ? 'reject' : 'approve')"), '批准/驳回要打到真实路由')
  assert.ok(src.includes('body: JSON.stringify(auditPayload('), 'reject 必须带 reason 请求体')
  assert.ok(/if \(why\) previewLines\.push\(why\)/.test(src), '没有 reason 时不得 push 空行')
})

test('lib/api.js：/audit/reject 分支透传 reason 且写进 audit_log', async () => {
  const src = await read('lib/api.js')
  const at = src.indexOf("case '/audit/reject': {")
  assert.ok(at >= 0, '找不到 /audit/reject 分支')
  const next = src.indexOf("case '", at + 10)
  const block = src.slice(at, next > 0 ? next : undefined)
  assert.ok(block.includes('readBody(req)'), '要从 POST body 读参数')
  assert.ok(block.includes('body.reason') && block.includes("query.get('reason')"), 'reason 要同时支持 body 与 query')
  assert.ok(block.includes("changedBy: 'user'"), '人工审核的 changed_by 记 user')
  assert.ok(block.includes("setCardStatus(vaultRoot, rel, 'rejected'"), '仍走唯一审核入口 setCardStatus')
  assert.ok(!block.includes('reason: undefined'), '不要给 audit_log 塞 undefined')
})

test('main.js 的命令 id 与 dsh-plugin.json 清单一致', async () => {
  const manifest = JSON.parse(await read('dsh-tui-plugin/dsh-plugin.json'))
  const main = await read('dsh-tui-plugin/main.js')
  const pkg = JSON.parse(await read('dsh-tui-plugin/package.json'))
  const rootPkg = JSON.parse(await read('package.json'))

  assert.equal(manifest.id, pkg.name)
  assert.equal(manifest.name, pkg.name)
  assert.equal(manifest.version, pkg.version, '清单与包版本必须一致')
  assert.equal(pkg.version, rootPkg.version, '子包版本要跟随根包版本')
  assert.equal(manifest.facets.host.entry, 'main.js')
  assert.ok(manifest.requires.contracts.some((c) => c.apiVersion === 'commands.dsh/v1alpha1'))

  const ids = manifest.contributes.commands.map((c) => c.id)
  assert.deepEqual(ids, ['memory-eternal-tui.open', 'memory-eternal-tui.audit'])
  for (const id of ids) assert.ok(main.includes(`'${id}'`), `main.js 未注册 ${id}`)
  assert.ok(main.includes("'memory-eternal-tui-audit'"), '审核场景 id 要与注册代码一致')
  assert.ok(main.includes('AuditScene'), 'main.js 要挂新的 AuditScene')
})

test('发布字段：dsh-tui-plugin/package.json 补齐仓库/主页/发布配置', async () => {
  const pkg = JSON.parse(await read('dsh-tui-plugin/package.json'))
  const rootPkg = JSON.parse(await read('package.json'))
  assert.equal(pkg.name, 'memory-eternal-tui')
  assert.equal(pkg.version, rootPkg.version, '子包版本要跟随根包版本')
  assert.ok(pkg.repository && pkg.repository.url.includes('EternalNight996/memory-eternal'), '缺 repository')
  assert.equal(pkg.repository.directory, 'dsh-tui-plugin')
  assert.ok(pkg.homepage && pkg.homepage.includes('memory-eternal'), '缺 homepage')
  assert.ok(pkg.bugs && pkg.bugs.url.includes('/issues'), '缺 bugs')
  assert.equal(pkg.author, 'EternalNight996')
  assert.equal(pkg.publishConfig && pkg.publishConfig.registry, 'https://registry.npmjs.org/')
  assert.ok(pkg.files.includes('main.js') && pkg.files.includes('scene.js') && pkg.files.includes('dsh-plugin.json'))
  assert.ok(/audit/i.test(pkg.description + ' ' + pkg.keywords.join(' ')), '描述/关键词要能搜到 audit')
})

test('README：装了 dsh-tui 之后怎么用 /audit、键位、reason 从哪来', async () => {
  const md = await read('dsh-tui-plugin/README.md')
  assert.ok(md.includes('/audit'), 'README 必须讲 /audit')
  assert.ok(md.includes('二次确认') || md.includes('确认态'), 'README 要讲二次确认')
  assert.ok(md.includes('Enter') && md.includes('Esc'), 'README 要有确认/取消键位')
  assert.ok(md.includes('理由'), 'README 要讲驳回理由')
  assert.ok(md.includes('原文卡'), 'README 要解释 reason 的兜底原文卡含义')
  assert.ok(md.includes('audit_log'), 'README 要说明理由落到哪里')
  assert.ok(md.includes('dsh plugin --profile dsh-tui add'), 'README 要保留安装命令')
})

// ── 3. 真实路由处理器：reason 真的写进 audit_log ─────────────────────────────

function makeRes() {
  return {
    httpStatus: 0,
    body: null,
    writeHead(status) { this.httpStatus = status },
    end(buf) { this.body = buf && buf.length ? JSON.parse(Buffer.from(buf).toString('utf8')) : null },
  }
}

async function call(vault, route, payload, method = 'GET') {
  const handle = createApi({ vaultDir: () => vault })
  const res = makeRes()
  const raw = payload === undefined ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload))
  const iter = (async function* () { if (raw) yield Buffer.from(raw, 'utf8') })()
  await handle(Object.assign(iter, { url: API_PREFIX + route, method, headers: {} }), res)
  return { httpStatus: res.httpStatus, ...res.body }
}

function lastLog(vault, cardPath) {
  return getDb(vault).prepare('SELECT * FROM audit_log WHERE card_path = ? ORDER BY id DESC LIMIT 1').get(cardPath)
}

test('/audit/reject：body reason 透传到 audit_log（changed_by=user）', async () => {
  const vault = newVault()
  await ensureVault(vault)
  const card = await writeCard(vault, {
    kind: 'content', title: '兜底原文卡', tags: ['raw'], body: CARD_BODY('body 理由'),
    status: 'pending', submittedBy: 'agent', severity: 'info', reason: 'AI 自动沉淀（原文卡）',
  }, { dedup: false })
  assert.equal(card.ok, true)

  const out = await call(vault, '/audit/reject', { path: card.path, reason: '  重复内容，且是降级原文卡  ' }, 'POST')
  assert.equal(out.httpStatus, 200)
  assert.equal(out.ok, true)
  assert.equal(out.status, 'rejected')
  assert.equal(out.reason, '重复内容，且是降级原文卡', '响应回显 reason（已 trim）')

  const log = lastLog(vault, card.path)
  assert.equal(log.new_status, 'rejected')
  assert.equal(log.changed_by, 'user')
  assert.equal(log.reason, '重复内容，且是降级原文卡', 'reason 必须写进 audit_log，不能只停在 HTTP 层')
})

test('/audit/reject：query reason 也支持，缺省 reason 仍能工作', async () => {
  const vault = newVault()
  await ensureVault(vault)
  const a = await writeCard(vault, {
    kind: 'content', title: 'query 理由', tags: [], body: CARD_BODY('query'),
    status: 'pending', submittedBy: 'agent', reason: '',
  }, { dedup: false })
  const viaQuery = await call(vault, `/audit/reject?path=${encodeURIComponent(a.path)}&reason=${encodeURIComponent('内容重复')}`)
  assert.equal(viaQuery.httpStatus, 200)
  assert.equal(viaQuery.reason, '内容重复')
  assert.equal(lastLog(vault, a.path).reason, '内容重复')

  const b = await writeCard(vault, {
    kind: 'content', title: '没理由', tags: [], body: CARD_BODY('no reason'),
    status: 'pending', submittedBy: 'agent', reason: '',
  }, { dedup: false })
  const plain = await call(vault, '/audit/reject', { path: b.path }, 'POST')
  assert.equal(plain.httpStatus, 200, '不传 reason 必须和以前一样能驳回')
  assert.equal(plain.status, 'rejected')
  assert.equal(plain.reason, '')
  const log = lastLog(vault, b.path)
  assert.equal(log.reason, '', '缺省 reason 仍是空串')
  assert.equal(log.changed_by, 'user')

  // 驳回后卡不在待审队列里（状态流转没被 reason 改坏）
  const pending = await call(vault, '/cards?status=pending&limit=10')
  assert.equal(pending.httpStatus, 200)
  assert.ok(!pending.cards.some((c) => c.path === a.path || c.path === b.path))

  const missing = await call(vault, '/audit/reject', {}, 'POST')
  assert.equal(missing.httpStatus, 400, '缺 path 仍是 400')
})

test('/audit/approve 的缺省行为没有被本次改动波及', async () => {
  const vault = newVault()
  await ensureVault(vault)
  const card = await writeCard(vault, {
    kind: 'knowledge', title: '待批卡', tags: [], body: CARD_BODY('approve'),
    status: 'pending', submittedBy: 'agent', reason: 'AI 自动沉淀（蒸馏卡）',
  }, { dedup: false })
  const out = await call(vault, '/audit/approve', { path: card.path }, 'POST')
  assert.equal(out.httpStatus, 200)
  assert.equal(out.status, 'approved')
  const log = lastLog(vault, card.path)
  assert.equal(log.new_status, 'approved')
  assert.notEqual(log.changed_by, 'user', 'approve 分支不在本次范围，changed_by 保持原样')
})

// ── 4. 无宿主 smoke：假 React/ui 跑函数体（不是真实渲染，也不替代端到端） ─────
// 本机没装 @deepseek-harness-tui，真实 TUI 渲染跑不了；这里只保证组件函数体、
// 状态流转与 key 分发不炸，并验证空队列/确认态文案真的到了文本树里。
test('scene 组件 smoke：空队列渲染 + 按 a 进入确认态 + q 退出', () => {
  const store = []
  let cursor = 0
  let captured = null
  let closed = false
  const React = {
    useState(init) {
      const i = cursor++
      if (!(i in store)) store[i] = typeof init === 'function' ? init() : init
      return [store[i], (next) => { store[i] = typeof next === 'function' ? next(store[i]) : next }]
    },
    useEffect() {},
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) } },
  }
  const ui = {
    Box: 'Box',
    Text: 'Text',
    useTerminalSize: () => ({ columns: 100, rows: 30 }),
    useInput: (fn) => { captured = fn },
  }
  const render = () => {
    cursor = 0
    const tree = AuditScene({ React, ui, close: () => { closed = true } })
    const texts = []
    const walk = (node) => {
      if (node == null) return
      if (typeof node === 'string') { texts.push(node); return }
      if (Array.isArray(node)) { node.forEach(walk); return }
      if (node.children) node.children.forEach(walk)
    }
    walk(tree)
    return texts.join('\n')
  }

  const first = render()
  assert.ok(first.includes('待审'), first)
  assert.ok(first.includes('0 张') && first.includes('0/0'), '空队列标题要有位置文本 0/0')
  assert.ok(first.includes('读取中…'), '首次渲染在 load 完成前是读取中，不得崩')

  captured('a', {})
  const afterA = render()
  assert.ok(afterA.includes('没有可操作的卡片'), afterA)

  captured('q', {})
  assert.equal(closed, true, 'q 在列表态退出场景')
})
