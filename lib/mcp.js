// 记忆核心 · MCP server（零依赖 stdio JSON-RPC 2.0）。
//
// 让 Claude Code / Codex CLI / Cursor / 任何 MCP 客户端共享同一个记忆库。
// 传输：MCP stdio —— stdin/stdout 每行一条 JSON-RPC 消息；日志一律走 stderr
// （stdout 是协议通道，被 console.log 污染会破坏握手）。
//
// 支持的协议版本：2025-06-18 / 2025-03-26 / 2024-11-05（协商取请求版本）。
// 远端 / 云端配置常量（必须在 resolveDataSource 之前定义：const 不提升）
const REMOTE_API = String(process.env.MEMORY_API || '').trim().replace(/\/+$/, '')
const REMOTE_TOKEN = String(process.env.MEMORY_API_TOKEN || process.env.MEMORY_TOKEN || '').trim()

/**
 * 当前数据源是不是云端？是则返回 { base, token }，否则 null。
 *
 * 为什么 MCP 也要看这个：memory_capture 直接写本机 vaultRoot，
 * 用户明明连着云端（界面显示云端库 9924 张），写进去的卡却落在本机 10479 那张库里 ——
 * 界面看不到、云端也没有，用户只能说「验证失败」。
 * 所有写操作都该跟着数据源走，不能因为"是 MCP 工具"就绕过。
 */
export function resolveDataSource() {
  // ① 显式环境变量最高优先（运维指定 / 调试用）
  if (REMOTE_API) {
    return { kind: 'cloud', base: REMOTE_API, token: REMOTE_TOKEN, via: 'env' }
  }
  // ② 用户在界面里选的数据源（唯一真相源）
  try {
    const home = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
    const file = path.join(home, 'memory-eternal-cloud-conn.json')
    if (fs.existsSync(file)) {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (c && c.mode === 'cloud' && c.active !== false) {
        const base = String(c.url || '').replace(/\/+$/, '')
        const token = String(c.token || '').trim()
        if (/^https?:\/\//i.test(base) && token) {
          return { kind: 'cloud', base, token, via: 'cloudConn', owner: c.owner || '' }
        }
      }
    }
  } catch { /* 读不到就当本机 */ }
  // ③ 本机
  return { kind: 'local', base: '', token: '', via: 'local' }
}

/**
 * 统一的 HTTP 调用（云端）。
 * 用 /api 前缀：云端两种前缀都认，短的更稳。
 */
async function cloudJson(ds, pathAndQuery, init) {
  const h = { 'content-type': 'application/json' }
  if (ds.token) h.authorization = /^Bearer\s/i.test(ds.token) ? ds.token : 'Bearer ' + ds.token
  const r = await fetch(ds.base + '/api' + pathAndQuery, {
    ...init,
    headers: { ...h, ...(init && init.headers) },
    signal: AbortSignal.timeout(Number(process.env.MEMORY_API_TIMEOUT_MS) || 15000),
  })
  const t = await r.text()
  try { return { status: r.status, d: JSON.parse(t) } } catch { return { status: r.status, d: { ok: false, error: 'HTTP ' + r.status + '：' + t.slice(0, 200) } } }
}

// 工具：memory_recall / memory_capture / memory_stats / memory_audit_list / memory_revise。
// memory_revise 只**提交**修改副本进审核（不会直接改库、不能批准），与 issue #17 的审核边界一致。
//
// 审核边界（issue #17）：MCP 侧**只读**。新增的 memory_audit_list 只列待审/驳回，
// 不提供任何 approve/reject —— 否则任何接了 MCP 的智能体都能批准自己刚写进去的卡，
// 「人类把关」就形同不存在（写入路径留在审核中心面板与 CLI：dsh-memory audit）。
//
// 启动：node bin/dsh-memory.mjs mcp   （或 node lib/mcp.js）

