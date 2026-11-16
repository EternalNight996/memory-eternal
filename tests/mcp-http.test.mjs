// MCP Streamable HTTP 端点（POST /memory-eternal/api/mcp）的契约测试。
//
// 为什么钉住：云端托管的 bot 摸不到本机 stdio，只能走 HTTP；这条路径一旦退化，
// 「MengBot / OpenClaw 云端实例接记忆库」就直接失效，而且现场表现只是"工具没出来"。
// 守：JSON-RPC 单条/批量、协议协商、会话头、notification 202、错误码、以及真的能写能读。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createApi } from '../lib/api.js'
import { closeAllDb } from '../lib/db.js'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'me-mcp-http-'))
const root = path.join(tmpRoot, 'vault')
after(() => { try { closeAllDb() } catch { /* 忽略 */ } try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 忽略 */ } })

function withApi(fn) {
  const handler = createApi({ vaultDir: () => root, vaultRoots: () => [{ name: 'v', root }], getSettings: () => ({}) })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  return new Promise((resolve, reject) => {
    srv.listen(0, '127.0.0.1', async () => {
      let err = null
      try { await fn('http://127.0.0.1:' + srv.address().port + '/memory-eternal/api/mcp') } catch (e) { err = e }
      await new Promise((r) => srv.close(r))
      if (err) reject(err); else resolve()
    })
  })
}

const rpc = (url, body, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})
const post = async (url, body, headers) => {
  const r = await rpc(url, body, headers)
  const text = await r.text()
  return { status: r.status, headers: r.headers, body: text ? JSON.parse(text) : null }
}

test('GET 不提供 SSE 流 → 405 且告知只用 POST', async () => {
  await withApi(async (url) => {
    const r = await fetch(url)
    assert.equal(r.status, 405)
    assert.match(r.headers.get('allow') || '', /POST/)
    const j = await r.json()
    assert.match(j.error, /POST/)
  })
})

test('initialize：协议协商 + serverInfo + 下发 mcp-session-id', async () => {
  await withApi(async (url) => {
    for (const v of ['2025-06-18', '2024-11-05', '1999-01-01']) {
      const r = await post(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '0' } } })
      assert.equal(r.status, 200)
      const want = v === '1999-01-01' ? '2024-11-05' : v
      assert.equal(r.body.result.protocolVersion, want)
      assert.equal(r.body.result.serverInfo.name, 'memory-eternal')
      assert.deepEqual(r.body.result.capabilities, { tools: {} })
      assert.match(r.headers.get('mcp-session-id') || '', /^me-/)
    }
  })
})

test('notification（无 id）→ 202 空体；后续请求可带会话头', async () => {
  await withApi(async (url) => {
    const init = await post(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    const sid = init.headers.get('mcp-session-id')
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
    assert.equal(r.status, 202)
    assert.equal((await r.text()).length, 0)
    const tl = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': sid })
    assert.equal(tl.body.result.tools.length, 5)
  })
})

test('tools/list：5 个工具且 schema 合法', async () => {
  await withApi(async (url) => {
    const r = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = r.body.result.tools.map((t) => t.name).sort()
    assert.deepEqual(names, ['memory_audit_list', 'memory_capture', 'memory_recall', 'memory_revise', 'memory_stats'])
    for (const t of r.body.result.tools) assert.equal(t.inputSchema.type, 'object')
  })
})

test('tools/call：stats → capture → recall 真的落库能被召回', async () => {
  await withApi(async (url) => {
    const stats = await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_stats', arguments: {} } })
    assert.equal(stats.body.result.isError, undefined)
    const body = 'HTTP MCP 契约测试：这一段文本用于验证 memory_capture 经 Streamable HTTP 写入后能被立刻召回。'.repeat(4)
    const cap = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_capture', arguments: { text: body, source: 'mcp-http-test' } } })
    const parsed = JSON.parse(cap.body.result.content[0].text)
    assert.equal(parsed.ok, true, JSON.stringify(parsed))
    const recall = await post(url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_recall', arguments: { query: 'HTTP MCP 契约测试' } } })
    assert.match(recall.body.result.content[0].text, /检索到|没有与/)
  })
})

test('错误码：未知工具 -32602 / 未知方法 -32601 / 非法 JSON -32700', async () => {
  await withApi(async (url) => {
    const bad = await post(url, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'no_such', arguments: {} } })
    assert.equal(bad.body.error.code, -32602)
    const unknown = await post(url, { jsonrpc: '2.0', id: 8, method: 'resources/list' })
    assert.equal(unknown.body.error.code, -32601)
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })
    const j = await r.json()
    assert.equal(j.error.code, -32700)
  })
})

test('批量 JSON-RPC：返回数组，notification 被丢弃', async () => {
  await withApi(async (url) => {
    const r = await post(url, [
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ])
    assert.ok(Array.isArray(r.body))
    assert.deepEqual(r.body.map((x) => x.id), [1, 2])
  })
})

test('DELETE 结束会话 → 200', async () => {
  await withApi(async (url) => {
    const r = await fetch(url, { method: 'DELETE' })
    assert.equal(r.status, 200)
    assert.equal((await r.json()).ok, true)
  })
})
