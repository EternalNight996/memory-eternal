// 记忆核心 · MCP Streamable HTTP 端点（POST /memory-eternal/api/mcp）
//
// 为什么要有：stdio 只够本机 agent 用；云端托管的 bot（MengBot 云实例之类）摸不到本机进程，
// 只能走 HTTP。这里实现 MCP Streamable HTTP 的**单次 JSON 响应**形态：
//   POST    无状态 JSON-RPC（支持单条与批量）；只有 notification（无 id）时回 202 空体
//   GET     不开 SSE 服务端流 → 405（规范允许，客户端会退回 POST）
//   DELETE  结束会话 → 200 {}
// 鉴权：云端由 cloud-server 先验 Authorization 再进到这里；本机实例沿用同源闸门
// （createApi 入口的 crossOriginError）+ loopback 信任档位，与其它写接口同一套。
import { MCP_TOOLS, callTool, negotiateProtocolVersion } from './mcp.js'

const SESSION_HEADER = 'mcp-session-id'
const newSessionId = () => 'me-' + Math.random().toString(16).slice(2) + Date.now().toString(36)

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      ...headers,
    })
    res.end(text)
  } catch { /* 连接已断，忽略 */ }
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } })

/** 单条消息 → 单条回包（或 notification 标记）。 */
async function dispatchOne(msg, { vaultRoot, sessionId }) {
  if (!msg || typeof msg !== 'object') return { body: rpcError(null, -32600, 'Invalid Request') }
  const id = msg.id
  const method = String(msg.method || '')
  // notification（无 id）不回包
  if (id === undefined || id === null) return { notification: true }

  if (method === 'initialize') {
    return {
      body: {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiateProtocolVersion(msg.params && msg.params.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: 'memory-eternal', version: '1.0.0' },
        },
      },
      headers: { [SESSION_HEADER]: sessionId },
    }
  }
  if (method === 'ping') return { body: { jsonrpc: '2.0', id, result: {} } }
  if (method === 'tools/list') return { body: { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } } }
  if (method === 'tools/call') {
    const name = String((msg.params && msg.params.name) || '')
    if (!MCP_TOOLS.some((t) => t.name === name)) return { body: rpcError(id, -32602, '未知工具：' + name) }
    try {
      const result = await callTool(name, (msg.params && msg.params.arguments) ?? {}, vaultRoot, { submittedBy: 'mcp-http' })
      return { body: { jsonrpc: '2.0', id, result } }
    } catch (e) {
      return { body: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true } } }
    }
  }
  return { body: rpcError(id, -32601, 'Method not found: ' + method) }
}

/**
 * @returns {Promise<boolean>} true = 已处理（调用方直接 return）
 */
export async function handleMcpHttp({ req, res, vaultRoot, readRaw }) {
  const method = String((req && req.method) || '').toUpperCase()

  if (method === 'GET') {
    sendJson(res, 405, {
      ok: false,
      error: '本端点不提供 SSE 服务端流，请用 POST 发 JSON-RPC（MCP Streamable HTTP 单次响应形态）',
      mcp: { transport: 'streamable-http', mode: 'stateless', transports: ['POST'] },
    }, { allow: 'POST, DELETE' })
    return true
  }
  if (method === 'DELETE') {
    sendJson(res, 200, { ok: true, closed: true })
    return true
  }
  if (method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '需要 POST' }, { allow: 'POST, DELETE' })
    return true
  }

  const raw = await readRaw(req, res)
  if (raw === null) return true // readRaw 已经回过错（体积超限等）

  let msg
  try {
    msg = JSON.parse(String(raw || '').trim())
  } catch {
    sendJson(res, 200, rpcError(null, -32700, 'Parse error'))
    return true
  }

  const incoming = String(((req && req.headers) || {})[SESSION_HEADER] || '').trim()
  const sessionId = incoming || newSessionId()
  const ctx = { vaultRoot, sessionId }

  if (Array.isArray(msg)) {
    // 批量：逐条处理，丢弃 notification；全是 notification 就回 202
    const out = []
    let headers = {}
    for (const one of msg) {
      const r = await dispatchOne(one, ctx)
      if (r.notification) continue
      if (r.headers) headers = { ...headers, ...r.headers }
      out.push(r.body)
    }
    if (!out.length) {
      try { res.writeHead(202, { [SESSION_HEADER]: sessionId }); res.end() } catch { /* 忽略 */ }
      return true
    }
    sendJson(res, 200, out, headers)
    return true
  }

  const r = await dispatchOne(msg, ctx)
  if (r.notification) {
    try { res.writeHead(202, { [SESSION_HEADER]: sessionId }); res.end() } catch { /* 忽略 */ }
    return true
  }
  sendJson(res, 200, r.body, r.headers || {})
  return true
}