import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { search, overview, stats, ensureVault, listCards, countCards, reviseCard } from './vault.js'
import { runStandaloneCapture, defaultVaultDir } from './capture-run.js'
import { recordLedger } from './ledger.js'

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
export const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

/** 协商协议版本：客户端要的我们支持就照给，否则回落到自己支持的最新基线（MCP 规范要求）。 */
export function negotiateProtocolVersion(requested) {
  const want = String(requested || '')
  return SUPPORTED_PROTOCOL_VERSIONS.includes(want) ? want : DEFAULT_PROTOCOL_VERSION
}

// 远端模式（MEMORY_API=http://host:port）：MCP 进程只当协议适配层，
// 读写都发到那个实例 —— 「Agent 挂到哪个库」由用户在面板里手动选择，不再自动挂载。
// （REMOTE_API / REMOTE_TOKEN 已提到文件顶部，供 resolveDataSource 使用）

function remoteHeaders() {
  const h = { 'content-type': 'application/json' }
  if (REMOTE_TOKEN) h.authorization = /^Bearer\s/i.test(REMOTE_TOKEN) ? REMOTE_TOKEN : 'Bearer ' + REMOTE_TOKEN
  return h
}

async function remoteJson(pathAndQuery, init) {
  const r = await fetch(REMOTE_API + '/api' + pathAndQuery, {
    ...init,
    headers: { ...remoteHeaders(), ...(init && init.headers) },
    signal: AbortSignal.timeout(Number(process.env.MEMORY_API_TIMEOUT_MS) || 15000),
  })
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { ok: false, error: 'HTTP ' + r.status + '：' + t.slice(0, 200) } }
}

export const MCP_TOOLS = [
  {
    name: 'memory_recall',
    description:
      '从本地记忆核心（Markdown 知识库）检索相关知识卡。需要项目背景、历史决策、之前讨论过的方案、' +
      '或领域知识时调用；返回最相关的卡片摘要。也会命中已批准的技能卡：需要某技能时先查这里，再用 skill 工具加载同名技能。' +
      '用 query 描述要找的内容，支持中文整词与字符片段检索。' +
      '需要 API key / token / 令牌等**凭证**时也先查这里（查「密钥 目录」）：记忆里存的是目录' +
      '（名字、存放位置、取用命令），**值不在记忆库里**，请按卡片给的本机命令取用，不要直接读凭据文件。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词或自然语言描述，如「数据库选型」「用户偏好」' },
        limit: { type: 'number', description: '返回卡片数上限，默认 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_capture',
    description:
      '把一段值得长期复用的对话/知识沉淀进记忆库。配置了 MEMORY_LLM_* 环境变量时会用 LLM 蒸馏压缩成知识卡；' +
      '未配置时降级为原文卡。通常由会话结束 hook 自动调用，手动调用用于显式保存重要结论。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要沉淀的对话文本或知识内容（建议 >120 字符）' },
        source: { type: 'string', description: '来源标记，如 session:xxx / claude-code / codex' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory_stats',
    description: '查看记忆库概览：总卡数、分类分布、最近新增、vault 目录路径。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_audit_list',
    description:
      '只读：列出记忆库里待审核 / 已驳回的卡片（不会批准或驳回任何卡）。' +
      '返回文本里的「待处理 N 张」永远是匹配总数；limit 只限制列出条数，被截断时会明确写出还有多少张未显示。' +
      '用于主动提醒用户「有 N 张待审卡」；批准/驳回必须由人在审核中心面板或 CLI（dsh-memory audit approve/reject）显式发起。',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'pending（默认）| rejected | all（= pending + rejected）' },
        limit: { type: 'number', description: '列出条数上限，默认 20（最大 500）；总数不受它影响' },
      },
    },
  },
  {
    name: 'memory_revise',
    description:
      '提交「审核制修改」：把一张已批准的知识卡复制成待审副本（可改标题/标签/正文），进入审核中心。' +
      '人工批准后才会覆盖原卡；agent 不能直接改已入库内容，也不能自己批准。' +
      '用于修正过期/错误的知识 —— 比再写一张新卡更干净（审核界面会标成「修改」，通过即覆盖）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '要修改的原卡 path（memory_recall 结果里的「路径：…」）' },
        title: { type: 'string', description: '新标题（不改就不传）' },
        tags: { type: 'array', items: { type: 'string' }, description: '新标签（不改就不传）' },
        body: { type: 'string', description: '新正文（不改就不传）' },
        reason: { type: 'string', description: '修改原因，会显示在审核中心' },
        source: { type: 'string', description: '来源标记，如 claude-code / codex' },
      },
      required: ['path'],
    },
  },
]

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text: String(text) }], ...(isError ? { isError: true } : {}) }
}

