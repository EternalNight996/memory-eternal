// 记忆核心 · 知识库 JSON API（与宿主无关的纯 HTTP 层）。
//
// 从 index.js 抽出的 handleApi/json：逻辑原封不动，仅把对 DSH 闭包
// （vaultDir/vaultRoots/settings）的依赖改为通过 createApi(deps) 注入，
// 使 DSH 插件（经 webServer 前缀路由）与独立 Web server（lib/web.js）
// 共用同一份 API 实现。
//
// deps:
// - vaultDir()  → 当前激活 vault 根目录（string）
// - vaultRoots() → [{ name, root }] 全部 profile 根（跨库聚合用）
// - getSettings() → 插件设置对象（/budget /compress 读取；可选，缺省 {}）
// - getCaptureLog() → 自动沉淀运行轨迹（DSH host 注入；独立 web server 无此数据）

import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { listCards, countCards, readCard, search, searchAll, graph, graphAll, overview, exportCards, deleteCard, writeCard, parseCard, stats, optimizeCandidates, optimizeApply, addFeedback, dailyCounts, mergeCards, ensureVault, auditQueue, recycleList, purgeExpired, setCardStatus, restoreCard, mainStoreBodies } from './vault.js'
import { compressExcerpt } from './capture.js'
import { buildDiagnostics } from './feedback.js'
import { getSetupStatus, runSetup, mcpAgentAction } from './setup.js'
import { backupDb } from './db.js'
import { createHub } from './sse.js'

// 独立 web 的 SSE 中心：配置/数据变更即时推给已打开的页面（无需手动刷新）
const hub = createHub()
/** 供 lib/web.js 在检测到共享配置变化时广播。 */
export function broadcast(event, data) { return hub.broadcast(event, data) }

export const API_PREFIX = '/memory-eternal/api'

// npm 最新版本缓存（避免每次点「检查更新」都打 registry）
const versionCache = { at: 0, latest: '' }

