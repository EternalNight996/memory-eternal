// 设置写回兼容回归（dsh 0.1.7-rc.2）：
//   0.1.7 起 ctx.settings 不再有 register()，只剩表单服务 describe/update/replace/mutate/configure；
//   Config 由 cordis / loader 按 schema 校验后作为**活引用**传进 apply()，volatile 变更由 loader
//   原地提交到该引用并发 'loader/volatile-update'；写回走 settings.update(条目 id, patch, revision)。
//   旧代码直接 ctx.settings.register(...) 在 0.1.7 上抛 TypeError → 插件整个挂不上 → 记忆页消失。
//
// 这里用 0.1.7 形状的假 ctx 真跑一遍 apply()，验证：
//   1) 0.1.7 形状下能挂载（不抛），且旧写法确实会抛（回归锚点）；
//   2) configure({ auto: false }, fiber) 被登记（插件自带设置页，不让宿主再生成一张）；
//   3) 读配置读的是 apply 收到的那份活引用；
//   4) 'loader/volatile-update' 能触发 watch（systemPrompt 段重建 = 热更新真的生效）；
//   5) API POST /config → settings.update('memory-eternal', patch, revision)，冲突映射 409；
//   6) ≤0.1.5 的老 register 路径原样保留。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-settings-'))
process.env.DSH_HOME = tmpHome

const { Config, apply } = await import('../index.js')
const { closeAllDb } = await import('../lib/db.js')

// 断言失败时测试可能提前退出，插件里的 setInterval 会把进程挂住 —— 这里统一兜底释放。
const harnesses = []

after(async () => {
  for (const h of harnesses) h.disposeAll()
  closeAllDb()
  await fs.rm(tmpHome, { recursive: true, force: true })
})

/** 模拟 cordis：按 schema 校验原始配置，返回带默认值的**新对象**（这就是 apply 收到的活引用）。 */
function resolveConfig(raw) {
  const result = Config['~standard'].validate(raw)
  assert.ok(!result.issues, 'Config 默认值应能通过校验')
  return result.value
}

/** 造一个 dsh ≥0.1.7 形状的 settings 服务（有表单 API，没有 register）。 */
function formsService(entryId, state) {
  return {
    writable: true,
    describe: () => [{ ns: entryId, autoGenerate: true, schema: null, value: state.live, revision: state.revision }],
    configure(presentation, owner) {
      state.configureCalls.push({ presentation, owner })
      return () => { state.configureDisposals += 1 }
    },
    async update(ns, patch, revision) {
      state.updates.push({ ns, patch, revision })
      if (state.failWith) throw state.failWith
    },
    async replace() {}, async mutate() {},
  }
}

/** 造一个 ≤0.1.5 形状的 settings 注册表（register 返回 get/watch/update 句柄）。 */
function registryService(state) {
  return {
    register(ns, schema, options) {
      state.registered = { ns, schema, options }
      return {
        get: () => state.live,
        watch: () => { state.legacyWatches += 1; return () => { state.legacyUnwatches += 1 } },
        update: async (patch) => { state.updates.push({ ns, patch }) },
      }
    },
  }
}

