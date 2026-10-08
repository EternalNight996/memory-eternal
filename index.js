// 记忆核心（host 侧）：自动沉淀 + 自动召回 + 知识库 JSON API。
//
// 职责：
// 1. 注册 `memory-eternal` 设置命名空间（enabled / autoCapture / autoRecall /
//    vaultDir / dedupThreshold / captureMinChars / captureCooldownMs）。
// 2. 监听 `agent/turn-stopping`：每轮对话结束自动把「值得长期复用的内容」
//    压缩成知识卡写入本地 Markdown Vault（去重守卫：相似卡拒绝新建、改为
//    追加更新记录）。零人工干预。
// 3. 注入 systemPrompt 分段：告知 Agent 它有一块记忆核心、可随时
//    memory_recall 召回历史上下文；并注册 `memory_recall` 工具。
// 4. 注册 `/memory-eternal/api/*` JSON 路由：供客户端设置页渲染统计 / 卡片 /
//    知识图谱 / 检索。
//
// 存储全部落在本地 Markdown Vault（默认 $DSH_HOME/memory-vault），不依赖
// 外部数据库；卡是普通 .md 文件，可手动编辑、可 git 管理。

import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const PACKAGE_ROOT = path.resolve(path.dirname(__filename))
// 插件版本号（供「记忆配置」页面展示）
const versionRef = (() => { try { const p = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')); return p.version } catch { return '' } })()
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ensureVault, search } from './lib/vault.js'
import { migrateFromMarkdown, setAuditConfig, backupDb } from './lib/db.js'
import { evaluateStall, MAX_STAMPS } from './lib/stall.js'
import { resolveVaultDir, currentWorkspace } from './lib/vault-resolve.js'
import { createHub } from './lib/sse.js'
import { summarizeTurn, summarizeTurnDetailed, routeCandidates, extractLastTurn, sliceNewEvents, sessionEvents, sessionEventApi, createCaptureHealth, resolveRoute, captureCard, captureUpdate, pickNeighbors, hasUsableContent, deriveTitle, looksTruncated, maxTokenLadder, DEFAULT_CAPTURE_MAX_TOKENS, MAX_CAPTURE_MAX_TOKENS } from './lib/capture.js'
import { createApi, json, encodeBody } from './lib/api.js'
import { appendCaptureLog, readCaptureLog, rotateCaptureLog } from './lib/capture-log.js'
import { missingWebAssets, missingAssetsReason } from './lib/web-assets.js'
import { writeHostMarker, clearHostMarker } from './lib/host-heartbeat.js'
import { nodeBinary, childEnv } from './lib/node-bin.js'

export const name = 'memory-eternal'
export const inject = ['systemPrompt', 'settings']

// 所有字段都要能被「记忆配置」页写回：dsh ≥0.1.7 的设置服务只把 schema.meta.volatile
// 为真的字段投影成可编辑表单，保存走 settings.update(条目 id, patch) —— 非 volatile
// 字段会被拒写。volatile 变更不重挂插件，而是把新值提交进 apply 收到的活引用（见 bindSettings）。
//
// 为什么不直接链式写 .volatile()：schemastery ≥3.18.4 才有这个方法，而插件在宿主里解析到的
// 是 profile 层的 schemastery（本机实测仍是 3.18.1）。链式调用会在 import 期抛
// "TypeError: ...volatile is not a function"，把整个插件打挂；这里统一在构造后打标记，
// 新旧版本行为一致（.volatile() 本身就等价于 .extra('volatile', true)，只写 meta）。
export const Config = z.object({
  enabled: z.boolean().default(true),
  autoCapture: z.boolean().default(true),
  autoRecall: z.boolean().default(true),
  vaultDir: z.string().default(''),
  dedupThreshold: z.number().min(0).max(1).default(0.62),
  captureMinChars: z.number().default(200),
  captureCooldownMs: z.number().default(5 * 60 * 1000),
  maxCardsPerDay: z.number().default(60),
  // 成本控制（v0.6.2）：让用户精控 LLM token / 蒸馏调用 / 召回注入量
  // 蒸馏：true=LLM 压缩成知识卡；false=只存原文卡，零 LLM 消耗（最大省钱）
  distillEnabled: z.boolean().default(true),
  // 语义去重：true=把已有卡索引喂 LLM 决定「新建 vs 追加」；false=纯词法去重（省一次蒸馏前的 LLM 调用）
  dedupByLLM: z.boolean().default(true),
  // 蒸馏用的 provider / model（留空 = 按注册顺序自动挑，见 routeCandidates）
  // 多 provider 环境下务必显式指定，否则可能撞上没配 key 的官方 provider（issue #3）
  captureProvider: z.string().default(''),
  captureModel: z.string().default(''),
  // 蒸馏单次输出上限（token），越高越准越贵
  // 默认值 900 → 2000（issue #18）：prompt 要求 300-800 字正文，900 会让超长会话常态化撞上限，
  // 输出被截断后旧代码还会把它误报成「解析失败」，最终落一张 raw 噪声卡。
  captureMaxTokens: z.number().min(100).max(4000).default(DEFAULT_CAPTURE_MAX_TOKENS),
  // 召回相关性阈值（minScore），越高召回越少越精越省
  recallMinScore: z.number().min(0).max(50).default(2),
  // 注入体积可配置（召回）
  recallLimit: z.number().min(1).max(20).default(5),
  recallSummaryLen: z.number().min(40).max(400).default(130),
  recallIncludeBody: z.boolean().default(false),
  // 凭证取用提示（默认空 = 不注入）：写进来的一整句会被追加到每个会话的 systemPrompt 段，
  // 用来让 agent「需要 API key / token 时先想到去查记忆里的目录卡」。
  // 为什么做成配置而不是写死：默认值必须对**所有**用户安全 —— 插件本身不假定任何本机
  // 密钥布局（也不该在公开包里硬编码某台机器的路径）；有需要的用户填一句自己的约定即可。
  // 参考句式：需要 API key/token 时先查记忆目录卡（memory_recall「密钥 目录」），
  //          再按卡片给的本机命令取用；禁止直接读凭据文件、禁止把值打印或写进卡片/代码。
  secretHint: z.string().default(''),
  // 多 Vault / 多 Profile：命名分库，当前激活一个
  vaultProfiles: z.array(z.object({ name: z.string(), path: z.string() })).default([]),
  activeVault: z.string().default(''),
  // 语义召回（可选 embedding provider，默认空=零依赖 bigram + LLM 判定兜底）
  recallEmbedding: z.string().default(''),
  // 会话级 token 预算（字符），供 harness 触发压缩/轮换；记忆侧提供估算与阈值
  sessionBudgetChars: z.number().default(80000),
  // 多宿主：激活时自动把 MCP 挂载到本机已装的 Claude Code/Codex/Cursor（幂等，
  // MEMORY_ETERNAL_SKIP_AUTO=1 可完全禁用）。**默认 false**——不碰外部配置，需要时显式开启。
  autoMcpSetup: z.boolean().default(false),
  autoWeb: z.boolean().default(true),
  // web server 保活模式：
  //   init    = DSH 激活时拉起一次（默认；最低开销，DSH 死后 web 仍活但无人看守）
  //   interval= DSH 进程内 setInterval 周期探活+自动拉起（额外 0 内存；DSH 死则停保活）
  //   manual  = 完全不自动拉起；只在 `dsh-memory open` 时 ensure-alive（最保守）
  autoWebMode: z.union([z.const('init'), z.const('interval'), z.const('manual')]).default('init'),
  webPort: z.number().min(1).max(65535).default(7999),
  webCheckIntervalMs: z.number().min(1000).max(600000).default(5000),
  webMaxRestart: z.number().min(1).max(1000).default(10),
  // 是否 spawn 独立 watchdog 进程（与 DSH 解耦，7×24 保活；额外 ~47 MB 常驻）
  // **v0.6.0 起默认 true**——DSH 进程内 setInterval 在 DSH 退出后失效；
  // 常驻 web 场景需要独立 watchdog；代价是 ~47 MB 额外常驻内存。
  watchdogAutoSpawn: z.boolean().default(true),
  // 版本漂移自愈（默认开）：常驻 web（7999）比 DSH 活得久 —— 升级 npm 包只换磁盘文件，
  // 端口上那个进程仍跑着启动时加载的旧代码，而「同端口已有活着的 watchdog 就让位」的策略
  // 让重启 DSH 永远换不掉它（issue #19/#23）。开启后，激活时若发现**端口上真正服务的版本
  // ≠ 本机磁盘版本**，就用新代码重启常驻实例（delegate → restart），而不是继续委派给旧实例。
  // 关掉只是不自动做，面板上的「重启常驻实例」按钮与 dsh-memory restart 始终可用。
  autoRestartOnDrift: z.boolean().default(true),
  // 回收站保留天数：软删卡超过此天数自动永久删除（默认 30）
  recycleRetentionDays: z.number().min(1).max(3650).default(30),
  // 自动审核配置
  //   auditMode: 'all'=全部要审(默认) | 'none'=全部免审直接入库
  //   auditExemptAgents: 免审的智能体名列表（如 codex / claude-code / 本地 DSH）
  //   auditExemptKinds: 免审的知识类型列表（如 tool / mistake）
  // 命中任一免审条件 → 新卡直接 approved 入库，否则进 pending 待审
  auditMode: z.union([z.const('all'), z.const('none')]).default('all'),
  auditExemptAgents: z.array(z.string()).default([]),
  auditExemptKinds: z.array(z.string()).default([]),
})

/**
 * 把对象 schema 的每个字段标成 volatile（等价于逐字段 .volatile()，但不依赖该方法存在）。
 * 注意 schemastery 的 Schema 是**可调用对象**（typeof === 'function'），别用 typeof 过滤。
 */
function markAllVolatile(schema) {
  for (const field of Object.values(schema?.dict ?? {})) {
    if (field === null || field === undefined) continue
    field.meta = { ...(field.meta ?? {}), volatile: true }
  }
  return schema
}

markAllVolatile(Config)

/**
 * 取「会话自己的工作区」（issue #15 问题 1）。
 *
 * 宿主进程的 cwd 是**启动 dsh 时的目录**，拿它去 match.workspace 永远不命中 ——
 * 于是按项目隔离的记忆库在宿主侧实际不可用。DSH 把会话目录放在 session.header.cwd，
 * 这里把它取出来交给 resolveVaultDir。
 *
 * 优先级：MEMORY_WORKSPACE（显式覆盖 / 宿主 spawn 子进程时传入）> 会话 cwd > undefined
 * （undefined 时 resolveVaultDir 会回落进程 cwd，与 CLI / MCP / hooks 的既有行为一致）。
 *
 * @param {{session?:{header?:{cwd?:string}}}} [agent]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|undefined}
 */
export function sessionWorkspaceOf(agent, env = process.env) {
  const explicit = String((env && env.MEMORY_WORKSPACE) || '').trim()
  if (explicit) return explicit
  const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
  return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined
}

/**
 * 汇总一次蒸馏的全部候选失败（issue #18 根因 2）。
 *
 * 旧实现的 failure 每轮被下一个候选覆盖，最终上报的偏偏是**最后一个兜底候选**的错误
 * （例如一堆网关的 UNSUPPORTED_REASONING_EFFORT），把真正有信息量的主因埋掉。
 * 这里始终以第一个候选（通常是显式配置的那个）为主因，其余按错误码计数附在后面。
 *
 * @param {{code:string,message:string,provider?:string,model?:string}} primary 主失败（第一个候选）
 * @param {Array<object>} [all] 全部候选的失败
 * @returns {string}
 */
export function describeDistillFailure(primary, all = []) {
  const head = `${primary.code} ${primary.message}`
  const rest = Array.isArray(all) ? all.slice(1) : []
  if (!rest.length) return head
  const counts = new Map()
  for (const f of rest) {
    const key = String((f && f.code) || '未知')
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const summary = [...counts.entries()].map(([code, n]) => (n > 1 ? `${code}×${n}` : code)).join('、')
  return `${head}（另有 ${rest.length} 个兜底候选失败：${summary}）`
}

const API_PREFIX = '/memory-eternal/api'

// DSH 宿主自动沉淀卡的署名：用可读名而非 agent 会话 id，便于在智能体筛选中归组。
const DSH_AGENT = 'deepseek-harness'

// 设置读写兼容层（跨 dsh 版本）：
//   dsh ≤0.1.5：ctx.settings 是"设置命名空间注册表"，register(ns, Config, { base })
//               返回带 get()/watch()/update() 的句柄；配置存在 settings.yaml。
//   dsh ≥0.1.7：ctx.settings 只剩表单服务（describe/update/replace/mutate/configure），
//               没有 register。Config 由 cordis / loader 按 schema 校验后作为**活引用**
//               传进 apply()；volatile 字段变更由 loader 原地提交到该引用并发
//               'loader/volatile-update'；写回走 settings.update(条目 id, patch, revision)。
// 旧版行为原样保留，新版做等价映射，业务代码继续只依赖 get/watch/update 三个方法。
function settingsEntryId(ctx) {
  // settings.describe() 以 **Loader 条目的 options.id** 作 ns（见 dsh-settings 实现：
  // `ns: entry.options.id`），所以这里必须取 options.id，而不是带父级前缀的 Entry.id。
  const entry = ctx?.fiber?.entry ?? ctx?.[Symbol.for('cordis.entry')]
  return entry?.options?.id || 'memory-eternal'
}

// schemastery ≥3.18.4 会把 Config 里标了 volatile 的字段解析成 cosmokit 的「活引用」
// （形如 { get(): snapshot }，品牌是全局注册的 Symbol.for('cosmokit.volatile.write')），
// 而 ≤3.18.1 完全忽略 volatile、直接给普通值 —— 同一份 Config 在两种宿主上形状不同：
//   • 官方桌面版 profile 解析到 schemastery 3.18.4 → cfg.vaultDir 是引用对象，
//     旧代码 cfg.vaultDir.trim() 当场抛 "trim is not a function"，插件整体挂不上；
//   • 早期 web profile 解析到 3.18.1 → 普通值，碰巧能跑（所以一开始没暴露）。
// 官方插件的写法是每次取用都 .get()（如 dsh-agent-default-model 的 this.config.model.get()）。
// 业务代码要的是普通值，这里统一深解引用：既拿到快照，又因为每次读都重新解，
// loader 原地提交的 volatile 热更新依然立刻可见。JSON.stringify 也因此不再写出 {}。
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && VOLATILE_WRITE in value
}

/** 深拷贝一份「普通值」配置：volatile 引用解引用，数组 / 对象递归展开。 */
function plainConfig(value, depth = 0) {
  if (depth > 8) return value
  if (isVolatileRef(value)) return plainConfig(value.get(), depth + 1)
  if (Array.isArray(value)) return value.map((item) => plainConfig(item, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = plainConfig(item, depth + 1)
    return out
  }
  return value
}

// 无 Loader 挂载、apply 又没拿到 config 时，用标准 schema 校验空对象取默认值。
function schemaDefaults(schema) {
  try {
    const std = schema?.['~standard']
    if (std && typeof std.validate === 'function') {
      const result = std.validate({})
      if (result && !result.issues) return plainConfig(result.value)
    }
  } catch { /* 拿不到默认值就用空对象 */ }
  return {}
}

export function bindSettings(ctx, schema, config) {
  const service = typeof ctx.get === 'function' ? ctx.get('settings') : ctx.settings
  if (service && typeof service.register === 'function') {
    return service.register('memory-eternal', schema, { base: config ?? {} })
  }
  const fallback = schemaDefaults(schema)
  const read = () => (config === undefined || config === null ? fallback : plainConfig(config))
  const entryId = settingsEntryId(ctx)
  // dsh ≥0.1.7 的表单页策略：本插件自带「记忆」设置页（client 侧注册 settings.section），
  // 声明 auto:false，免得宿主再按 schema 自动生成一张重复的表单页。
  if (service && typeof service.configure === 'function') {
    ctx.effect(() => {
      try { return service.configure({ auto: false }, ctx.fiber) } catch { return () => {} }
    }, 'memory-eternal: settings presentation')
  }
  // 宿主「volatile 回流」可能滞后甚至不回流（issue #12：改了保存不上）。两步兜底：
  //   ① 写成功后把 patch 叠加在本地视图上 → 面板重新加载立刻是新值；
  //   ② 等宿主快照追上（值相等）后自动摘除，避免长期掩盖宿主的真实状态。
  const overlay = {}
  const snapshotWithoutOverlay = () => (config === undefined || config === null ? fallback : plainConfig(config))
  const pruneOverlay = (snapshot) => {
    for (const key of Object.keys(overlay)) {
      if (snapshot && snapshot[key] !== undefined && JSON.stringify(snapshot[key]) === JSON.stringify(overlay[key])) delete overlay[key]
    }
  }
  const readMerged = () => {
    const base = snapshotWithoutOverlay()
    pruneOverlay(base)
    return Object.keys(overlay).length ? { ...base, ...overlay } : base
  }
  return {
    get: readMerged,
    watch(listener) {
      const handler = () => { try { listener(readMerged()) } catch { /* 监听器异常不影响宿主 */ } }
      ctx.on('loader/volatile-update', handler)
      return () => { try { ctx.off('loader/volatile-update', handler) } catch { /* 已卸载 */ } }
    },
    /**
     * 写配置。
     * 宿主 write() 用「describe 返回的 revision 必须完全一致」做乐观并发（dsh-settings
     * SettingsConflictError），而面板持有的 revision 可能已经过期（上一次写入、宿主重建配置等）。
     * 这里遇到冲突就取一次最新 revision 重试一次，而不是把 409 直接抛给用户。
     * @returns {Promise<{revision:number, retried:boolean}>}
     */
    async update(patch, expectedRevision) {
      if (!service || typeof service.update !== 'function') throw new Error('当前 DSH 版本不支持写配置')
      const call = (rev) => service.update(entryId, patch, rev)
      let retried = false
      let used = expectedRevision
      try {
        await call(expectedRevision)
      } catch (error) {
        const msg = String((error && error.message) || error)
        if (!/revision|changed since|conflict/i.test(msg)) throw error
        let fresh
        try {
          const list = typeof service.describe === 'function' ? service.describe() : []
          fresh = (list.find((d) => d && d.ns === entryId) || {}).revision
        } catch { fresh = undefined }
        if (fresh === undefined) throw error
        used = fresh
        retried = true
        await call(fresh)
      }
      Object.assign(overlay, patch)
      return { revision: used, retried }
    },
  }
}

export function apply(ctx, config) {
  const settings = bindSettings(ctx, Config, config)
  // SSE：配置变更即时推送到所有已打开的页面（DSH 内嵌页 + 独立 Web 页），不必手动刷新
  const hub = createHub()
  ctx.effect(() => () => hub.close(), 'memory-eternal: sse hub')

  // 首次激活：自动从 .md 文件迁移到 SQLite（幂等，已有数据则跳过）
  // vault 解析与所有独立进程共用同一套优先级（见 lib/vault-resolve.js）：
  // MEMORY_VAULT_DIR → activeVault → vaultProfiles[].match.workspace → vaultDir → 默认库。
  //
  // issue #15：宿主进程的 cwd 是「启动 dsh 时的目录」，不是会话的工作区，
  // 所以 match.workspace 在宿主侧永远不命中（配置能写、代码也有，就是取不到工作区）。
  // DSH 把会话目录放在 session.header.cwd —— 每条会话路径把它显式传下来即可，
  // CLI / MCP / hooks 仍然按各自 cwd 解析（那条路径本来就正确）。
  const sessionWorkspace = (agent) => sessionWorkspaceOf(agent, process.env)
  const vaultDir = (workspace) => resolveVaultDir({
    profiles: (settings.get() ?? {}).vaultProfiles,
    activeVault: (settings.get() ?? {}).activeVault,
    configured: (settings.get() ?? {}).vaultDir,
    workspace,
  }).root
  const vaultInfo = (workspace) => resolveVaultDir({
    profiles: (settings.get() ?? {}).vaultProfiles,
    activeVault: (settings.get() ?? {}).activeVault,
    configured: (settings.get() ?? {}).vaultDir,
    workspace,
  })

  // 自动迁移：从 .md 文件导入 SQLite（幂等，DB 有数据则跳过）
  try { migrateFromMarkdown(vaultDir()).catch(() => {}) } catch {}
  // 同步审核配置到 SQLite config 表（enforceAudit 从此表读取规则）
  // 审核配置要写进**会话实际使用的那个库**（#15 的按项目库）：enforceAudit 在 DB 层读的是
  // 本库的 config 表，只同步激活库会让 profile 库退回「调用方传入的 fallback」。
  const syncAudit = (root) => {
    try {
      const cfg = settings.get() ?? {}
      setAuditConfig(root || vaultDir(), { auditMode: cfg.auditMode, auditExemptAgents: cfg.auditExemptAgents, auditExemptKinds: cfg.auditExemptKinds })
    } catch {}
  }
  syncAudit()
  // 注意：watch 的回调会被传入「合并后的配置对象」，而 syncAudit 现在接受的是**库路径** ——
  // 必须包一层，否则热更新时会把配置对象当成路径传进 setAuditConfig（静默失败）。
  settings.watch(() => syncAudit())
  // 独立 Web 页保存的配置：它写「待应用」文件，这边应用后删除（DSH 没运行时下次启动生效）
  // 待应用配置的最近一次失败（#16）：以前这里 catch {} 吞掉一切 —— 独立 Web 端显示
  // 「已保存」，而 settings.update 的报错、乃至重试耗尽后「改动被放弃」都无人可见。
  // 现在：报错进 stderr + 自动沉淀日志，并做去重节流（同一错误 5 分钟内只记一次，
  // 否则 5 秒一轮的轮询会把日志刷爆）。
  let lastDrainError = ''
  let lastDrainErrorAt = 0
  const reportDrainError = (error) => {
    const dropped = !!(error && error.dropped)
    const msg = String((error && error.message) || error || '未知错误')
    const now = Date.now()
    if (msg === lastDrainError && now - lastDrainErrorAt < 5 * 60 * 1000) return
    lastDrainError = msg
    lastDrainErrorAt = now
    const why = dropped
      ? '独立 Web 端的配置改动连续失败已放弃（文件保留以便排查）：' + msg
      : '独立 Web 端的配置改动应用失败，将重试：' + msg
    try { console.error('[memory-eternal] ' + why) } catch { /* 日志失败无妨 */ }
    try { logCapture('system', dropped ? 'fail' : 'warn', why) } catch { /* 日志失败无妨 */ }
  }
  // issue #21：dsh-tui 一类宿主的能力守卫会在 settings.update **内部**的 describe() 上抛
  // 「root.events.emit is unavailable from a plugin activation」（守卫只区分「第三方插件 vs
  // host 内部代码」，识别不出「官方服务在插件调用链里执行的合法动作」，上游已开 issue）。
  // 关键点：抛错 ≠ 没写进去 —— 只认有没有抛错，会把其实已经生效的改动重试 5 次后标成
  // dropped，日志里还报失败。applyPatchVerified 在抛错后回读确认（带守卫的宿主上这是
  // 唯一能自证的信号），判据与实现都在 lib/config-sync.js 里（有单测）。
  //
  // 注意：把 drain 推迟到 activation 之后**解决不了**这个问题 —— 上游 dsh-tui 用
  // AsyncLocalStorage.run(token) 包住每次插件回调，并 patch 了 Fiber._execute，定时器 /
  // fs.watch 的每一次回调都带着 activation token（见 ccch1mneyyy/dsh-TUI#1348 的定位）。
  const applyPendingPatch = async (patch) => {
    const { applyPatchVerified } = await import('./lib/config-sync.js')
    return applyPatchVerified(patch, {
      apply: (p) => settings.update(p, undefined),
      read: () => settings.get() ?? {},
      onRepaired: (error) => {
        try {
          console.error('[memory-eternal] settings.update 抛错但回读确认改动已生效（宿主守卫误报），按成功处理：' + String((error && error.message) || error))
        } catch { /* 日志失败无妨 */ }
      },
    })
  }
  const drainPending = async () => {
    try {
      const { drainPendingConfig } = await import('./lib/config-sync.js')
      const applied = await drainPendingConfig(process.env, applyPendingPatch)
      if (applied) {
        lastDrainError = ''
        syncConfigFile()
        syncAudit()
        try { console.error('[memory-eternal] 已应用独立 Web 端的配置改动: ' + Object.keys(applied).join(',')) } catch { /* 日志失败无妨 */ }
      }
    } catch (error) {
      // 失败时保留文件由 config-sync.js 负责；这里只保证「失败可见」
      reportDrainError(error)
    }
  }
  drainPending()
  // 5 秒轮询只是兜底；真正让它「准即时」的是下面这个文件监听（毫秒级）
  const pendingTimer = setInterval(drainPending, 5000)
  ctx.effect(() => () => clearInterval(pendingTimer), 'memory-eternal: pending config sync')
  ctx.effect(() => {
    let stop = () => {}
    // 动态 import 是异步的：若宿主在它 resolve 之前就 dispose（测试里的假 ctx 会立刻 dispose），
    // 后到的监听器就再也没人清理 —— 会一直挂住事件循环。用一个 disposed 标记堵住这个窗口。
    let disposed = false
    import('./lib/config-sync.js').then(({ watchPendingConfig }) => {
      if (disposed) return
      stop = watchPendingConfig(process.env, () => {
        drainPending().then(() => hub.broadcast('config', { at: Date.now(), source: 'pending' })).catch(() => {})
      })
    }).catch(() => {})
    return () => { disposed = true; try { stop() } catch { /* 已停止 */ } }
  }, 'memory-eternal: pending config watch')

  // 宿主心跳（issue #21）：告诉独立 Web 端「本机有 DSH 宿主在跑」，这样它就不会绕过宿主
  // 直接写共享配置（绕过会与宿主的 volatile 配置分叉）。心跳必须定期刷新：进程被硬杀时
  // 没有机会删文件，独立端靠「新鲜度 + pid 存活」两个条件判定，所以宁可多刷几次。
  ctx.effect(() => {
    const beat = () => { try { writeHostMarker(process.env, { version: versionRef }) } catch { /* 心跳失败不影响主流程 */ } }
    beat()
    // unref：心跳只是「我在跑」的旁证，不该成为阻止进程退出的最后一根钉子
    // （测试里以假 ctx 跑 apply() 时会因此挂住不退，实测过一次）。
    const timer = setInterval(beat, 15000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => { clearInterval(timer); try { clearHostMarker(process.env) } catch { /* 清理失败无妨 */ } }
  }, 'memory-eternal: host heartbeat')

  // 所有 profile 目录（当前激活 + 其余命名的），供跨库聚合。
  const vaultRoots = (workspace) => {
    const cfg = settings.get() ?? {}
    const active = vaultDir(workspace)
    const roots = [{ name: '', root: active }]
    const seen = new Set([active])
    const profiles = Array.isArray(cfg.vaultProfiles) ? cfg.vaultProfiles : []
    for (const p of profiles) {
      if (!p || !p.path || !p.path.trim()) continue
      const r = path.resolve(p.path.trim())
      if (seen.has(r)) continue
      seen.add(r)
      roots.push({ name: p.name || r, root: r })
    }
    return roots
  }
  // 把完整配置写入共享文件，使独立 web / MCP hook 捕获与 DSH 设置同步（不同步修复）。
  //
  // 2026-10-07：这里原来是 `catch { /* 静默 */ }` —— 正是本项目一直在消灭的静默吞错。它写不进去
  // 的后果很隐蔽：独立页 / hooks / MCP 读的都是这个文件，于是表现为「配置改了但他们看不到」
  // （实测到过一次：共享文件的 mtime 停在激活前，而宿主里的值已经变了）。现在失败一律可见。
  let lastSyncError = ''
  const reportSyncFailure = (reason) => {
    const why = String(reason || '')
    if (!why || why === lastSyncError) return   // 同一原因只报一次，避免 5 秒轮询刷屏
    lastSyncError = why
    // 必须延迟一拍：本函数可能在 apply() 的**同步**阶段被调用，而 logCapture 定义在更后面
    // （const 的 TDZ 会直接抛 ReferenceError）。setImmediate 之后整个 apply() 已执行完毕。
    const emit = () => {
      try { console.error('[memory-eternal] 共享配置文件同步失败（独立页 / hooks / MCP 读到的是旧值）：' + why) } catch { /* 无妨 */ }
      try { logCapture('system', 'warn', '共享配置文件同步失败（独立页 / hooks / MCP 会读到旧值）：' + why) } catch { /* 无妨 */ }
    }
    if (typeof setImmediate === 'function') setImmediate(emit)
    else setTimeout(emit, 0)
  }
  const syncConfigFile = async () => {
    try {
      const cfg = settings.get() ?? {}
      const { configFilePath } = await import('./lib/capture-run.js')
      const { writeFileAtomicSync } = await import('./lib/config-sync.js')
      // 原子写（tmp + rename，见 lib/config-sync.js 里 writeFileAtomicSync 的说明）：
      // 这个文件是跨进程共享的读源，非原子写会让独立 web / MCP 读到半截内容并静默回落成默认值。
      writeFileAtomicSync(configFilePath(process.env), JSON.stringify(cfg, null, 2))
      lastSyncError = ''
    } catch (error) {
      reportSyncFailure(error && error.message ? error.message : error)
    }
  }
  syncConfigFile()
  // agent/turn-stopping 是 serial 事件：不在监听器里 await LLM（会拖慢收尾），
  // 同步抓取增量事件快照后，把真正的捕获调度到后台队列执行。
  const pending = new Map() // sessionId -> merged events array
  let captureQueue = Promise.resolve()

  // -- 自动沉淀日志：最近 200 条「监听/判定/写入」事件（内存环形缓冲，不落盘）。
  // 自动沉淀是后台静默管线，出错或空转时页面上完全看不出来；这里留一条可读的
  // 运行轨迹，供「用量/今日」页的「自动沉淀日志」面板直接排查。
  const captureLog = []
  const CAPTURE_LOG_MAX = 200
  // 健康状态：fail → 亮红（systemPrompt 段 + 页面横幅都会提示）；真写卡成功 → 复原。
  const health = createCaptureHealth()
  let refreshPrompt = null // 由 systemPrompt effect 赋值；健康状态翻转时重渲染提示段
  const touchPrompt = () => {
    if (typeof refreshPrompt !== 'function') return
    try { refreshPrompt(settings.get()) } catch { /* 提示段刷新失败不影响沉淀 */ }
  }
  let logWrites = 0                // 累计写入行数（每 100 行裁剪一次日志文件）
  let lastActivityAt = Date.now() // 最近一次「管线有活口」的时间（见下：listen/读事件/写卡都算）
  let stallAlerted = false        // 停滞告警只在状态翻转时报一次，不刷屏
  const logCapture = (sessionId, action, reason, extra = {}) => {
    const entry = { time: Date.now(), sessionId: String(sessionId || 'unknown').slice(0, 40), action, reason, ...extra }
    captureLog.push(entry)
    if (captureLog.length > CAPTURE_LOG_MAX) captureLog.splice(0, captureLog.length - CAPTURE_LOG_MAX)
    // 落盘：独立 Web 页 + 宿主重启后都还能看到这段历史（失败静默，不影响沉淀）
    appendCaptureLog(entry, process.env).catch(() => {})
    if (++logWrites % 100 === 0) rotateCaptureLog(process.env).catch(() => {})
    if (action === 'fail') { health.fail(reason); touchPrompt() }
    else if (action === 'created' || action === 'appended') { health.succeed(); touchPrompt() }
    // 只要监听器还在拿到轮次（listen 行）就说明管线活着 —— 停滞告警自动撤销。
    if (action !== 'fail') {
      lastActivityAt = Date.now()
      if (stallAlerted && health.snapshot().ok === false) { stallAlerted = false; health.succeed(); touchPrompt() }
    }
  }
  const preview = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  // 单次沉淀送进 LLM 的对话上限（字符）：够覆盖一轮长对话，又不会把整段历史塞进去。
  const CAPTURE_TEXT_MAX = 20000
  // 启动留痕：面板里看不到这条 = host 半边没加载（而不是「没东西可沉淀」）。
  {
    const c = settings.get() ?? {}
    // 先把上次进程的历史读回面板（重启不丢记录），再写下本次 boot 行
    readCaptureLog(CAPTURE_LOG_MAX, process.env).then((old) => {
      for (const e of old.reverse()) captureLog.unshift(e)
      if (captureLog.length > CAPTURE_LOG_MAX) captureLog.splice(0, captureLog.length - CAPTURE_LOG_MAX)
    }).catch(() => {})
    logCapture('system', 'boot', `记忆核心 v${versionRef || '?'} 已加载：自动沉淀 ${c.enabled !== false && c.autoCapture !== false ? '开' : '关'} · 库 ${vaultDir()}`)
    // 安装完整性自检（issue #14）：插件市场装出来的副本可能缺 web/ 静态资源，那时侧边栏
    // 「记忆」弹窗只会是一页 ENOENT JSON。启动就写进自动沉淀日志/健康态，别等用户点开才发现。
    {
      const missing = missingWebAssets(PACKAGE_ROOT)
      if (missing.length) {
        logCapture('system', missing.includes('app.js') ? 'fail' : 'warn', missingAssetsReason(missing, PACKAGE_ROOT))
      }
    }
  }
  const lastCaptureAt = new Map() // sessionId -> 上次实际发起蒸馏的时间戳

  const scheduleCapture = (agent, events) => {
    const cfg = settings.get() ?? {}
    const sessionId = agent?.session?.id ?? agent?.id ?? 'unknown'
    if (!cfg.enabled || !cfg.autoCapture) return
    if (!Array.isArray(events) || events.length === 0) {
      logCapture(sessionId, 'listen', '读不到会话事件：agent.session 无 events/snapshotEvents（DSH 版本不匹配）')
      return
    }
    const existing = pending.get(sessionId)
    // 连续轮次合并：把新事件接到待处理队列尾，一次 LLM 调用处理。
    if (existing) {
      existing.events.push(...events)
      return
    }
    const job = { events }
    pending.set(sessionId, job)
    captureQueue = captureQueue.then(() => runCapture(agent, job))
  }

  // 日配额：滚动 24h 内的「实际写卡」计数。只在真的写卡/追加后记一笔——
  // 之前是「每发起一次判定就记一笔」，模型回 {save:false} 也照样扣配额，
  // 40 次低价值判定就能把配额耗光、之后 24h 全部静默不再沉淀。
  const lastDayStamps = []
  const countWrite = () => { lastDayStamps.push(Date.now()) }
  const quotaUsed = () => {
    const dayStart = Date.now() - 86400000
    while (lastDayStamps.length && lastDayStamps[0] < dayStart) lastDayStamps.shift()
    return lastDayStamps.length
  }
  const underDailyQuota = (max) => quotaUsed() < (max ?? 60)

  // 自动审核：根据配置决定新卡 status（免审→approved，否则 pending）
  const resolveAuditStatus = (cfg, kind, submittedBy) => {
    if (cfg.auditMode === 'none') return 'approved'
    const agents = Array.isArray(cfg.auditExemptAgents) ? cfg.auditExemptAgents : []
    const kinds = Array.isArray(cfg.auditExemptKinds) ? cfg.auditExemptKinds : []
    if (agents.includes('__all__') || agents.includes(submittedBy)) return 'approved'
    if (kinds.includes('__all__') || kinds.includes(kind)) return 'approved'
    return 'pending'
  }

  const runCapture = async (agent, job) => {
    const sessionId = agent?.session?.id ?? agent?.id ?? 'unknown'
    const events = Array.isArray(job?.events) ? job.events : []
    try {
      const cfg = settings.get() ?? {}
      if (!cfg.enabled || !cfg.autoCapture) return
      // 本会话实际使用的库（#15）：会话工作区命中 vaultProfiles[].match.workspace 时写进对应项目库。
      const root = vaultDir(sessionWorkspace(agent))
      if (root !== vaultDir()) syncAudit(root)
      const llm = ctx.get('llm')
      // 水位从 0 开始的那一轮（重启后同一会话的第一轮）会把整段历史切进来——
      // 只取尾部，避免一次超大 LLM 调用（超上下文/超时）。
      const raw = extractLastTurn(events)
      const text = raw.length > CAPTURE_TEXT_MAX ? raw.slice(-CAPTURE_TEXT_MAX) : raw
      logCapture(sessionId, 'listen', `会话事件 ${events.length} 条 → 有效对话 ${text.length} 字${raw.length > text.length ? '（超长已截尾）' : ''}`, { preview: preview(text) })
      // 噪声闸门（P0）：extractLastTurn 已剥掉运行时注入（环境快照 / team 广播 / 工具说明），
      // 这里再判一次「剥完还有没有真实内容」——只有注入残留的轮次不进 LLM、不写卡。
      if (!hasUsableContent(text)) {
        logCapture(sessionId, 'skip', `有效内容不足：剥离运行时注入后只剩 ${text.trim().length} 字（多为环境快照 / 广播 / 工具说明）`)
        return
      }
      if (text.length < (cfg.captureMinChars ?? 200)) {
        logCapture(sessionId, 'skip', `内容太短：${text.length} < ${cfg.captureMinChars ?? 200} 字（调小「捕获最小长度」可放宽）`)
        return
      }
      // 会话冷却：同一会话频繁收尾时避免每轮都烧一次 LLM。
      const cooldown = Number(cfg.captureCooldownMs) || 0
      const lastAt = lastCaptureAt.get(sessionId) ?? 0
      if (cooldown > 0 && Date.now() - lastAt < cooldown) {
        logCapture(sessionId, 'skip', `冷却中：距上次沉淀 ${Math.round((Date.now() - lastAt) / 1000)}s < ${Math.round(cooldown / 1000)}s`)
        return
      }
      // 日配额：防止一次大扫荡烧光 token（只统计真正写卡/追加的次数）。
      if (!underDailyQuota(cfg.maxCardsPerDay)) {
        logCapture(sessionId, 'skip', `日配额已满（24h 已写 ${quotaUsed()} 张 / 上限 ${cfg.maxCardsPerDay ?? 60}）`)
        return
      }
      lastCaptureAt.set(sessionId, Date.now())
      // 成本控制：distillEnabled=false 时不调 LLM，直接存原文卡（零蒸馏成本）
      const source = DSH_AGENT
      if (cfg.distillEnabled === false || !llm) {
        const rawTitle = deriveTitle(text)
        const out = await captureCard(root, {
          kind: 'content',
          title: rawTitle.length >= 6 && !looksTruncated(rawTitle) ? rawTitle : '对话原文记录',
          tags: ['raw'],
          body: text,
          source,
          status: resolveAuditStatus(cfg, 'content', source || 'unknown'),
          submittedBy: source || 'unknown',
          severity: 'info',
          reason: 'AI 自动沉淀（原文卡）',
        }, { threshold: cfg.dedupThreshold })
        if (out.ok) { countWrite(); logCapture(sessionId, 'created', '原文卡（蒸馏已关闭）', { path: out.path ?? out.rel, kind: 'content' }) }
        else if (out.duplicate) { countWrite(); logCapture(sessionId, 'appended', '与已有卡重复 → 追加更新记录', { path: out.duplicate.path }) }
        else logCapture(sessionId, 'fail', `写卡失败：${out.reason || '未知原因'}`)
        return
      }
      // 候选路由：显式配置优先，其余按注册顺序兜底（多 provider 下 providers[0] 可能是没配 key 的官方 provider → issue #3）。
      const routes = await routeCandidates(llm, { provider: cfg.captureProvider, model: cfg.captureModel })
      if (!routes.length) { logCapture(sessionId, 'fail', '取不到模型路由（llm.listProviders 为空）'); return }
      // 语义去重近邻：把已有卡片索引喂给模型，让模型决定新建 vs 追加。
      // 成本控制：dedupByLLM=false 时跳过喂 LLM 的近邻采样（纯词法去重兜底）。
      const draft = { title: '', body: text.slice(0, 400) }
      const neighbors = cfg.dedupByLLM === false ? [] : await pickNeighbors(root, draft, 8)
      let route = routes[0]
      let result = null
      let failure = null          // 主失败 = **第一个**候选的失败（通常是显式配置的那个，信息量最大）
      const failures = []         // 全部候选的失败，用于汇总上报（#18 根因 2）
      const maxTokens = Number(cfg.captureMaxTokens) || DEFAULT_CAPTURE_MAX_TOKENS
      for (let i = 0; i < routes.length; i++) {
        route = routes[i]
        let detailed = await summarizeTurnDetailed(llm, route, text, { signal: AbortSignal.timeout(45000), existing: neighbors, maxTokens })
        // #18 建议 3 + #24：撞输出上限不是「模型坏了」，把上限一路翻倍到 schema 上限。
        // 旧实现只翻倍**一次**：1200 → 2400 仍不够就照样退成原文卡，尽管 4000 本来装得下
        // （issue #24 里 9 次失败中有一半正是被这一限制吃掉的）。
        let prevBudget = maxTokens
        for (const bigger of maxTokenLadder(maxTokens)) {
          logCapture(sessionId, 'listen', `输出撞到 maxTokens=${prevBudget} 上限 → 以 ${bigger} 重试同一候选（${route.provider}/${route.model}）`)
          detailed = await summarizeTurnDetailed(llm, route, text, { signal: AbortSignal.timeout(45000), existing: neighbors, maxTokens: bigger })
          prevBudget = bigger
          if (!(detailed.failure && detailed.failure.code === 'MAX_TOKENS')) break
        }
        if (detailed.card !== undefined) { result = detailed.card; failure = null; break }
        if (detailed.failure) {
          const f = { ...detailed.failure, provider: route.provider, model: route.model }
          failures.push(f)
          // 只保留第一个：旧实现每轮覆盖，最终上报的是**最后一个兜底候选**的错误，
          // 真正有信息量的主因被彻底丢弃（#18 根因 2）。
          if (!failure) failure = f
          const more = i < routes.length - 1
          logCapture(sessionId, 'fail', `蒸馏调用失败（${route.provider}/${route.model}）：${f.code} ${f.message}${more ? ' → 换下一个 provider 重试' : ''}`)
          if (more) continue
        }
        break // skip（太短 / 不值得保存）或没有更多候选
      }
      // 真失败要亮红并进提示段：此前只有笼统的「蒸馏无输出」，真实原因（如缺凭证）完全不可见。
      if (failure) { health.fail(`蒸馏失败（${failure.provider}）：${failure.code} ${failure.message}`); touchPrompt() }
      // 主因 + 兜底候选失败汇总：卡片 reason 与 created 日志都用这个，避免把排查者引向错误方向。
      const why = failure ? describeDistillFailure(failure, failures) : '无可用产出'
      if (!result) {
        // 蒸馏失败不能让内容白丢：退成原文卡（与「关闭蒸馏」同一条降级路径）。
        const rawTitle = deriveTitle(text)
        const raw = await captureCard(root, {
          kind: 'content',
          title: rawTitle.length >= 6 && !looksTruncated(rawTitle) ? rawTitle : '对话原文记录',
          // 蒸馏失败产出的原文卡与被批准的噪声卡是审核中心的主要污染源（#15 评论）：
          // 打上独立 tag，便于按 tag 过滤 / 批量处理，不再和正常卡混作一团。
          tags: ['raw', 'distill-failed'],
          body: text,
          source,
          status: resolveAuditStatus(cfg, 'content', source),
          submittedBy: source,
          severity: 'info',
          reason: `AI 自动沉淀（蒸馏无输出 → 原文卡兜底；主因：${why}）`,
        }, { threshold: cfg.dedupThreshold })
        if (raw.ok) { countWrite(); logCapture(sessionId, 'created', `蒸馏失败（${why}）→ 原文卡兜底`, { path: raw.path ?? raw.rel, kind: 'content', model: route.model }) }
        else if (raw.duplicate) { countWrite(); logCapture(sessionId, 'appended', '蒸馏无输出 + 与已有卡重复 → 追加更新', { path: raw.duplicate.path, model: route.model }) }
        else logCapture(sessionId, 'fail', `蒸馏无输出，且兜底原文卡也失败：${raw.reason || '未知原因'}`, { model: route.model })
        return
      }
      if (result.save !== true) { logCapture(sessionId, 'skip', '模型判定不值得保存', { model: route.model }); return }
      if (result.append_to) {
        // 模型判定属于已有卡 → 追加更新记录，不新建（boujoy 语义）。
        await captureUpdate(root, result.append_to, result.update, { threshold: cfg.dedupThreshold })
        countWrite()
        logCapture(sessionId, 'appended', '模型判定属于已有卡 → 追加更新', { path: result.append_to, model: route.model })
        return
      }
      const card = {
        kind: result.kind,
        title: result.title,
        tags: result.tags,
        body: result.body,
        source: DSH_AGENT,
        status: resolveAuditStatus(cfg, result.kind, DSH_AGENT),
        submittedBy: DSH_AGENT,
        severity: 'info',
        reason: 'AI 自动沉淀（蒸馏卡）',
      }
      const out = await captureCard(root, card, { threshold: cfg.dedupThreshold })
      if (out.ok) {
        countWrite()
        logCapture(sessionId, 'created', `新卡：${card.title}（${card.status === 'approved' ? '已入库' : '待审核'}）`, { path: out.path ?? out.rel, kind: card.kind, model: route.model })
        return
      }
      if (out.duplicate) {
        // 词法兜底：高度相似 → 追加更新记录而不是再建一张重复卡。
        await captureUpdate(root, out.duplicate.path, `${result.title}：${result.body.slice(0, 400)}`, {
          threshold: cfg.dedupThreshold,
        })
        countWrite()
        logCapture(sessionId, 'appended', '词法去重命中 → 追加更新记录', { path: out.duplicate.path, model: route.model })
        return
      }
      logCapture(sessionId, 'fail', `写卡失败：${out.reason || '未知原因'}`)
    } catch (error) {
      logCapture(sessionId, 'fail', `异常：${error?.message || error}`)
      console.error('[memory-eternal] capture failed:', error)
    } finally {
      // 运行期间若又累积了新事件，保留队列给下一轮 run 处理，避免丢事件。
      if (pending.get(sessionId) === job) pending.delete(sessionId)
    }
  }

  const lastSeqs = new Map() // sessionId -> 已处理到的 seq 水位
  const lastTouched = new Map() // sessionId -> 上次监听时间（用于清理，避免 Map 无界增长）
  // 轮次计数：inbox/claimed 每轮必发（不依赖 turn-stopping），两个计数器对不上
  // 就说明收尾事件没到——这是「监听器整个没被调用」这类静默死亡的兜底探测。
  let turnsStarted = 0
  let turnsStopped = 0
  // 滑动窗口用的时间戳（旧版只留累积计数，导致误报+漏报，见 lib/stall.js）
  const claimedAt = []
  const stoppedAt = []
  const stamp = (arr) => { arr.push(Date.now()); if (arr.length > MAX_STAMPS) arr.shift() }
  ctx.on('agent/inbox/claimed', () => { turnsStarted += 1; stamp(claimedAt) })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    turnsStopped += 1
    stamp(stoppedAt)
    const sessionId = agent?.session?.id ?? agent?.id ?? 'unknown'
    try {
      const api = sessionEventApi(agent?.session)
      const first = !lastTouched.has(sessionId)
      const all = sessionEvents(agent?.session)
      // 水位默认 -1：新会话「已处理到」的位置在第一条事件之前，seq 0 不该被跳过。
      const lastSeq = lastSeqs.get(sessionId) ?? -1
      const fresh = sliceNewEvents(all, lastSeq)
      if (all.length) lastSeqs.set(sessionId, Math.max(lastSeq, all[all.length - 1].seq ?? lastSeq))
      // 每个会话第一次收尾留一条接入记录：接口名 + 事件数 + 新增数。
      // 这样「面板一条都没有」只会意味着监听器没跑，而不是看不出所以然。
      if (first) {
        logCapture(sessionId, api ? 'listen' : 'fail', api
          ? `会话接入：事件接口 ${api}，事件 ${all.length} 条，新增 ${fresh.length} 条`
          : '会话对象没有事件接口（events/ownEvents/snapshotEvents 都不认识）——DSH 改了接口，需要适配')
      }
      lastTouched.set(sessionId, Date.now())
      if (fresh.length) scheduleCapture(agent, fresh)
      // 1 天没动静的会话水位清理掉（长跑进程里会话数会一直涨）。
      if (lastTouched.size > 200) {
        const cut = Date.now() - 86400000
        for (const [id, t] of lastTouched) {
          if (t < cut) { lastTouched.delete(id); lastSeqs.delete(id); lastCaptureAt.delete(id) }
        }
      }
    } catch (error) {
      // 监听器里抛异常等于管线静默死亡（页面只表现为「一直不写卡」）——记进日志。
      logCapture(sessionId, 'fail', `监听异常：${error?.message || error}`)
      console.error('[memory-eternal] turn-stopping listener failed:', error)
    }
  })

  // -- 2. 自动召回：systemPrompt 分段 + memory_recall 工具 -----------------
  ctx.effect(() => {
    let disposeSection = null
    const refresh = (cfg) => {
      if (disposeSection) {
        const dispose = disposeSection
        disposeSection = null
        dispose()
      }
      if (!cfg || cfg.enabled === false || cfg.autoRecall !== true) return
      const text = [
        '你拥有一个本地「记忆核心」（SQLite 知识库，位于 ' + vaultDir() + '）。',
        '规则：',
        '1. 每轮对话结束后，值得长期复用的内容会被自动沉淀成知识卡，你无需询问用户、也无需手动保存。',
        '2. 当任务需要项目背景、历史决策、之前讨论过的方案或领域知识时，先调用 memory_recall 检索相关卡片，再作答。',
        '3. 若检索结果为空，就诚实说明当前记忆库没有相关内容，不要编造。',
        '4. 知识卡存储在 SQLite 数据库中（memory-eternal.db），**禁止**用文件工具直接读写 vault 目录下的任何文件。沉淀记忆必须通过 memory_recall 工具或 /memory-eternal/api/write API。',
        '5. 若下方出现「自动沉淀异常」，必须在本次回复的第一句用中文转述该异常并提醒用户处理，不要自行猜测或尝试修复。',
        // 审核红线（主上 2026-09-12 强制要求）：只在审核真正生效时注入。
        ...((cfg.auditMode ?? 'all') === 'none' ? [] : [
          '6. **审核红线（强制）**：写卡一律停在 pending，由用户在「审核中心」审批。**禁止**调用 /memory-eternal/api/audit/approve 或 /audit/reject 代替用户审批，也不得用任何等价方式绕过审核；用户说「记录一下 / 增加记忆」不等于允许免审入库。需要立刻可用时，写卡后明确告知用户「已进审核中心，待批准」。',
        ]),
        // 凭证取用提示（用户自己填的整句，见 Config.secretHint）：只在填了非空值时注入。
        // 为什么走 systemPrompt 而不是「往卡里写值」：密钥的**值**入库会被每次召回带进模型
        // 上下文（card.summary = 正文前 200 字，召回默认取前 130 字），而 agent 真正需要的
        // 只是「去哪取、怎么取」——这句负责**触发**，目录卡负责细节，值留在本机凭据库。
        ...((cfg.secretHint || '').trim() ? [String(cfg.secretHint).trim()] : []),
      ].join('\n')
      // 异常提示：沉淀管线坏了，靠这一句把消息送到用户面前（不依赖用户去翻页面）。
      const h = health.snapshot()
      const alert = h.ok ? '' : [
        '',
        '⚠ 自动沉淀异常（记忆核心 memory-eternal）——' + h.reason,
        '（发生时间：' + new Date(h.since).toLocaleString() + '。请在回复第一句提醒用户：自动沉淀异常 + 上述原因；'
          + '并可提示用户打开 设置→记忆→用量/今日 查看「自动沉淀日志」；若原因是接口/版本不匹配，需更新 memory-eternal 插件。）',
      ].join('\n')
      disposeSection = ctx.systemPrompt.section({
        name: 'memory-eternal: auto-recall',
        order: 600,
        text: text + alert,
      })
    }
    refreshPrompt = refresh
    refresh(settings.get())
    const unwatch = settings.watch(refresh)
    return () => {
      if (refreshPrompt === refresh) refreshPrompt = null
      if (typeof unwatch === 'function') unwatch()
      if (disposeSection) disposeSection()
    }
  }, 'memory-eternal: recall section')

  const tools = ctx.get('tools')
  if (tools !== undefined) {
    tools.register(defineTool({
      name: 'memory_recall',
      description:
        '从本地记忆核心（Markdown 知识库）检索相关知识卡。需要项目背景、历史决策、之前讨论过的方案、' +
        '或领域知识时调用；返回最相关的卡片摘要。用 query 描述要找的内容，支持中文整词与字符片段检索。' +
        '需要 API key / token / 令牌等**凭证**时也先查这里（查「密钥 目录」）：记忆里存的是目录' +
        '（名字、存放位置、取用命令），**值不在记忆库里**，请按卡片给的本机命令取用，不要直接读凭据文件。',
      parameters: {
        query: { type: 'string', required: true, description: '检索关键词或自然语言描述，如「数据库选型」「用户偏好」' },
        limit: { type: 'number', description: '返回卡片数上限，默认 5' },
        scope: { type: 'string', description: '可选作用域：库名（vaultProfiles 里的 name）、路径前缀，或 all 跨全部库聚合；留空 = 当前激活库' },
      },
      output: {
        schema: { type: 'string' },
        render(_a, v) { return [{ type: 'text', text: v }] },
      },
      timeoutMs: 20000,
      // 第二个参数是 ToolRunContext（含 caller agent）—— 用它取会话工作区，
      // 让「当前库」也按项目路由，而不是永远落在进程 cwd 对应的库（#15）。
      async execute(args, exec) {
        const cfg = settings.get() ?? {}
        if (!cfg.enabled) return '（记忆核心已禁用）'
        const query = String(args.query || '').trim()
        if (!query) return '（未提供检索词）'
        const workspace = sessionWorkspace(exec && exec.agent)
        const cfg2 = settings.get() ?? {}
        const defLimit = Number(cfg2.recallLimit) || 5
        const defLen = Number(cfg2.recallSummaryLen) || 130
        const includeBody = cfg2.recallIncludeBody === true
        const limit = Math.min(Math.max(Number(args.limit) || defLimit, 1), 20)
        // 作用域（#10）：留空 = 当前激活库；all = 跨库聚合；库名 = 指定 profile；路径前缀 = 命中多个库
        const scope = String(args.scope || '').trim()
        const roots = vaultRoots(workspace)
        let targets = [{ name: '', root: vaultDir(workspace) }]
        let scoped = false
        if (scope) {
          const want = scope.toLowerCase()
          if (want === 'all') {
            targets = roots
            scoped = true
          } else {
            const byName = roots.filter((r) => String(r.name || '').toLowerCase() === want)
            const prefix = scope.replace(/\\/g, '/').toLowerCase()
            const byPath = roots.filter((r) => r.root.replace(/\\/g, '/').toLowerCase().startsWith(prefix))
            targets = byName.length ? byName : byPath
            if (!targets.length) {
              return `未找到匹配「${scope}」的记忆库。可用：${roots.map((r) => r.name || r.root).join('、')}（也可用 scope=\"all\" 跨库检索）`
            }
            scoped = true
          }
        }
        const multi = scoped
        let hits = []
        for (const target of targets) {
          try {
            const part = await search(target.root, query, { limit, minScore: 2 })
            for (const h of part) hits.push(multi ? { ...h, vault: target.name || target.root } : h)
          } catch { /* 单个库失败不影响其它库 */ }
        }
        if (multi) hits = hits.slice(0, limit)
        if (hits.length === 0) return `记忆库中没有与「${query}」相关的内容。`
        const lines = hits.map((h, i) => {
          const tags = h.tags.length ? ` [${h.tags.join(', ')}]` : ''
          const snippet = String(h.summary || '').replace(/\s+/g, ' ').trim().slice(0, defLen)
          const body = includeBody ? `\n${String(h.excerpt || '').slice(0, 800)}` : ''
          const from = h.vault ? `（库：${h.vault}）` : ''
          return `### ${i + 1}. ${h.title}${tags}${from}\n路径：${h.path}\n${snippet}${body}`
        })
        const where = multi ? `（作用域 ${scope || 'all'}，共 ${targets.length} 个库）` : ''
        return `从记忆核心检索到 ${hits.length} 条相关卡片${where}：\n\n${lines.join('\n\n')}`
      },
    }))
  }

  // 沉淀停滞探测：只有「有轮次在跑」且「管线 15 分钟一个活口都没有」才报（真死才报）。
  // 计数器对不上是常态（子代理轮次、被取消的轮次都不发 turn-stopping），单看计数会误报刷屏。
  const stallTimer = setInterval(() => {
    const { alert, started, stopped, windowMs } = evaluateStall({ claimedAt, stoppedAt })
    if (alert && !stallAlerted) {
      stallAlerted = true
      logCapture('system', 'fail', `轮次收尾事件疑似失效：最近 ${Math.round(windowMs / 60000)} 分钟内开始 ${started} 个轮次、收尾 ${stopped} 个（累计 ${turnsStarted}/${turnsStopped}）——DSH 可能改了事件名或作用域`)
    }
  }, 5 * 60 * 1000)
  ctx.effect(() => () => clearInterval(stallTimer), 'memory-eternal: capture stall watch')

  // 回收站清理：每 30 分钟永久删除超过保留期（默认 30 天）的软删卡。
  const purgeTimer = setInterval(() => {
    const cfg = settings.get() ?? {}
    const days = Number(cfg.recycleRetentionDays) || 30
    import('./lib/vault.js').then((v) => v.purgeExpired(vaultDir(), days)).catch(() => {})
  }, 30 * 60 * 1000)
  ctx.effect(() => () => clearInterval(purgeTimer), 'memory-eternal: recycle purge timer')

  // SQLite 定时备份：每天凌晨 3 点自动备份，保留最近 7 天。
  let lastBackupDate = ''
  const backupTimer = setInterval(async () => {
    const d = new Date()
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (lastBackupDate === date || d.getHours() !== 3) return
    lastBackupDate = date
    try {
      const r = await backupDb(vaultDir(), { maxKeep: 7 })
      if (r.ok) console.error(`[memory-eternal] backup done: ${r.path}`)
    } catch (e) { console.error('[memory-eternal] backup failed:', e?.message || e) }
  }, 10 * 60 * 1000) // 每 10 分钟检查一次，命中凌晨 3 点才执行
  ctx.effect(() => () => clearInterval(backupTimer), 'memory-eternal: backup timer')

  // -- 3. 知识库 JSON API（客户端设置页数据源） ----------------------------
  // 多宿主状态：web server 常驻地址（ensureWebServer 的结果，client 壳经
  // /web-info 读取后用 iframe 渲染 web 端 UI——DSH 渲染也走 web，单一真源）。
  let webInfo = { url: 'http://127.0.0.1:7999', port: 7999, alive: false }
  const refreshWebInfo = (info) => { if (info && info.url) webInfo = { ...info, alive: true } }

  // webServer 是「可能晚到」的服务：apply 执行时它常常尚未挂载，同步 ctx.get()
  // 拿不到就整段跳过、且不留任何日志 —— 表现是 /memory-eternal/api/* 恒 404、
  // 客户端设置页永远停在「加载中…」。改用 ctx.inject() 等服务就绪后再注册：
  // 没有该服务的 profile（如 TUI）里子 fiber 保持 pending，主插件照常激活。
  // （DSH 自身的 dsh-client-modules 也是这么写的：ctx.inject(['webServer'], …)）
  const registerApiRoutes = (webServer) => {
    const handleApi = createApi({
      vaultDir, vaultRoots, getSettings: settings.get,
      // 自动沉淀运行轨迹 + 健康状态：供「用量/今日」页排查「为什么没写卡」，异常时页面顶部亮红。
      getCaptureLog: () => captureLog.slice().reverse(),
      getCaptureHealth: () => health.snapshot(),
      getDshInfo: () => ({
        name: 'deepseek-harness',
        label: 'DeepSeek Harness（当前宿主）',
        installed: true,
        memoryRecallTool: !!ctx.get('tools'),
        autoCapture: (settings.get() ?? {}).autoCapture !== false,
        autoRecall: (settings.get() ?? {}).autoRecall !== false,
        vaultDir: vaultDir(),
        version: versionRef,
      }),
    })
    webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          const pathname = new URL(req.url, 'http://localhost').pathname
          if (pathname === API_PREFIX + '/web-info') {
            return json(res, 200, { ok: true, ...webInfo })
          }
          if (pathname === API_PREFIX + '/events') {
            // SSE 长连接：不 end，保持推送（EventSource 自动重连）
            hub.add(res)
            return
          }
          if (pathname === API_PREFIX + '/setup-run') {
            // 「补全 MCP」：真正执行 runSetup（写外部 agent 配置），返回每项结果，成功/失败可见
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
            try {
              const { runSetup } = await import('./lib/setup.js')
              const out = await runSetup({ log: () => {}, enabled: true })
              json(res, 200, { ok: true, results: out.results })
            } catch (e) {
              json(res, 500, { ok: false, error: String(e?.message || e) })
            }
            return
          }
          if (pathname === API_PREFIX + '/mcp/action') {
            // 单智能体安装/卸载 MCP：POST {agent, action}
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
            try {
              const chunks = []
              for await (const chunk of req) chunks.push(chunk)
              const raw = Buffer.concat(chunks).toString('utf8')
              const body = JSON.parse(raw || '{}')
              const agent = String(body.agent || '')
              const action = String(body.action || '')
              const { mcpAgentAction } = await import('./lib/setup.js')
              const out = await mcpAgentAction(agent, action, { log: () => {} })
              json(res, 200, out)
            } catch (e) {
              json(res, 500, { ok: false, error: String(e?.message || e) })
            }
            return
          }
          if (pathname === API_PREFIX + '/config') {
            const method = req.method || 'GET'
            if (method === 'GET') {
              const cfg = settings.get() ?? {}
              // 只暴露可安全展示/回填的字段
              const safe = {
                autoCapture: cfg.autoCapture, autoRecall: cfg.autoRecall, recallLimit: cfg.recallLimit, recallSummaryLen: cfg.recallSummaryLen, recallIncludeBody: cfg.recallIncludeBody, secretHint: cfg.secretHint || '',
                captureMinChars: cfg.captureMinChars, captureCooldownMs: cfg.captureCooldownMs, dedupThreshold: cfg.dedupThreshold, maxCardsPerDay: cfg.maxCardsPerDay,
                distillEnabled: cfg.distillEnabled, dedupByLLM: cfg.dedupByLLM, captureMaxTokens: cfg.captureMaxTokens, recallMinScore: cfg.recallMinScore,
                autoWeb: cfg.autoWeb, autoWebMode: cfg.autoWebMode, webPort: cfg.webPort, webCheckIntervalMs: cfg.webCheckIntervalMs, webMaxRestart: cfg.webMaxRestart, watchdogAutoSpawn: cfg.watchdogAutoSpawn, autoRestartOnDrift: cfg.autoRestartOnDrift, autoMcpSetup: cfg.autoMcpSetup,
                auditMode: cfg.auditMode ?? 'all', auditExemptAgents: cfg.auditExemptAgents || [], auditExemptKinds: cfg.auditExemptKinds || [], recycleRetentionDays: cfg.recycleRetentionDays ?? 30,
                // 多库（#10）：配置页可直接编辑
                vaultProfiles: Array.isArray(cfg.vaultProfiles) ? cfg.vaultProfiles : [],
                activeVault: cfg.activeVault || '',
                // 配置覆盖补齐（用户要求「配置按钮全覆盖」）：这些以前只能手改配置文件
                enabled: cfg.enabled !== false,
                vaultDir: cfg.vaultDir || '',
                captureProvider: cfg.captureProvider || '',
                captureModel: cfg.captureModel || '',
                recallEmbedding: cfg.recallEmbedding || '',
                sessionBudgetChars: cfg.sessionBudgetChars ?? 80000,
              }
              const descriptor = (ctx.get('settings') ?? {}).describe?.({ redactSecrets: true }) ?? []
              const me = descriptor.find((d) => d.ns === 'memory-eternal')
              const dshInfo = {
                name: 'deepseek-harness',
                label: 'DeepSeek Harness（当前宿主）',
                installed: true,
                memoryRecallTool: !!ctx.get('tools'),
                autoCapture: cfg.autoCapture !== false,
                autoRecall: cfg.autoRecall !== false,
                vaultDir: vaultDir(),
                vaultName: vaultInfo().name,
                vaultSource: vaultInfo().source,
                workspace: vaultInfo().workspace,
                version: versionRef,
              }
              return json(res, 200, { ok: true, config: safe, revision: me?.revision ?? 0, writable: true, readonly: false, schema: me?.schema ?? null, dsh: dshInfo, version: versionRef })
            }
            if (method === 'POST') {
              try {
              const cfgChunks = []
              for await (const chunk of req) cfgChunks.push(chunk)
              const raw = Buffer.concat(cfgChunks).toString('utf8')
              let body = {}
              try { body = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
              const patch = body.patch ?? {}
              const expectedRevision = Number.isInteger(body.expectedRevision) ? body.expectedRevision : undefined
              // 仅允许写入 Config 中声明过的键（白名单，防注入）。schemastery 用 .dict 存 object schema 字段表。
              const allowed = new Set(Object.keys(Config.dict || {}))
              const clean = {}
              for (const k of Object.keys(patch)) { if (allowed.has(k)) clean[k] = patch[k] }
              if (Object.keys(clean).length === 0) return json(res, 400, { ok: false, error: '无可写入字段' })
              // 数值字段前置校验：空串/NaN/非数字直接给「哪个字段不合法」，而不是让宿主 schema 抛错
              const badNum = Object.entries(clean).filter(([k, v]) => typeof v === 'string' && v.trim() === '' && !/^(vaultDir|captureProvider|captureModel|recallEmbedding|activeVault)$/.test(k))
              if (badNum.length) return json(res, 400, { ok: false, error: '字段不能为空：' + badNum.map(([k]) => k).join('、'), fields: badNum.map(([k]) => k) })
              if (typeof settings.update === 'function') {
                try {
                  const writeResult = await settings.update(clean, expectedRevision)
                  // 把完整配置写入共享文件，让独立 web / MCP hook 与 DSH 设置同步（不同步修复）
                  syncConfigFile()
                  // 回读校验：宿主 volatile 回流可能滞后（issue #12），此时明确告知而不是假装成功
                  hub.broadcast('config', { at: Date.now(), source: 'dsh', applied: Object.keys(clean) })
                  const now = settings.get() ?? {}
                  const pending = Object.keys(clean).filter((k) => JSON.stringify(now[k]) !== JSON.stringify(clean[k]))
                  return json(res, 200, {
                    ok: true,
                    applied: Object.keys(clean),
                    pending,
                    retried: !!(writeResult && writeResult.retried),
                    note: pending.length
                      ? '已写入；宿主尚未回流这些值（面板已本地生效，重启 DSH 后以配置文件为准）'
                      : '已保存。autoWebMode/watchdogAutoSpawn/webPort 等需重启 DSH 生效；若已有常驻 watchdog，关闭/改参不会自动停掉它，需 dsh-memory stop / restart（#19）。版本漂移（升级后端口上仍是旧代码）由 autoRestartOnDrift 在下次激活时自动重启常驻实例，也可在「插件信息」点「重启常驻实例」立刻处理',
                  })
                } catch (e) {
                  if (e && e.code === 'SETTINGS_CONFLICT') return json(res, 409, { ok: false, error: '配置已被外部修改，请刷新后重试（revision conflict）' })
                  return json(res, 500, { ok: false, error: String(e?.message || e) })
                }
              }
              return json(res, 501, { ok: false, error: '当前环境不支持写配置' })
              } catch (e) {
                // 绝不返回空响应体：客户端拿到空 body 只能显示通用「保存失败」，无法定位（issue #12）
                try { return json(res, 400, { ok: false, error: '配置写入失败：' + String(e?.message || e) }) } catch { return }
              }
            }
            return json(res, 405, { ok: false, error: 'method not allowed' })
          }
          // DSH host 同源配置页 UI：/memory-eternal/ui/config + /memory-eternal/ui/app.js
          // 让 DSH iframe 的「配置」页在 host 同源加载 → /config API 同源可读写（修复独立 web 7979 /config 404 导致的「一直加载中」）
          if (pathname === API_PREFIX + '/ui/config' || pathname === API_PREFIX + '/ui/app.js') {
            const { readFile } = fs
            const webRoot = path.join(PACKAGE_ROOT, 'web')
            if (pathname.endsWith('app.js')) {
              const buf = await readFile(path.join(webRoot, 'app.js'))
              // client bundle 270KB，每次打开配置页都要重下 —— 支持 gzip 的客户端走压缩
              const headers = { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding' }
              const { body: out, encoding } = encodeBody(res, buf)
              if (encoding) headers['Content-Encoding'] = encoding
              headers['Content-Length'] = out.length
              res.writeHead(200, headers)
              return res.end(out)
            }
            const buf = await readFile(path.join(webRoot, 'index.html'))
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
            return res.end(buf)
          }
          await handleApi(req, res)
        } catch (error) {
          json(res, 500, { ok: false, error: String(error?.message || error) })
        }
      },
    })
  }

  // 等 webServer 就绪再注册宿主侧 API。注册成功留一条 boot 记录，
  // 便于在「设置 → 记忆 → 用量/今日」里确认路由到底挂上没有。
  ctx.inject(['webServer'], (child) => {
    const webServer = child.get('webServer')
    if (webServer === undefined) return
    registerApiRoutes(webServer)
    logCapture('system', 'boot', '记忆 API 路由已注册（/memory-eternal/api）')
  })

  // -- 4. 多宿主常驻：MCP 挂载 + web server 保活（按设置项分层） -----------------
  // 全部后台异步、静默失败：插件激活不能被外部环境问题卡住。
  let intervalTimer = null
  let watchdogProc = null
  ctx.effect(() => {
    const cfg0 = settings.get() ?? {}
    if (cfg0.enabled === false) return () => {}

    // (1) MCP 自动挂载：默认关闭；只有用户显式开启才动外部配置。
    if (cfg0.autoMcpSetup === true && process.env.MEMORY_ETERNAL_SKIP_AUTO !== '1') {
      import('./lib/setup.js')
        .then((m) => m.runSetup({ log: () => {} }))
        .catch(() => {})
    }

    // (2) web server：根据 autoWeb + autoWebMode 决策
    const mode = cfg0.autoWebMode || 'init'
    const port = Number(cfg0.webPort) || 7999
    const ensureOpts = { port, vaultRoot: vaultDir() }
    const ensureWeb = () => import('./lib/web.js')
      .then((m) => m.ensureWebServer(ensureOpts))
      .then((info) => { refreshWebInfo(info); return info })
      .catch((error) => console.error('[memory-eternal] web server failed:', error?.message || error))

    if (cfg0.autoWeb === true) {
      if (mode === 'manual') {
        // manual：不自动拉起；只在 dsh-memory open / WebFrame 触发 ensure
        import('./lib/web.js')
          .then((m) => m.probeWebServer(port))
          .then((alive) => { if (alive) refreshWebInfo({ url: `http://127.0.0.1:${port}`, port, spawned: false }) })
          .catch(() => {})
      } else if (mode === 'init') {
        // init：拉起一次（首次）；之后不管（用户已设了，那看门狗都不开）
        ensureWeb()
      } else if (mode === 'interval') {
        // interval：DSH 进程内 setInterval 周期保活
        const intervalMs = Number(cfg0.webCheckIntervalMs) || 5000
        const maxRestart = Number(cfg0.webMaxRestart) || 10
        let restartCount = 0
        const tick = async () => {
          if (restartCount >= maxRestart) {
            console.error(`[memory-eternal] web 已连续重启 ${maxRestart} 次，停止保活`)
            if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null }
            return
          }
          const alive = await import('./lib/web.js').then((m) => m.probeWebServer(port)).catch(() => null)
          if (!alive) {
            restartCount++
            console.error(`[memory-eternal] web 离线 → 第 ${restartCount}/${maxRestart} 次拉起`)
            await ensureWeb()
          } else {
            // 探到活则重置计数
            restartCount = 0
          }
        }
        // 立即跑一次（首启 + 间隔循环）
        ensureWeb()
        intervalTimer = setInterval(tick, intervalMs)
      }
    }

    // (3) 看门狗独立进程：默认不 spawn；开启时启动一个与 DSH 解耦的 node watchdog。
    const wdPort = Number(cfg0.webPort) || 7999
    if (cfg0.watchdogAutoSpawn === true && cfg0.autoWeb !== false) {
      import('./lib/watchdog.js')
        .then(async (m) => {
          // 先体检再决策（issue #19/#23）：同端口已有**活着的** watchdog 时不再 spawn ——
          // 旧实现每次都 spawn 一个、每次都打印 "spawned"，而新进程会在锁上让位退出，
          // 日志与实际状态完全相反。但「有实例在跑」不等于「跑的是新代码」：常驻 web 比
          // DSH 活得久，升级只换磁盘文件，所以这里问的是**端口上真正服务的版本**，
          // 漂移就用新代码重启它（autoRestartOnDrift），而不是继续委派给旧代码。
          const info = await m.inspectResident({ port: wdPort })
          const cur = m.currentPkgVersion()
          const decision = m.decideResidentAction({
            served: info.served,
            expect: cur,
            watchdogAlive: info.watchdogAlive,
            occupantIsOurs: info.occupantIsOurs,
            autoRestart: cfg0.autoRestartOnDrift !== false,
            residentStartedAt: info.residentStartedAt,
          })
          const servedLabel = info.served || '（旧版不自报版本）'

          if (decision.action === 'delegate') {
            const who = info.watchdog ? `pid=${info.watchdog.pid}` : '外部实例'
            const why = `watchdog delegated to ${who} port=${wdPort}（端口上服务 v${servedLabel}，本机 v${cur || '?'}${decision.reason === 'debounced' ? '；刚替换过，防抖窗口内不重复重启' : ''}）`
            console.error(`[memory-eternal] ${why}`)
            logCapture('system', 'boot', why)
            return
          }

          if (decision.action === 'restart') {
            // 「更新运行中的程序」的唯一安全形态 = 用新代码重启那个常驻进程（不是热替换内存里的模块）
            const why = `版本漂移：端口 ${wdPort} 上服务 v${servedLabel} ≠ 本机 v${cur}（${decision.reason}）→ 用新代码重启常驻实例`
            console.error(`[memory-eternal] ${why}`)
            logCapture('system', 'warn', why)
            const out = await m.restartResident({
              port: wdPort,
              vaultRoot: vaultDir(),
              interval: Number(cfg0.webCheckIntervalMs) || 5000,
              maxRestart: Number(cfg0.webMaxRestart) || 10,
            })
            const done = out.ok
              ? `常驻实例已重启：端口 ${wdPort} 正在服务 v${out.served}（等待 ${Math.round(out.waitedMs / 1000)}s）`
              : `常驻实例重启未确认生效（${out.stage}）：${out.error || '未知原因'} —— 可再试「设置 → 记忆 → 插件信息 → 重启常驻实例」，或执行 dsh-memory restart --port ${wdPort}`
            console.error(`[memory-eternal] ${done}`)
            logCapture('system', out.ok ? 'boot' : 'fail', done)
            return
          }

          if (decision.action === 'warn') {
            const why = `常驻实例版本漂移（端口上服务 v${servedLabel} ≠ 本机 v${cur}），但 autoRestartOnDrift 已关闭 → 不自动重启；可点面板「重启常驻实例」或执行 dsh-memory restart --port ${wdPort}`
            console.error(`[memory-eternal] ${why}`)
            logCapture('system', 'warn', why)
            return
          }

          // 端口上没有我们的服务（也没人占着）→ 照常拉起一个常驻 watchdog
          const port = wdPort
          // 用 nodeBinary() 而非 process.execPath：Electron 宿主下后者是 Electron
          // 主程序，spawn 出来不会执行 watchdog.js（见 lib/node-bin.js）。
          const bin = nodeBinary()
          const wd = spawn(
            bin,
            [path.join(PACKAGE_ROOT, 'lib', 'watchdog.js'), '--port', String(port), '--interval', String(cfg0.webCheckIntervalMs || 5000), '--max-restart', String(cfg0.webMaxRestart || 10)],
            { detached: true, stdio: 'ignore', env: childEnv({ MEMORY_VAULT_DIR: vaultDir() }), windowsHide: true },
          )
          // spawn 失败默认静默：既写 stderr，也进自动沉淀日志（面板可见）
          wd.on('error', (error) => {
            const why = `watchdog spawn 失败（${bin}）：${error?.message || error}`
            console.error(`[memory-eternal] ${why}`)
            logCapture('system', 'fail', why)
          })
          wd.unref()
          watchdogProc = wd
          console.error(`[memory-eternal] watchdog spawned pid=${wd.pid} bin=${bin} port=${port}`)
        })
        .catch((error) => {
          const why = `watchdog 模块加载失败：${error?.message || error}`
          console.error(`[memory-eternal] ${why}`)
          logCapture('system', 'fail', why)
        })
    } else if (cfg0.autoWeb !== false) {
      // 配置关掉了 watchdogAutoSpawn，但机器上可能仍有常驻实例（#19）：**故意不自动杀**
      // （多会话共用同一个 watchdog），但必须把「它还在跑」讲清楚，否则用户以为已经关了。
      import('./lib/watchdog.js')
        .then((m) => {
          const alive = m.readWatchdogLock(process.env).watchdogs.filter((w) => Number(w.port) === wdPort && m.isPidAlive(w.pid))
          if (!alive.length) return
          const why = `watchdogAutoSpawn 已关闭，但仍有常驻 watchdog pid=${alive.map((w) => w.pid).join(',')} port=${wdPort} 在运行（配置改动不会自动停掉既有实例）；如需停止请执行 dsh-memory stop --port ${wdPort}`
          console.error(`[memory-eternal] ${why}`)
          logCapture('system', 'warn', why)
        })
        .catch(() => {})
    }

    return () => {
      if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null }
      // 注意：watchdog 进程是独立的，**故意不杀**（7×24 与多会话共用同一个实例）。
      // 因此同端口下的配置变更（含关闭 watchdogAutoSpawn）不会自动停掉或替换既有实例，
      // 需要显式执行 dsh-memory stop / restart（issue #19）。
    }
  }, 'memory-eternal: multi-host ensure')

  // 首次激活时确保 vault 目录存在。
  ctx.effect(() => {
    const root = vaultDir()
    ensureVault(root).catch((error) => console.error('[memory-eternal] ensureVault failed:', error))
  }, 'memory-eternal: ensure vault')
}