export function createApi(deps = {}) {
  const vaultDir = deps.vaultDir ?? (() => '')
  const vaultRoots = deps.vaultRoots ?? (() => [{ name: '', root: vaultDir() }])
  const getSettings = deps.getSettings ?? (() => ({}))
  // DSH 宿主信息（独立 web server 无 DSH 环境时为 null）。head DSH 状态行用。
  const getDshInfo = deps.getDshInfo ?? (() => null)
  // 自动沉淀运行轨迹（最新在前）+ 健康状态（异常时 UI 顶部亮红）。
  const getCaptureLog = deps.getCaptureLog ?? (() => null)
  const getCaptureHealth = deps.getCaptureHealth ?? (() => null)

  return async function handleApi(req, res) {
    const vaultRoot = vaultDir()
    const url = new URL(req.url, 'http://localhost')
    const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, '') || '/overview'
    const query = url.searchParams

    switch (route) {
      case '/overview': {
        await ensureVault(vaultRoot)
        json(res, 200, { ok: true, vaultDir: vaultRoot, ...(await overview(vaultRoot)) })
        return
      }
      case '/cards': {
        const kind = query.get('kind') || ''
        const q = query.get('q') || ''
        const status = (query.get('status') || 'approved').toLowerCase()
        // 真分页：offset/limit + total（客户端据此判断还有没有下一页）
        const limit = Math.min(Math.max(Number(query.get('limit')) || 200, 1), 500)
        const offset = Math.max(Number(query.get('offset')) || 0, 0)
        const sort = query.get('sort') === 'title' ? 'title' : 'recent'
        const agent = query.get('agent') || '' // 服务端署名过滤（如 agent=deepseek-harness）
        // all = 全部（含 pending/rejected，排除回收站）；默认/approved = 已审核。
        // 白名单（P0 修复）：除下面三种取值外一律按 approved 处理，未知 status 不再可能越权列未审核卡。
        const want = status === 'all' ? ['approved', 'pending', 'rejected']
          : status === 'pending' ? ['pending']
          : status === 'rejected' ? ['rejected']
          : ['approved']
        if (q.trim()) {
          // 检索是相关性排序：先把命中集合取齐，再在内存里分页（保证 total 与顺序一致）
          const hits = await search(vaultRoot, q, { limit: 500 })
          const hitPaths = new Set(hits.map((h) => h.path))
          let cards = (await listCards(vaultRoot, { status: want, kind, agent })).filter((c) => hitPaths.has(c.path))
          const total = cards.length
          json(res, 200, { ok: true, cards: cards.slice(offset, offset + limit), total, offset, limit })
          return
        }
        const total = await countCards(vaultRoot, { status: want, kind, agent })
        const cards = await listCards(vaultRoot, { status: want, kind, agent, limit, offset, sort })
        json(res, 200, { ok: true, cards, total, offset, limit })
        return
      }
      case '/card': {
        const rel = query.get('path') || ''
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        // 默认只能读已审核卡（P0 修复）。审核中心 / 回收站要预览未审核卡时带 ?status=pending|rejected|deleted，
        // 但只放行**确实在审核队列或回收站里**的 path —— 未知 path 不能靠参数把未审核正文读出来。
        const statusParam = (query.get('status') || '').toLowerCase()
        const wantsUnapproved = statusParam === 'pending' || statusParam === 'rejected' || statusParam === 'deleted'
        if (wantsUnapproved) {
          let inQueue = false
          try {
            if (statusParam === 'deleted') {
              inQueue = (await recycleList(vaultRoot)).some((c) => c.path === rel)
            } else {
              const q = await auditQueue(vaultRoot)
              inQueue = (statusParam === 'pending' ? q.pending : q.rejected).some((c) => c.path === rel)
            }
          } catch { inQueue = false }
          if (!inQueue) return json(res, 403, { ok: false, error: '该卡片不在审核队列 / 回收站中，不能以未审核身份读取', code: 'CARD_NOT_APPROVED' })
        }
        const card = await readCard(vaultRoot, rel, { allowUnapproved: wantsUnapproved })
        json(res, 200, { ok: true, path: card.path, status: card.status, text: card.text })
        return
      }
      case '/search': {
        const q = query.get('q') || ''
        if (!q.trim()) return json(res, 200, { ok: true, hits: [] })
        const all = query.get('all') === '1'
        const semantic = query.get('semantic') === '1'
        let hits
        try { hits = all ? await searchAll(vaultRoots(), q, { limit: 30, semantic }) : await search(vaultRoot, q, { limit: 30, semantic }) }
        catch (e) { hits = await search(vaultRoot, q, { limit: 30, semantic }) }
        json(res, 200, { ok: true, hits })
        return
      }
      case '/version-check': {
        // 版本跟踪：运行中（宿主启动时加载） vs 磁盘安装 vs npm 最新。
        // 典型场景：磁盘已更新，但 DSH 进程仍加载旧版 → UI 显示旧版本号、新接口 404。
        const loaded = (getDshInfo() || {}).version || ''
        let onDisk = ''
        try {
          const pj = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
          onDisk = String(pj.version || '')
        } catch { onDisk = '' }
        let latest = ''
        let checkError = ''
        const force = query.get('force') === '1'
        try {
          if (force || !versionCache.at || Date.now() - versionCache.at > 10 * 60 * 1000) {
            const ctl = new AbortController()
            const timer = setTimeout(() => ctl.abort(), 4000)
            const resp = await fetch('https://registry.npmjs.org/memory-eternal', { signal: ctl.signal })
            clearTimeout(timer)
            const data = await resp.json()
            latest = String((data && data['dist-tags'] && data['dist-tags'].latest) || '')
            versionCache.at = Date.now()
            versionCache.latest = latest
          } else {
            latest = versionCache.latest
          }
        } catch (e) { checkError = String((e && e.message) || e).slice(0, 120) }
        json(res, 200, {
          ok: true,
          loaded,
          onDisk,
          latest,
          checkError,
          stale: !!(loaded && onDisk && loaded !== onDisk),
          updateAvailable: !!(latest && onDisk && latest !== onDisk),
          updateCommand: 'dsh plugin --profile <你的 profile> add memory-eternal@latest',
        })
        return
      }
      case '/diagnostics': {
        // 「反馈异常」用：返回一段可直接贴进 issue 的**已脱敏**诊断文本。
        // 宿主与独立 web 共用这个实现；home 目录、各类 key/token 全都会被替换掉。
        const cfgD = getSettings() ?? {}
        const dshD = getDshInfo() ?? null
        const envD = typeof process !== 'undefined' ? process.env : {}
        let countsD = null
        try { countsD = await overview(vaultRoot) } catch { countsD = null }
        let healthD = null
        try { healthD = getCaptureHealth() } catch { healthD = null }
        let logD = []
        try {
          const raw = getCaptureLog()
          logD = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : [])
        } catch { logD = [] }
        const homeD = (() => { try { return os.homedir() } catch { return '' } })()
        const text = buildDiagnostics({
          version: (dshD && dshD.version) || envD.MEMORY_ETERNAL_VERSION || '',
          dshVersion: (dshD && dshD.version) || '',
          host: dshD ? 'deepseek-harness' : 'standalone web',
          os: process.platform + ' ' + process.arch + ' / node ' + process.version,
          vaultDir: vaultRoot,
          vaultSource: dshD && dshD.vaultSource,
          workspace: dshD && dshD.workspace,
          cards: countsD ? countsD.total : undefined,
          health: healthD,
          captureLog: logD,
          maxTokens: undefined,
        }, homeD)
        json(res, 200, { ok: true, diagnostics: text, repo: 'EternalNight996/memory-eternal', version: (dshD && dshD.version) || envD.MEMORY_ETERNAL_VERSION || '' })
        return
      }
      case '/graph': {
        await ensureVault(vaultRoot)
        const all = query.get('all') === '1'
        let g
        try { g = all ? await graphAll(vaultRoots()) : await graph(vaultRoot) }
        catch (e) { g = await graph(vaultRoot) }
        json(res, 200, { ok: true, ...g })
        return
      }
      case '/capture-log': {
        // 最近 100 条自动沉淀运行轨迹（监听 → 判定 → 写入/跳过原因）+ 健康状态。
        // 宿主侧是内存缓冲（同步），独立 Web 侧是从 JSONL 读文件（异步）→ 统一 await。
        const log = await getCaptureLog()
        if (!log) return json(res, 200, { ok: true, available: false, entries: [], health: null })
        json(res, 200, { ok: true, available: true, health: await getCaptureHealth(), entries: log.slice(0, 100) })
        return
      }
      case '/export': {
        await ensureVault(vaultRoot)
        const cards = await exportCards(vaultRoot)
        // 带上信封元信息：客户端可以直接把整个响应体当备份文件落下（见 /import 的兼容读取）。
        json(res, 200, { ok: true, format: 'memory-eternal-vault', formatVersion: 1, exportedAt: new Date().toISOString(), count: cards.length, cards })
        return
      }
      case '/delete': {
        const rel = query.get('path') || ''
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        // 软删（进回收站）；?permanent=1 直接永久删除
        const permanent = query.get('permanent') === '1'
        await deleteCard(vaultRoot, rel, { permanent })
        json(res, 200, { ok: true, soft: !permanent })
        return
      }
      case '/audit/list': {
        const { pending, rejected } = await auditQueue(vaultRoot)
        json(res, 200, { ok: true, pending, rejected })
        return
      }
      case '/audit/approve': {
        // POST {path} 或 GET ?path= → status=approved
        const rel = query.get('path') || (await readBody(req))?.path || ''
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        await setCardStatus(vaultRoot, rel, 'approved')
        json(res, 200, { ok: true, path: rel, status: 'approved' })
        return
      }
      case '/audit/reject': {
        // POST {path} 或 GET ?path= → status=rejected（标记驳回，不删除）
        const rel = query.get('path') || (await readBody(req))?.path || ''
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        await setCardStatus(vaultRoot, rel, 'rejected')
        json(res, 200, { ok: true, path: rel, status: 'rejected' })
        return
      }
      case '/recycle/list': {
        const items = await recycleList(vaultRoot)
        json(res, 200, { ok: true, items })
        return
      }
      case '/recycle/restore': {
        const rel = query.get('path') || ''
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        await restoreCard(vaultRoot, rel)
        json(res, 200, { ok: true, path: rel })
        return
      }
      case '/recycle/purge': {
        const rel = query.get('path') || ''
        if (!rel) return json(res, 400, { ok: false, error: '缺少 path' })
        await deleteCard(vaultRoot, rel, { permanent: true })
        json(res, 200, { ok: true, path: rel, purged: true })
        return
      }
      case '/recycle/purge-expired': {
        const days = Number(query.get('days')) || 30
        const r = await purgeExpired(vaultRoot, days)
        json(res, 200, r)
        return
      }
      case '/write': {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const raw = Buffer.concat(chunks).toString('utf8')
        let body
        try { body = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        if (!body.body) return json(res, 400, { ok: false, error: '缺少正文' })
        await ensureVault(vaultRoot)
        const r = await writeCard(vaultRoot, { kind: body.kind || 'knowledge', title: body.title || '无标题', tags: body.tags || [], body: body.body, source: body.source || 'manual', status: 'pending', submittedBy: body.source || 'manual', severity: body.severity || 'info', reason: body.reason || '手动创建' }, { dedup: false })
        json(res, 200, r)
        return
      }
      case '/import': {
        const importChunks = []
        for await (const chunk of req) importChunks.push(chunk)
        const raw = Buffer.concat(importChunks).toString('utf8')
        if (raw.length > 20 * 1024 * 1024) return json(res, 413, { ok: false, error: '文件过大' })
        let payload
        try { payload = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        // 兼容两种备份形状：
        //   ① 顶层就是卡片数组 —— v0.10.0 及以前「导出JSON」写出的 memory-vault.json；
        //   ② 带信封的对象 { format, formatVersion, exportedAt, count, cards: [...] } —— v0.10.1 起。
        // 旧实现只认 payload.cards，于是①被静默当成空备份（imported=0 / skipped=0 / ok=true，
        // UI 只显示「导入完成：0」，看不出是格式不匹配）—— 这是 issue「导出 OK 导入 0 张」的根因。
        const list = Array.isArray(payload) ? payload
          : Array.isArray(payload?.cards) ? payload.cards
          : null
        if (!list) return json(res, 400, { ok: false, error: '文件格式无法识别：应为卡片数组，或含 cards 数组的备份对象（请用本插件「导出JSON」生成的文件）' })
        if (!list.length) return json(res, 200, { ok: true, imported: 0, skipped: 0, quarantined: 0, total: 0, failed: [], warning: '文件里没有任何卡片' })
        // 去重基线取「导入前已存在的主库卡」快照：备份里的近似卡不能在同一批里互相吞掉。
        const baseline = await mainStoreBodies(vaultRoot)
        let imported = 0, skipped = 0, quarantined = 0
        const failed = []
        for (const c of list) {
          if (!c || typeof c !== 'object') { skipped++; failed.push({ reason: '条目不是对象' }); continue }
          const text = c.text || ''
          let kind = c.kind || 'knowledge', title = c.title || '导入记忆', tags = [], body = text, source = '', status = c.status || 'pending', deletedAt = c.deletedAt || ''
          try { const p = parseCard(text); kind = p.meta.kind || kind; title = p.meta.title || title; tags = p.meta.tags || tags; body = p.body; source = p.meta.source || source; status = p.meta.status || status; deletedAt = p.meta.deletedAt || deletedAt } catch {}
          if (!String(body || '').trim()) { skipped++; failed.push({ path: c.path || '', title: String(title).slice(0, 80), reason: '正文为空' }); continue }
          // 两套存储：导入按导出时的状态回填（备份/迁移才完整），但仍过 enforceAudit 这道闸门 ——
          // 校验不过的会被写成 pending 进隔离区，主库永远不会被导入数据绕过。
          const r = await writeCard(vaultRoot, { kind, title, tags, body, source, status, deletedAt }, { dedupAgainst: baseline })
          if (r.ok) { imported++; if (r.store === 'quarantine') quarantined++ }
          else { skipped++; failed.push({ path: c.path || '', title: String(title).slice(0, 80), reason: r.duplicate ? '已存在（内容重复）' : (r.error || '写入被拒') }) }
        }
        json(res, 200, { ok: true, imported, skipped, quarantined, total: list.length, failed: failed.slice(0, 50) })
        return
      }
      case '/merge': {
        const paths = (query.get('paths') || '').split(',').map((p) => p.trim()).filter(Boolean)
        const r = await mergeCards(vaultRoot, paths)
        if (!r.ok) return json(res, 400, r)
        json(res, 200, r)
        return
      }
      case '/stats': {
        await ensureVault(vaultRoot)
        const days = Math.min(Number(query.get('days')) || 30, 90)
        json(res, 200, { ok: true, ...(await stats(vaultRoot)), trend: await dailyCounts(vaultRoot, days) })
        return
      }
      case '/optimize': {
        // 非破坏性：只返回「整理建议」（相似卡对 + 陈旧卡），不自动删改。
        json(res, 200, { ok: true, ...(await optimizeCandidates(vaultRoot)) })
        return
      }
      case '/optimize-execute': {
        // 一键优化执行：合并相似卡 + 可选清理陈旧卡。POST body: {cleanupStale?, simThreshold?, staleDays?, dryRun?}
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: '需 POST' }); return }
        let raw = ''
        for await (const chunk of req) raw += chunk
        let opts = {}
        try { opts = JSON.parse(raw || '{}') } catch { opts = {} }
        const result = await optimizeApply(vaultRoot, opts)
        json(res, 200, result)
        return
      }
      case '/setup-run': {
        // 「补全 MCP」：真正执行 runSetup（写外部 agent 配置）。共享层（独立 web 也可用）
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
        try {
          const out = await runSetup({ log: () => {}, enabled: true })
          json(res, 200, { ok: true, results: out.results })
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message || e) }) }
        return
      }
      case '/mcp/action': {
        // 单智能体安装/卸载 MCP：POST {agent, action}。共享层（独立 web 可用）
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: '需 POST' })
        try {
          let raw = ''
          for await (const chunk of req) raw += chunk
          const body = JSON.parse(raw || '{}')
          const out = await mcpAgentAction(String(body.agent || ''), String(body.action || ''), { log: () => {} })
          json(res, 200, out)
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message || e) }) }
        return
      }
      case '/setup-status': {
        // 只读查询各 agent MCP 配置状态，不写任何文件
        const status = await getSetupStatus()
        // prepend DSH 宿主行（独立 web server 无 DSH 环境时只有外部 agent）
        const dsh = getDshInfo ? getDshInfo() : null
        if (dsh) {
          status.agents = [{ name: 'dsh', label: dsh.label || 'DSH (当前宿主)', installed: true, mcpConfigured: true, isDsh: true, recallTool: dsh.memoryRecallTool, autoCapture: dsh.autoCapture, autoRecall: dsh.autoRecall, vaultDir: dsh.vaultDir }, ...(status.agents || [])]
        }
        json(res, 200, status)
        return
      }
      case '/feedback': {
        const fbChunks = []
        for await (const chunk of req) fbChunks.push(chunk)
        const raw = Buffer.concat(fbChunks).toString('utf8')
        let rec
        try { rec = JSON.parse(raw || '{}') } catch { return json(res, 400, { ok: false, error: 'JSON 解析失败' }) }
        if (!rec || !rec.path) return json(res, 400, { ok: false, error: '缺少 path' })
        await addFeedback(vaultRoot, { query: String(rec.query || ''), path: String(rec.path || ''), useful: rec.useful === true })
        json(res, 200, { ok: true })
        return
      }
      case '/budget': {
        try {
          const cfg = getSettings() ?? {}
          const env = typeof process !== 'undefined' ? process.env : {}
          json(res, 200, {
            ok: true,
            budgetChars: cfg.sessionBudgetChars ?? 80000,
            recallLimit: cfg.recallLimit ?? 5,
            embedding: cfg.recallEmbedding || '',
            // 服务自管理配置（DSH host 从 settings 读；独立 web server 从 env 兜底）
            autoWeb: cfg.autoWeb ?? env.MEMORY_AUTO_WEB !== '0',
            autoWebMode: cfg.autoWebMode || 'init',
            webPort: Number(cfg.webPort) || Number(env.MEMORY_WEB_PORT) || 7999,
            webCheckIntervalMs: Number(cfg.webCheckIntervalMs) || 5000,
            webMaxRestart: Number(cfg.webMaxRestart) || 10,
            watchdogAutoSpawn: cfg.watchdogAutoSpawn ?? env.MEMORY_WATCHDOG === '1',
            autoMcpSetup: cfg.autoMcpSetup ?? false,
          })
        } catch (e) {
          // 配置读取异常时降级返回默认值，避免面板整块红屏
          json(res, 200, { ok: true, budgetChars: 80000, recallLimit: 5, embedding: '', autoWeb: true, autoWebMode: 'init', webPort: 7999, webCheckIntervalMs: 5000, webMaxRestart: 10, watchdogAutoSpawn: true, autoMcpSetup: false })
        }
        return
      }
      case '/events': {
        // SSE 长连接（不 end），EventSource 会自动重连
        hub.add(res)
        return
      }
      case '/config': {
        // 独立 web server（无 DSH settings）的配置读取兜底：env + 默认值。DSH host 的 /config 在其 webServer handler 拦截实现（可写），此处只读。
        const cfg = getSettings() ?? {}
        const env = typeof process !== 'undefined' ? process.env : {}
        const safe = {
          autoCapture: cfg.autoCapture ?? true, autoRecall: cfg.autoRecall ?? true, recallLimit: cfg.recallLimit ?? 5, recallSummaryLen: cfg.recallSummaryLen ?? 130, recallIncludeBody: cfg.recallIncludeBody ?? false,
          captureMinChars: cfg.captureMinChars ?? 200, captureCooldownMs: cfg.captureCooldownMs ?? 300000, dedupThreshold: cfg.dedupThreshold ?? 0.62, maxCardsPerDay: cfg.maxCardsPerDay ?? 60,
          distillEnabled: cfg.distillEnabled ?? true, dedupByLLM: cfg.dedupByLLM ?? true, captureMaxTokens: cfg.captureMaxTokens ?? 900, recallMinScore: cfg.recallMinScore ?? 2,
          autoWeb: cfg.autoWeb ?? env.MEMORY_AUTO_WEB !== '0', autoWebMode: cfg.autoWebMode || 'init', webPort: Number(cfg.webPort) || Number(env.MEMORY_WEB_PORT) || 7999, webCheckIntervalMs: Number(cfg.webCheckIntervalMs) || 5000, webMaxRestart: Number(cfg.webMaxRestart) || 10, watchdogAutoSpawn: cfg.watchdogAutoSpawn ?? env.MEMORY_WATCHDOG === '1', autoMcpSetup: cfg.autoMcpSetup ?? false,
          auditMode: cfg.auditMode ?? 'all', auditExemptAgents: cfg.auditExemptAgents ?? [], auditExemptKinds: cfg.auditExemptKinds ?? [], recycleRetentionDays: cfg.recycleRetentionDays ?? 30,
          vaultProfiles: Array.isArray(cfg.vaultProfiles) ? cfg.vaultProfiles : [], activeVault: cfg.activeVault || '',
          enabled: cfg.enabled !== false, vaultDir: cfg.vaultDir || '', captureProvider: cfg.captureProvider || '',
          captureModel: cfg.captureModel || '', recallEmbedding: cfg.recallEmbedding || '', sessionBudgetChars: cfg.sessionBudgetChars ?? 80000,
          webPort: cfg.webPort ?? 7999, webCheckIntervalMs: cfg.webCheckIntervalMs ?? 5000, webMaxRestart: cfg.webMaxRestart ?? 10,
        }
        const NUM_RANGE = {
          dedupThreshold: [0, 1], captureMinChars: [0, 1000000], captureCooldownMs: [0, 1000000000],
          maxCardsPerDay: [0, 1000000], captureMaxTokens: [100, 4000], recallMinScore: [0, 50],
          recallLimit: [1, 20], recallSummaryLen: [40, 400], recycleRetentionDays: [1, 3650],
          webPort: [1, 65535], webCheckIntervalMs: [1000, 600000], webMaxRestart: [1, 1000],
          sessionBudgetChars: [0, 1000000000],
        }
        // POST：独立 web 没有 DSH settings 服务，改成写「待应用」文件，由 DSH 端自动应用
        // （否则这里的保存按钮永远是死的 —— issue #12 的一半就栽在这）
        if (req.method === 'POST') {
          const body = await readBody(req)
          const patch = body && typeof body.patch === 'object' && body.patch ? body.patch : null
          if (!patch) return json(res, 400, { ok: false, error: '缺少 patch' })
          const allowed = new Set(Object.keys(safe))
          const clean = {}
          const bad = []
          for (const [k, v] of Object.entries(patch)) {
            if (!allowed.has(k)) continue
            const base = safe[k]
            if (Array.isArray(base)) { if (!Array.isArray(v)) bad.push(k); else clean[k] = v; continue }
            if (typeof base === 'number') {
              const n = typeof v === 'number' ? v : Number(v)
              const rng = NUM_RANGE[k] || [-Infinity, Infinity]
              const lo = rng[0], hi = rng[1]
              if (v === '' || v === null || v === undefined || !Number.isFinite(n)) bad.push(k + ' 需要数字')
              else if (n < lo || n > hi) bad.push(k + ' 需要 ' + lo + '-' + hi + '，当前 ' + n)
              else clean[k] = n
              continue
            }
            if (typeof base === 'boolean') { if (typeof v !== 'boolean') bad.push(k); else clean[k] = v; continue }
            if (typeof v !== 'string') bad.push(k); else clean[k] = v
          }
          if (bad.length) return json(res, 400, { ok: false, error: '字段值不合法：' + bad.join('、'), fields: bad })
          if (!Object.keys(clean).length) return json(res, 400, { ok: false, error: '没有可写入的字段' })
          const { writePendingConfig } = await import('./config-sync.js')
          const out = writePendingConfig(process.env, clean)
          hub.broadcast('config', { at: out.at, source: 'standalone', applied: Object.keys(clean) })
          return json(res, 200, {
            ok: true, applied: Object.keys(clean), pending: Object.keys(clean), retried: false, at: out.at,
            note: '已写入待应用：DSH 端会自动同步（DSH 未运行时下次启动生效）',
          })
        }
        json(res, 200, { ok: true, config: safe, revision: 0, writable: true, readonly: false, viaPending: true, version: env.MEMORY_ETERNAL_VERSION || '' })
        return
      }
      case '/compress': {
        // 记忆侧「压缩产物」接口：供 harness 在会话内压缩旧轮次时调用，返回一段可注入的摘要。
        const cfg = getSettings() ?? {}
        const body = new URLSearchParams(query)
        const text = body.get('text') || ''
        const maxChars = Math.min(Number(body.get('max')) || 2400, 6000)
        if (!text.trim()) return json(res, 400, { ok: false, error: '缺少 text' })
        const compressed = await compressExcerpt(text, maxChars)
        json(res, 200, { ok: true, compressed, budgetChars: cfg.sessionBudgetChars ?? 80000 })
        return
      }
      case '/backup': {
        const r = await backupDb(vaultRoot, { maxKeep: 7 })
        json(res, r.ok ? 200 : 500, r)
        return
      }
      default:
        json(res, 404, { ok: false, error: '未知接口' })
    }
  }
}