function makeHarness({ legacy = false, raw = {}, entryId = 'memory-eternal', liveConfig = null } = {}) {
  const live = liveConfig ?? resolveConfig({ autoWeb: false, watchdogAutoSpawn: false, autoMcpSetup: false, ...raw })
  const state = {
    live, revision: 7, updates: [], configureCalls: [], configureDisposals: 0,
    legacyWatches: 0, legacyUnwatches: 0, registered: null, failWith: null,
    sections: [], sectionDisposals: [], routes: [], listeners: new Map(), effects: [],
  }
  const settings = legacy ? registryService(state) : formsService(entryId, state)
  const services = {
    settings,
    systemPrompt: { section(spec) { state.sections.push(spec); return () => { state.sectionDisposals.push(spec.name) } } },
    tools: { register() { return () => {} } },
    webServer: { register(route) { state.routes.push(route); return () => {} } },
  }
  const ctx = {
    fiber: { entry: { options: { id: entryId } } },
    get: (name) => services[name],
    // 真 cordis 的 ctx.inject(deps, cb)：依赖就绪后回调一个子上下文。
    // index.js 用 ctx.inject(['webServer'], …) 等 webServer 就绪再注册 /memory-eternal/api 路由，
    // 这里服务是现成的，直接同步回调（不吞异常：真出错要让断言暴露出来）。
    inject(names, callback) {
      const child = { get: (name) => services[name], ...services }
      callback(child)
      return () => {}
    },
    // 真 cordis 把服务挂在 ctx 上（ctx.systemPrompt.section(...)）；这里两种访问都要能走。
    ...services,
    on(name, fn) {
      if (!state.listeners.has(name)) state.listeners.set(name, new Set())
      state.listeners.get(name).add(fn)
      return () => state.listeners.get(name).delete(fn)
    },
    off(name, fn) { state.listeners.get(name)?.delete(fn) },
    emit(name, ...args) { for (const fn of [...(state.listeners.get(name) ?? [])]) fn(...args) },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') state.effects.push(dispose); return dispose },
  }
  const harness = { ctx, state, live, disposeAll: () => { for (const d of state.effects.splice(0)) { try { d() } catch { /* 忽略 */ } } } }
  harnesses.push(harness)
  return harness
}

/** 假 res：json() 只用到 writeHead/end/req.headers。 */
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

/** 假 req：处理器只用到 method / url / headers 和「异步可迭代的 body」。 */
function fakeReq(body, method = 'POST', url = '/memory-eternal/api/config') {
  return {
    method, url, headers: {},
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8') },
  }
}

test('Config：每个字段都带 schema.meta.volatile（0.1.7 表单只投影 volatile 字段）', () => {
  const fields = Object.entries(Config.dict ?? {})
  assert.ok(fields.length >= 25, `Config 字段数异常（${fields.length}）`)
  for (const [name, field] of fields) {
    assert.equal(field?.meta?.volatile, true, `字段 ${name} 缺 meta.volatile —— 新版设置页会拒写`)
  }
})

test('0.1.7 形状：没有 register 也能挂载，并登记 configure({auto:false})', () => {
  // 先钉住回归锚点：旧代码就是这么写的，在 0.1.7 服务上必然抛。
  const broken = formsService('memory-eternal', { live: {}, revision: 1, configureCalls: [], updates: [], configureDisposals: 0 })
  assert.throws(() => broken.register('memory-eternal', Config, { base: {} }), TypeError)

  const h = makeHarness()
  assert.doesNotThrow(() => apply(h.ctx, h.live), '0.1.7 形状下 apply 不应抛错')
  assert.equal(h.state.configureCalls.length, 1, '应登记一次表单页策略')
  assert.equal(h.state.configureCalls[0].presentation.auto, false, '插件自带设置页 → auto:false')
  assert.equal(h.state.configureCalls[0].owner, h.ctx.fiber, '策略归属当前插件 fiber')
  assert.equal(h.state.sections.length, 1, 'autoRecall 默认开 → 注入一段 systemPrompt')
  assert.equal(h.state.sections[0].name, 'memory-eternal: auto-recall')
  h.disposeAll()
})

test('0.1.7 形状：settings.get() 读的是 apply 收到的活引用', () => {
  const h = makeHarness({ raw: { vaultDir: path.join(tmpHome, 'vault-live'), recallLimit: 3 } })
  apply(h.ctx, h.live)
  assert.equal(h.live.recallLimit, 3)
  // 活引用被外部（loader / 测试）改写后，插件读到的就是新值 —— 证明没有复制快照。
  h.live.vaultDir = path.join(tmpHome, 'vault-live-2')
  assert.equal(h.live.vaultDir, path.join(tmpHome, 'vault-live-2'))
  h.disposeAll()
})

