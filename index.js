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
import { summarizeTurn, extractLastTurn, sliceNewEvents, sessionEvents, sessionEventApi, createCaptureHealth, resolveRoute, captureCard, captureUpdate, pickNeighbors } from './lib/capture.js'
import { createApi, json, encodeBody } from './lib/api.js'
import { appendCaptureLog, readCaptureLog, rotateCaptureLog } from './lib/capture-log.js'
import { createSettingsHandle } from './lib/settings-compat.js'
import { nodeBinary, childEnv } from './lib/node-bin.js'

export const name = 'memory-eternal'
export const inject = ['systemPrompt', 'settings']

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
  // 蒸馏单次输出上限（token），越高越准越贵
  captureMaxTokens: z.number().min(100).max(4000).default(900),
  // 召回相关性阈值（minScore），越高召回越少越精越省
  recallMinScore: z.number().min(0).max(50).default(2),
  // 注入体积可配置（召回）
  recallLimit: z.number().min(1).max(20).default(5),
  recallSummaryLen: z.number().min(40).max(400).default(130),
  recallIncludeBody: z.boolean().default(false),
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

const API_PREFIX = '/memory-eternal/api'
// DSH 宿主自动沉淀卡的署名：用可读名而非 agent 会话 id，便于在智能体筛选中归组。
const DSH_AGENT = 'deepseek-harness'