export async function callTool(name, args, vaultRoot, meta = {}) {
  // **数据源导向**：数据在哪，工具就在哪执行。
  // 之前只有显式配 MEMORY_API 才走远端，用户在界面里切成云端时 MCP 依然读写本机 ——
  // 表现就是「界面云端 9924 张，让 agent 记卡却落到本机 10479」。
  const DS = resolveDataSource()
  if (DS.kind === 'cloud' && name !== 'memory_revise' && name !== 'memory_audit_list') {
    try {
      if (name === 'memory_recall') {
        const query = String(args?.query || '').trim()
        if (!query) return toolResult('（未提供检索词）')
        const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 20)
        const d = await remoteJson('/search?q=' + encodeURIComponent(query) + '&limit=' + limit)
        if (!d || !d.ok) return toolResult('远端检索失败：' + ((d && d.error) || '未知'), true)
        const hits = Array.isArray(d.cards) ? d.cards : []
        if (!hits.length) return toolResult('（远端库没有相关卡片）')
        return toolResult('远端库 ' + REMOTE_API + ' 命中 ' + hits.length + ' 条：\n' + hits.map((h, i) => {
          const body = String(h.summary || h.body || '').replace(/\s+/g, ' ').slice(0, 160)
          return (i + 1) + '. ' + h.title + '（' + (h.kind || '') + '）' + (body ? '\n   ' + body : '')
        }).join('\n'))
      }
      if (name === 'memory_capture') {
        const d = await remoteJson('/write', {
          method: 'POST',
          body: JSON.stringify({
            title: String(args?.title || '').slice(0, 120),
            kind: String(args?.kind || 'knowledge'),
            body: String(args?.body || ''),
            tags: Array.isArray(args?.tags) ? args.tags : [],
            source: 'mcp-remote',
          }),
        })
        if (!d || !d.ok) return toolResult('远端写入失败：' + ((d && d.error) || '未知'), true)
        return toolResult('已提交到远端库（进待审队列）：' + (d.path || '') + '\n远端：' + REMOTE_API)
      }
      if (name === 'memory_stats') {
        const d = await remoteJson('/overview')
        if (!d || !d.ok) return toolResult('远端统计失败：' + ((d && d.error) || '未知'), true)
        return toolResult(JSON.stringify({ remote: REMOTE_API, total: d.total, byKind: d.byKind, vaultDir: d.vaultDir }, null, 2))
      }
    } catch (e) {
      return toolResult('远端调用异常：' + String((e && e.message) || e), true)
    }
  }
  switch (name) {
    case 'memory_recall': {
      const query = String(args?.query || '').trim()
      if (!query) return toolResult('（未提供检索词）')
      const limit = Math.min(Math.max(Number(args?.limit) || 5, 1), 20)
      const hits = await search(vaultRoot, query, { limit, minScore: 2 })
      if (hits.length === 0) {
        recordLedger(vaultRoot, { kind: 'recall', results: 0, chars: 0, note: query.slice(0, 120) })
        return toolResult(`记忆库中没有与「${query}」相关的内容。`)
      }
      const lines = hits.map((h, i) => {
        const tags = h.tags.length ? ` [${h.tags.join(', ')}]` : ''
        const snippet = String(h.summary || '').replace(/\s+/g, ' ').trim().slice(0, 130)
        const skillBadge = h.kind === 'skill' ? ' · 🧩 技能卡' : ''
        const skillHint = h.kind === 'skill' ? `\n技能：${h.title}（需要时用 skill 工具加载同名技能）` : ''
        return `### ${i + 1}. ${h.title}${tags}${skillBadge}\n路径：${h.path}\n${snippet}${skillHint}`
      })
      const out = `从记忆核心检索到 ${hits.length} 条相关卡片：\n\n${lines.join('\n\n')}`
      recordLedger(vaultRoot, { kind: 'recall', results: hits.length, chars: out.length, note: query.slice(0, 120) })
      return toolResult(out)
    }
    case 'memory_capture': {
      const text = String(args?.text || '')
      const src = String(args?.source || meta.submittedBy || 'mcp')
      // **数据源导向**：连着云端就写到云端，别再往本机库里塞。
      // 以前这里无条件 runStandaloneCapture(vaultRoot, ...)，用户界面明明显示云端 9924 张，
      // 写进去的卡却落在本机那张库 —— 云端的界面永远看不到。
      const ds = resolveDataSource()
      if (ds.kind === 'cloud') {
        try {
          const { status, d } = await cloudJson(ds, '/write', {
            method: 'POST',
            body: JSON.stringify({
              kind: 'knowledge',
              title: String(text).slice(0, 60).replace(/\s+/g, ' ').trim() || '会话沉淀',
              body: text,
              tags: [],
              source: src,
            }),
          })
          if (status >= 200 && status < 300 && d && d.ok) {
            return toolResult(JSON.stringify({
              ok: true, action: 'pending', store: 'cloud', target: ds.base,
              path: d.path, status: d.status || 'pending',
              note: '已写入**云端**库（当前数据源是云端），进审核中心待批。',
            }))
          }
          // 云端失败就如实报错，不悄悄回落到本机（否则又是"写进去了但界面看不到"）
          return toolResult('云端写入失败：' + ((d && d.error) || ('HTTP ' + status)), true)
        } catch (e) {
          return toolResult('云端写入失败：' + String((e && e.message) || e), true)
        }
      }
      const out = await runStandaloneCapture(vaultRoot, text, { source: src })
      if (!out.ok && out.action === 'failed') return toolResult(`沉淀失败：${out.reason}`, true)
      return toolResult(JSON.stringify({ ...out, store: 'local' }))
    }
    case 'memory_revise': {
      const rel = String(args?.path || '').trim()
      if (!rel) return toolResult('（未提供要修改的卡片 path）')
      try {
        const src = String(args?.source || meta.submittedBy || 'mcp')
        const out = await reviseCard(vaultRoot, {
          target: rel,
          title: args?.title === undefined ? undefined : String(args.title),
          tags: Array.isArray(args?.tags) ? args.tags : undefined,
          body: args?.body === undefined ? undefined : String(args.body),
          reason: String(args?.reason || ''),
          source: src,
          submittedBy: src,
        })
        return toolResult('已提交修改，待人工审核通过后覆盖原卡。\n修改副本：' + out.path + '\n原卡：' + out.target + (out.reused ? '\n（已存在待审修改，本次就地更新，未新增条目）' : ''))
      } catch (e) {
        return toolResult('提交修改失败：' + ((e && e.message) || e), true)
      }
    }
    case 'memory_audit_list': {
      await ensureVault(vaultRoot)
      const wanted = String(args?.status || 'pending').toLowerCase()
      const STATUS = { pending: ['pending'], rejected: ['rejected'], approved: ['approved'], deleted: ['deleted'], all: ['pending', 'rejected'], queue: ['pending', 'rejected'] }
      const status = STATUS[wanted] || ['pending']
      // issue #20：默认上限只为控制上下文（不给 agent 灌 500 张卡），但**不能把截断后的条数
      // 当总数报出去** —— 总数取匹配总数，截断时明确写出「还有 N 张未显示」。
      const rawLimit = Number(args?.limit)
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 20
      const total = await countCards(vaultRoot, { status })
      if (!total) return toolResult(`记忆库里没有 ${wanted} 状态的卡片（vault: ${vaultRoot}）。`)
      const cards = await listCards(vaultRoot, { status, limit })
      const hidden = Math.max(0, total - cards.length)
      const lines = cards.map((c, i) => `${i + 1}. [${c.status}] ${c.kind} · ${c.title}\n   路径：${c.path}`)
      const head = hidden > 0
        ? `待处理 ${total} 张，显示前 ${cards.length} 张（status=${wanted}，vault: ${vaultRoot}）：`
        : `待处理 ${total} 张（status=${wanted}，vault: ${vaultRoot}）：`
      const tail = hidden > 0 ? `\n\n… 还有 ${hidden} 张未显示（可加大 limit，最大 500）。` : ''
      return toolResult(
        `${head}\n\n${lines.join('\n')}${tail}\n\n` +
        '（只读列表。批准/驳回请由用户在「审核中心」面板或运行 dsh-memory audit approve/reject 显式完成。）',
      )
    }
    case 'memory_stats': {
      await ensureVault(vaultRoot)
      const ov = await overview(vaultRoot)
      const s = await stats(vaultRoot)
      return toolResult(JSON.stringify({ vaultDir: vaultRoot, total: ov.total, byKind: ov.byKind, tags: s.tags, week: s.week }, null, 2))
    }
    default:
      throw new Error(`未知工具：${name}`)
  }
}