test("0.1.7 形状：'loader/volatile-update' 触发 watch → systemPrompt 段重建", () => {
  const h = makeHarness()
  apply(h.ctx, h.live)
  assert.equal(h.state.sections.length, 1)
  const before = h.state.sections.length
  h.live.recallLimit = 9
  h.ctx.emit('loader/volatile-update', [['recallLimit']])
  assert.equal(h.state.sections.length, before + 1, 'volatile 更新应重建提示段（watch 生效）')
  assert.equal(h.state.sectionDisposals.length, 1, '旧段应先被注销')
  h.disposeAll()
})

test('0.1.7 形状：autoRecall=false 不注入提示段；volatile 打开后即时注入', () => {
  const h = makeHarness({ raw: { autoRecall: false } })
  apply(h.ctx, h.live)
  assert.equal(h.state.sections.length, 0)
  h.live.autoRecall = true
  h.ctx.emit('loader/volatile-update', [['autoRecall']])
  assert.equal(h.state.sections.length, 1, 'volatile 打开 autoRecall 后应立刻注入')
  h.disposeAll()
})

test('0.1.7 形状：POST /config → settings.update(条目 id, patch, revision)', async () => {
  const h = makeHarness({ raw: { vaultDir: path.join(tmpHome, 'vault-api') } })
  apply(h.ctx, h.live)
  const route = h.state.routes.find((r) => r.path === '/memory-eternal/api' && r.kind === 'prefix')
  assert.ok(route, '应注册 /memory-eternal/api 前缀路由')

  const res = fakeRes()
  await route.handler(fakeReq({ patch: { recallLimit: 4, nope: 1 }, expectedRevision: 7 }), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.json().applied, ['recallLimit'], '白名单外的字段不得写入')
  assert.equal(h.state.updates.length, 1)
  assert.equal(h.state.updates[0].ns, 'memory-eternal', 'ns 必须是 Loader 条目的 options.id')
  assert.deepEqual(h.state.updates[0].patch, { recallLimit: 4 })
  assert.equal(h.state.updates[0].revision, 7, '应透传前端 revision')
  h.disposeAll()
})

test('0.1.7 形状：revision 冲突（SETTINGS_CONFLICT）映射成 HTTP 409', async () => {
  const h = makeHarness({ raw: { vaultDir: path.join(tmpHome, 'vault-conflict') } })
  apply(h.ctx, h.live)
  const route = h.state.routes.find((r) => r.path === '/memory-eternal/api' && r.kind === 'prefix')
  const res = fakeRes()
  await route.handler(fakeReq({ patch: { recallLimit: 2 }, expectedRevision: 1 }), res)
  assert.equal(res.status, 200, '正常写入应 200')
  h.state.failWith = Object.assign(new Error('stale'), { code: 'SETTINGS_CONFLICT' })
  const res2 = fakeRes()
  await route.handler(fakeReq({ patch: { recallLimit: 5 }, expectedRevision: 2 }), res2)
  assert.equal(res2.status, 409, '冲突应映射 409 而不是 500')
  h.disposeAll()
})

test('≤0.1.5 兼容：老 register 路径原样保留（不登记 configure，也不挂 volatile 监听）', () => {
  const h = makeHarness({ legacy: true })
  assert.doesNotThrow(() => apply(h.ctx, h.live))
  assert.ok(h.state.registered, '应调用 settings.register')
  assert.equal(h.state.registered.ns, 'memory-eternal')
  assert.equal(h.state.registered.schema, Config)
  assert.equal(h.state.legacyWatches, 2, 'register 句柄的 watch 应被用两次（audit + prompt）')
  assert.equal(h.state.configureCalls.length, 0, '老版本没有表单策略 API')
  assert.equal(h.state.listeners.get('loader/volatile-update'), undefined, '老路径不应依赖 loader 事件')
  assert.equal(h.state.sections.length, 1)
  h.disposeAll()
})