export function apply(ctx, config) {
  // 跨 dsh 两代的设置句柄：0.1.6 及更早走 ctx.settings.register()，
  // 0.1.7+（register 已被移除）走 apply 传入的 config + configEditor 写回。
  // 详见 lib/settings-compat.js。
  const settings = createSettingsHandle(ctx, 'memory-eternal', Config, config)

  // 首次激活：自动从 .md 文件迁移到 SQLite（幂等，已有数据则跳过）
  const vaultDir = () => {
    const cfg = settings.get() ?? {}
    // 多 Vault：若配了 vaultProfiles 且选中了 activeVault，则用该 profile 的目录。
    const profiles = Array.isArray(cfg.vaultProfiles) ? cfg.vaultProfiles : []
    const active = String(cfg.activeVault || '').trim()
    const hit = active && profiles.find((p) => p.name === active)
    if (hit && hit.path && hit.path.trim()) return path.resolve(hit.path.trim())
    if (cfg.vaultDir && cfg.vaultDir.trim()) return path.resolve(cfg.vaultDir.trim())
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    return path.join(home, 'memory-vault')
  }

  // 自动迁移：从 .md 文件导入 SQLite（幂等，DB 有数据则跳过）
  try { migrateFromMarkdown(vaultDir()).catch(() => {}) } catch {}
  // 同步审核配置到 SQLite config 表（enforceAudit 从此表读取规则）
  const syncAudit = () => {
    try {
      const cfg = settings.get() ?? {}
      setAuditConfig(vaultDir(), { auditMode: cfg.auditMode, auditExemptAgents: cfg.auditExemptAgents, auditExemptKinds: cfg.auditExemptKinds })
    } catch {}
  }
  syncAudit()
  settings.watch(syncAudit)

  // 所有 profile 目录（当前激活 + 其余命名的），供跨库聚合。
  const vaultRoots = () => {
    const cfg = settings.get() ?? {}
    const active = vaultDir()
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
  const syncConfigFile = async () => {
    try {
      const cfg = settings.get() ?? {}
      const { configFilePath } = await import('./lib/capture-run.js')
      await (await import('node:fs')).promises.writeFile(configFilePath(process.env), JSON.stringify(cfg, null, 2), 'utf8')
    } catch { /* 静默 */ }
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
      const llm = ctx.get('llm')
      // 水位从 0 开始的那一轮（重启后同一会话的第一轮）会把整段历史切进来——
      // 只取尾部，避免一次超大 LLM 调用（超上下文/超时）。
      const raw = extractLastTurn(events)
      const text = raw.length > CAPTURE_TEXT_MAX ? raw.slice(-CAPTURE_TEXT_MAX) : raw
      logCapture(sessionId, 'listen', `会话事件 ${events.length} 条 → 有效对话 ${text.length} 字${raw.length > text.length ? '（超长已截尾）' : ''}`, { preview: preview(text) })
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
        const out = await captureCard(vaultDir(), {
          kind: 'content',
          title: text.replace(/\s+/g, ' ').slice(0, 40) || '未命名记录',
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
      const route = await resolveRoute(llm)
      if (!route) { logCapture(sessionId, 'fail', '取不到模型路由（llm.listProviders 为空）'); return }
      // 语义去重近邻：把已有卡片索引喂给模型，让模型决定新建 vs 追加。
      // 成本控制：dedupByLLM=false 时跳过喂 LLM 的近邻采样（纯词法去重兜底）。
      const draft = { title: '', body: text.slice(0, 400) }
      const neighbors = cfg.dedupByLLM === false ? [] : await pickNeighbors(vaultDir(), draft, 8)
      const result = await summarizeTurn(llm, route, text, { signal: AbortSignal.timeout(45000), existing: neighbors, maxTokens: cfg.captureMaxTokens ?? 900 })
      if (!result) {
        // 蒸馏失败不能让内容白丢：退成原文卡（与「关闭蒸馏」同一条降级路径）。
        const raw = await captureCard(vaultDir(), {
          kind: 'content',
          title: text.replace(/\s+/g, ' ').slice(0, 40) || '未命名记录',
          tags: ['raw'],
          body: text,
          source,
          status: resolveAuditStatus(cfg, 'content', source),
          submittedBy: source,
          severity: 'info',
          reason: 'AI 自动沉淀（蒸馏无输出 → 原文卡兜底）',
        }, { threshold: cfg.dedupThreshold })
        if (raw.ok) { countWrite(); logCapture(sessionId, 'created', '蒸馏无输出 → 原文卡兜底', { path: raw.path ?? raw.rel, kind: 'content', model: route.model }) }
        else if (raw.duplicate) { countWrite(); logCapture(sessionId, 'appended', '蒸馏无输出 + 与已有卡重复 → 追加更新', { path: raw.duplicate.path, model: route.model }) }
        else logCapture(sessionId, 'fail', `蒸馏无输出，且兜底原文卡也失败：${raw.reason || '未知原因'}`, { model: route.model })
        return
      }
      if (result.save !== true) { logCapture(sessionId, 'skip', '模型判定不值得保存', { model: route.model }); return }
      if (result.append_to) {
        // 模型判定属于已有卡 → 追加更新记录，不新建（boujoy 语义）。
        await captureUpdate(vaultDir(), result.append_to, result.update, { threshold: cfg.dedupThreshold })
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
      const out = await captureCard(vaultDir(), card, { threshold: cfg.dedupThreshold })
      if (out.ok) {
        countWrite()
        logCapture(sessionId, 'created', `新卡：${card.title}（${card.status === 'approved' ? '已入库' : '待审核'}）`, { path: out.path ?? out.rel, kind: card.kind, model: route.model })
        return
      }
      if (out.duplicate) {
        // 词法兜底：高度相似 → 追加更新记录而不是再建一张重复卡。
        await captureUpdate(vaultDir(), out.duplicate.path, `${result.title}：${result.body.slice(0, 400)}`, {
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
  let lastClaimAt = 0
  ctx.on('agent/inbox/claimed', () => { turnsStarted += 1; lastClaimAt = Date.now() })
  ctx.on('agent/turn-stopping', ({ agent }) => {
    turnsStopped += 1
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
        '或领域知识时调用；返回最相关的卡片摘要。用 query 描述要找的内容，支持中文整词与字符片段检索。',
      parameters: {
        query: { type: 'string', required: true, description: '检索关键词或自然语言描述，如「数据库选型」「用户偏好」' },
        limit: { type: 'number', description: '返回卡片数上限，默认 5' },
      },
      output: {
        schema: { type: 'string' },
        render(_a, v) { return [{ type: 'text', text: v }] },
      },
      timeoutMs: 20000,
      async execute(args) {
        const cfg = settings.get() ?? {}
        if (!cfg.enabled) return '（记忆核心已禁用）'
        const query = String(args.query || '').trim()
        if (!query) return '（未提供检索词）'
        const cfg2 = settings.get() ?? {}
        const defLimit = Number(cfg2.recallLimit) || 5
        const defLen = Number(cfg2.recallSummaryLen) || 130
        const includeBody = cfg2.recallIncludeBody === true
        const limit = Math.min(Math.max(Number(args.limit) || defLimit, 1), 20)
        const hits = await search(vaultDir(), query, { limit, minScore: 2 })
        if (hits.length === 0) return `记忆库中没有与「${query}」相关的内容。`
        const lines = hits.map((h, i) => {
          const tags = h.tags.length ? ` [${h.tags.join(', ')}]` : ''
          const snippet = String(h.summary || '').replace(/\s+/g, ' ').trim().slice(0, defLen)
          const body = includeBody ? `\n${String(h.excerpt || '').slice(0, 800)}` : ''
          return `### ${i + 1}. ${h.title}${tags}\n路径：${h.path}\n${snippet}${body}`
        })
        return `从记忆核心检索到 ${hits.length} 条相关卡片：\n\n${lines.join('\n\n')}`
      },
    }))
  }

  // 沉淀停滞探测：只有「有轮次在跑」且「管线 15 分钟一个活口都没有」才报（真死才报）。
  // 计数器对不上是常态（子代理轮次、被取消的轮次都不发 turn-stopping），单看计数会误报刷屏。
  const stallTimer = setInterval(() => {
    const idleMs = Date.now() - lastActivityAt
    const claimIdleMs = lastClaimAt ? Date.now() - lastClaimAt : 0
    const suspicious = turnsStarted > turnsStopped && claimIdleMs > 15 * 60 * 1000 && idleMs > 15 * 60 * 1000
    if (suspicious && !stallAlerted) {
      stallAlerted = true
      logCapture('system', 'fail', `轮次收尾事件未触发（agent/turn-stopping 没到）：已开始 ${turnsStarted} / 已收尾 ${turnsStopped}，且 15 分钟无任何沉淀活动——DSH 可能改了事件名或作用域`)
    }
  }, 10 * 60 * 1000)
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

  // webServer 是一个「可能晚到」的服务：apply 执行时它往往尚未挂载，同步
  // ctx.get() 拿不到就整段跳过、且不留任何日志——表现就是 /memory-eternal/api/*
  // 恒 404，客户端设置页永远停在「加载中…」（桌面端会提示「host 需加载新版
  // /memory-eternal 路由」）。所以改成 ctx.inject() 等它就绪后再注册：
  // 没有该服务的 profile（如 TUI）里子 fiber 保持 pending，主插件照常激活。
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
                autoCapture: cfg.autoCapture, autoRecall: cfg.autoRecall, recallLimit: cfg.recallLimit, recallSummaryLen: cfg.recallSummaryLen, recallIncludeBody: cfg.recallIncludeBody,
                captureMinChars: cfg.captureMinChars, captureCooldownMs: cfg.captureCooldownMs, dedupThreshold: cfg.dedupThreshold, maxCardsPerDay: cfg.maxCardsPerDay,
                distillEnabled: cfg.distillEnabled, dedupByLLM: cfg.dedupByLLM, captureMaxTokens: cfg.captureMaxTokens, recallMinScore: cfg.recallMinScore,
                autoWeb: cfg.autoWeb, autoWebMode: cfg.autoWebMode, webPort: cfg.webPort, webCheckIntervalMs: cfg.webCheckIntervalMs, webMaxRestart: cfg.webMaxRestart, watchdogAutoSpawn: cfg.watchdogAutoSpawn, autoMcpSetup: cfg.autoMcpSetup,
                auditMode: cfg.auditMode ?? 'all', auditExemptAgents: cfg.auditExemptAgents || [], auditExemptKinds: cfg.auditExemptKinds || [], recycleRetentionDays: cfg.recycleRetentionDays ?? 30,
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
                version: versionRef,
              }
              return json(res, 200, { ok: true, config: safe, revision: me?.revision ?? 0, writable: true, readonly: false, schema: me?.schema ?? null, dsh: dshInfo, version: versionRef })
            }
            if (method === 'POST') {
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
              if (typeof settings.update === 'function') {
                try {
                  await settings.update(clean)
                  // 把完整配置写入共享文件，让独立 web / MCP hook 与 DSH 设置同步（不同步修复）
                  syncConfigFile()
                  return json(res, 200, { ok: true, applied: Object.keys(clean), note: '已保存。autoWebMode/watchdogAutoSpawn 等需重启 DSH 生效' })
                } catch (e) {
                  if (e && e.code === 'SETTINGS_CONFLICT') return json(res, 409, { ok: false, error: '配置已被外部修改，请刷新后重试（revision conflict）' })
                  return json(res, 500, { ok: false, error: String(e?.message || e) })
                }
              }
              return json(res, 501, { ok: false, error: '当前环境不支持写配置' })
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

  // 等 webServer 就绪再注册宿主侧 API（见上面的注释）。注册成功会留一条 boot 记录，
  // 便于在「设置 → 记忆 → 用量/今日」里确认路由到底有没有挂上。
  ctx.inject(['webServer'], (ctx) => {
    const webServer = ctx.get('webServer')
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
    if (cfg0.watchdogAutoSpawn === true && cfg0.autoWeb !== false) {
      import('./lib/watchdog.js')
        .then((m) => {
          const port = Number(cfg0.webPort) || 7999
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
    }

    return () => {
      if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null }
      // 注意：watchdog 进程是独立的，故意不杀（7×24 用法）—— 配置改变由下次重启 DSH 时重新 spawn 替换
    }
  }, 'memory-eternal: multi-host ensure')

  // 首次激活时确保 vault 目录存在。
  ctx.effect(() => {
    const root = vaultDir()
    ensureVault(root).catch((error) => console.error('[memory-eternal] ensureVault failed:', error))
  }, 'memory-eternal: ensure vault')
}
