// #54 回归：tools 服务可能晚于插件 apply 挂载（DSH 0.1.7-rc.2 实测），
// memory_recall / memory_note 必须仍能注册；而 /diagnostics 只能报**真实**注册结果
// （注册失败说成 registered 比静默更糟 —— 用户会照着“已注册”去查别的原因）。
//
// 覆盖三种时序：
//   1) 快路径：apply 时 tools 就绪 → 同步注册两个工具；
//   2) 晚到：apply 时 tools 未就绪 → ctx.inject(['tools']) 就绪后补注册，且只补一次；
//   3) 注册抛错：异常不打断宿主，诊断显示 MISSING，沉淀日志留 fail。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-issue54-'))
process.env.DSH_HOME = tmpHome

const { Config, apply } = await import('../index.js')
const { closeAllDb } = await import('../lib/db.js')

// 断言失败时插件里的 setInterval 可能把进程挂住 —— 统一兜底释放。
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

/** dsh ≥0.1.7 形状的 settings 服务（表单 API，没有 register）。 */
function formsService(entryId, state) {
  return {
    writable: true,
    describe: () => [{ ns: entryId, autoGenerate: true, schema: null, value: state.live, revision: state.revision }],
    configure() { return () => {} },
    async update() { },
    async replace() { }, async mutate() { },
  }
}

/**
 * 造一个假 ctx：services 里没有 tools 时，inject(['tools'], cb) 先排队，
 * 等 arriveTools() 模拟宿主挂上 tools 服务后再回调（对齐真 cordis 的“服务就绪后调用”）。
 */
function makeHarness({ withTools = false, registerThrows = false } = {}) {
  const live = resolveConfig({ autoWeb: false, watchdogAutoSpawn: false, autoMcpSetup: false })
  const state = {
    live, revision: 1, routes: [], sections: [], listeners: new Map(),
    effects: [], registrations: [], registerAttempts: 0, lateCallback: null,
  }
  const makeTools = () => ({
    register(tool) {
      state.registerAttempts += 1
      if (registerThrows) throw new Error('tools.register exploded')
      state.registrations.push(tool.name)
      return () => {}
    },
  })
  const services = {
    settings: formsService('memory-eternal', state),
    systemPrompt: { section(spec) { state.sections.push(spec); return () => {} } },
    webServer: { register(route) { state.routes.push(route); return () => {} } },
  }
  if (withTools) services.tools = makeTools()
  const pending = []
  const childContext = () => ({ get: (n) => services[n], ...services })
  const ctx = {
    fiber: { entry: { options: { id: 'memory-eternal' } } },
    get: (n) => services[n],
    inject(names, callback) {
      if (names.every((n) => services[n] !== undefined)) {
        callback(childContext())
      } else {
        pending.push({ names, callback })
      }
      return () => {}
    },
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
  const arriveTools = () => {
    services.tools = makeTools()
    for (const p of [...pending]) {
      if (p.names.every((n) => services[n] !== undefined)) {
        pending.splice(pending.indexOf(p), 1)
        state.lateCallback = p.callback
        p.callback(childContext())
      }
    }
  }
  // 模拟同一 inject 回调被重放（宿主重挂 / 重复通知）：注册必须幂等。
  const replayLateCallback = () => state.lateCallback(childContext())
  const h = {
    ctx, state, live, arriveTools, replayLateCallback,
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

function fakeReq(body, method = 'POST', url = '/memory-eternal/api/config') {
  return {
    method, url, headers: {},
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8') },
  }
}

async function diagnostics(h) {
  const route = h.state.routes.find((r) => r.path === '/memory-eternal/api' && r.kind === 'prefix')
  assert.ok(route, '应注册 /memory-eternal/api 前缀路由')
  const res = fakeRes()
  await route.handler(fakeReq(undefined, 'GET', '/memory-eternal/api/diagnostics'), res)
  assert.equal(res.status, 200)
  return res.json().diagnostics
}

test('#54 快路径：apply 时 tools 就绪 → 两个工具同步注册，诊断报 registered', async () => {
  const h = makeHarness({ withTools: true })
  apply(h.ctx, h.live)
  assert.deepEqual(h.state.registrations, ['memory_recall', 'memory_note'])
  assert.match(await diagnostics(h), /Tools \(memory_recall\): registered/)
})

test('#54 晚到：apply 时 tools 未就绪 → inject 就绪后补注册（重放不重复）', async () => {
  const h = makeHarness({ withTools: false })
  apply(h.ctx, h.live)
  assert.equal(h.state.registrations.length, 0, 'apply 时 tools 未就绪 → 不应注册')
  assert.match(await diagnostics(h), /Tools \(memory_recall\): MISSING/, '注册前诊断必须如实报缺失')

  h.arriveTools()
  assert.deepEqual(h.state.registrations, ['memory_recall', 'memory_note'], '服务就绪后应补注册两个工具')
  assert.match(await diagnostics(h), /Tools \(memory_recall\): registered/)

  const before = h.state.registerAttempts
  h.replayLateCallback()
  assert.equal(h.state.registerAttempts, before, '同一回调重放不得重复注册')
  assert.deepEqual(h.state.registrations, ['memory_recall', 'memory_note'])
})

test('#54 注册抛错：不打断宿主，诊断报 MISSING 且沉淀日志留 fail', async () => {
  const h = makeHarness({ withTools: false, registerThrows: true })
  apply(h.ctx, h.live)
  assert.doesNotThrow(() => h.arriveTools(), '晚到回调里的异常不应打断宿主')
  assert.equal(h.state.registerAttempts, 1, '应尝试过一次注册')
  assert.deepEqual(h.state.registrations, [], '实际没有工具注册成功')

  const text = await diagnostics(h)
  assert.match(text, /Tools \(memory_recall\): MISSING/, '注册失败不能报成 registered')
  assert.match(text, /记忆工具注册失败/, '失败必须留痕（沉淀日志），不能退回静默')
})