export function json(res, status, body) {
  const payload = JSON.stringify(body)
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Accept-Encoding',
  }
  const { body: out, encoding } = encodeBody(res, Buffer.from(payload, 'utf8'))
  if (encoding) headers['Content-Encoding'] = encoding
  headers['Content-Length'] = out.length
  res.writeHead(status, headers)
  res.end(out)
}

/** 请求方的 Accept-Encoding（`res.req` 由 Node 的 http server 挂上；取不到当不支持）。 */
export function acceptEncoding(res) {
  try {
    const req = res && (res.req || res.__meReq)
    return String((req && req.headers && req.headers['accept-encoding']) || '').toLowerCase()
  } catch { return '' }
}

/** 请求方是否接受 gzip。 */
export function acceptsGzip(res) {
  return acceptEncoding(res).includes('gzip')
}

/**
 * 协商压缩大响应体：
 * - 支持 brotli 就优先 br（质量 4 = 在线压缩的速度/体积平衡点，比 gzip 再小约 30%）
 * - 否则退 gzip
 * - 都不支持、体积太小、或压完反而更大 → 明文
 */
export function encodeBody(res, buf) {
  if (buf.length <= 2048) return { body: buf, encoding: '' }
  const ae = acceptEncoding(res)
  const wantBr = /(^|[,\s])br($|[,\s;])/.test(ae)
  const wantGzip = ae.includes('gzip')
  // 大响应体同时压 br + gzip 取更小的那个：br q5 在图谱这种高重复 JSON 上比 gzip 小 35%，
  // 但在高熵的 JS/小 JSON 上偶尔略大 —— 取小者保证永不劣化（成本仅几毫秒）。
  if (buf.length >= 16 * 1024) {
    let br = null
    if (wantBr) {
      try { br = brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length } }) } catch { br = null }
    }
    let gz = null
    if (wantGzip) { try { gz = gzipSync(buf) } catch { gz = null } }
    const best = [br && { body: br, encoding: 'br' }, gz && { body: gz, encoding: 'gzip' }]
      .filter(Boolean)
      .filter((x) => x.body.length < buf.length)
      .sort((a, b) => a.body.length - b.body.length)[0]
    if (best) return best
    return { body: buf, encoding: '' }
  }
  if (wantBr) {
    try {
      const out = brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length } })
      if (out.length < buf.length) return { body: out, encoding: 'br' }
    } catch { /* 落到 gzip */ }
  }
  if (wantGzip) {
    const out = gzipSync(buf)
    if (out.length < buf.length) return { body: out, encoding: 'gzip' }
  }
  return { body: buf, encoding: '' }
}

/** 读请求体（POST body），返回解析后的 JSON 对象或空。 */
export async function readBody(req) {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