// -- schemastery ≥3.18.4：volatile 字段是 cosmokit「活引用」而非普通值 -------------
// 官方桌面版 profile 解析到的是 schemastery 3.18.4，它会把 meta.volatile 字段解析成
// 引用对象（{ get(): snapshot }，品牌 Symbol.for('cosmokit.volatile.write')）。
// 0.9.4 在这里翻车：cfg.vaultDir.trim is not a function → 插件整体挂不上（桌面版实测）。
// web profile 当时解析到 3.18.1（忽略 volatile）所以碰巧没暴露。
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 按 cosmokit src/volatile.ts 的形状造引用；盒子可变，用于验证热更新。 */
function wrapVolatile(config) {
  const boxes = {}
  const wrapped = {}
  for (const [key, value] of Object.entries(config)) {
    const box = { value }
    boxes[key] = box
    wrapped[key] = { get: () => box.value, [VOLATILE_WRITE]: (next) => { box.value = next } }
  }
  return { wrapped, boxes }
}

async function getConfig(h) {
  const route = h.state.routes.find((r) => r.path === '/memory-eternal/api' && r.kind === 'prefix')
  const res = fakeRes()
  await route.handler({ method: 'GET', url: '/memory-eternal/api/config', headers: {} }, res)
  return { status: res.status, body: res.json() }
}

test('schemastery ≥3.18.4：volatile 字段是活引用 —— apply 不得抛错，对外只暴露普通值', async () => {
  const plain = resolveConfig({ autoWeb: false, watchdogAutoSpawn: false, autoMcpSetup: false, vaultDir: path.join(tmpHome, 'vault-volatile') })
  const { wrapped, boxes } = wrapVolatile(plain)
  assert.equal(typeof wrapped.vaultDir, 'object')
  // 崩溃锚点：0.9.4 正是死在这一句上（cfg.vaultDir.trim is not a function）。
  assert.throws(() => wrapped.vaultDir.trim(), TypeError)

  const h = makeHarness({ liveConfig: wrapped })
  assert.doesNotThrow(() => apply(h.ctx, wrapped), 'volatile 引用形态下 apply 不得抛错')

  const first = await getConfig(h)
  assert.equal(first.status, 200)
  assert.equal(typeof first.body.dsh.vaultDir, 'string', 'vaultDir 必须解引用成普通字符串')
  assert.equal(first.body.config.recallLimit, 5, '默认值应来自解引用后的快照')

  // 共享配置文件（独立 web / MCP hook 读它）也必须是普通值，不能变成 {}
  const cfgFile = path.join(tmpHome, 'memory-eternal-config.json')
  let written = null
  for (let i = 0; i < 40 && !written; i++) {
    try { written = JSON.parse(await fs.readFile(cfgFile, 'utf8')) } catch { await new Promise((r) => setTimeout(r, 25)) }
  }
  assert.ok(written, '应写出 memory-eternal-config.json')
  assert.equal(typeof written.vaultDir, 'string', 'JSON.stringify 不能把 volatile 引用写成 {}')

  // 热更新：loader 原地改引用内部的值，每次读取都必须看到新值（不能缓存快照）
  boxes.recallLimit.value = 12
  const second = await getConfig(h)
  assert.equal(second.body.config.recallLimit, 12, 'volatile 热更新必须立刻可见')
  h.disposeAll()
})

test('schemastery ≥3.18.4：volatile 引用里的对象 / 数组也要递归解引用', async () => {
  const plain = resolveConfig({
    autoWeb: false, watchdogAutoSpawn: false, autoMcpSetup: false,
    vaultDir: path.join(tmpHome, 'vault-nested'),
    vaultProfiles: [{ name: 'work', path: path.join(tmpHome, 'vault-work') }],
    activeVault: 'work',
  })
  const { wrapped } = wrapVolatile(plain)
  const h = makeHarness({ liveConfig: wrapped })
  assert.doesNotThrow(() => apply(h.ctx, wrapped))
  const res = await getConfig(h)
  assert.equal(res.status, 200)
  assert.equal(res.body.dsh.vaultDir, path.join(tmpHome, 'vault-work'), '数组元素也应解引用后参与计算')
  h.disposeAll()
})