export function startMcpServer({ vaultRoot = defaultVaultDir() } = {}) {
  const rl = readline.createInterface({ input: process.stdin })
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
  let pendingCalls = 0
  let closing = false
  // MCP 客户端信息：initialize 时记录（agent 名），供 memory_capture 署名用
  let clientInfo = {}
  const maybeExit = () => { if (closing && pendingCalls === 0) process.exit(0) }

  rl.on('line', (line) => {
    const raw = line.trim()
    if (!raw) return
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    const { id, method, params } = msg
    // notification（无 id）不回包
    if (id === undefined || id === null) {
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
      return
    }
    try {
      if (method === 'initialize') {
        const negotiated = negotiateProtocolVersion(params?.protocolVersion)
        clientInfo = params?.clientInfo || {}
        write({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiated,
            capabilities: { tools: {} },
            serverInfo: { name: 'memory-eternal', version: '1.0.0' },
          },
        })
        return
      }
      if (method === 'ping') {
        write({ jsonrpc: '2.0', id, result: {} })
        return
      }
      if (method === 'tools/list') {
        write({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } })
        return
      }
      if (method === 'tools/call') {
        const name = params?.name
        const args = params?.arguments ?? {}
        const sub = clientInfo?.name ? `${clientInfo.name}${clientInfo.version ? '@' + clientInfo.version : ''}` : 'mcp'
        pendingCalls++
        callTool(name, args, vaultRoot, { submittedBy: sub })
          .then((result) => write({ jsonrpc: '2.0', id, result }))
          .catch((error) => write({ jsonrpc: '2.0', id, result: toolResult(String(error?.message || error), true) }))
          .finally(() => { pendingCalls--; maybeExit() })
        return
      }
      write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
    } catch (error) {
      write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error?.message || error) } })
    }
  })

  rl.on('close', () => { closing = true; maybeExit() })
  process.stderr.write(`[memory-eternal] MCP server ready (vault: ${vaultRoot})\n`)
}

// 作为脚本直接运行（node lib/mcp.js / node bin/dsh-memory.mjs mcp 的转发目标）时自动启动。
if (process.argv[1] && /[\\/]mcp\.js$/.test(process.argv[1])) {
  startMcpServer()
}
