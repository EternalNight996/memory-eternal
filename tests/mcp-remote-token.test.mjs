// 远端 MCP 模式必须带 Authorization：这是「MCP 能连云端实例」的前提。
//
// 现场表现对比：不带令牌 → 云端所有业务接口 401，agent 只看到"召回失败"；
// 带令牌 → 召回/统计正常。所以这条要钉在测试里，不能靠人记得传 --token。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function runMcpWith(args, { onRequest } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'me-remote-token-'))
  const srv = http.createServer((req, res) => {
    if (onRequest) onRequest(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, total: 0, byKind: {}, vaultDir: '/remote' }))
  })
  return new Promise((resolve, reject) => {
    srv.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + srv.address().port
      const child = spawn(process.execPath, [path.resolve('bin/dsh-memory.mjs'), 'mcp', ...args.map((a) => String(a).replace('{BASE}', base))], {
        env: { ...process.env, MEMORY_VAULT_DIR: path.join(home, 'vault') },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let out = '', err = ''
      child.stdout.on('data', (d) => { out += d.toString() })
      child.stderr.on('data', (d) => { err += d.toString() })
      const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_stats', arguments: {} } })
      setTimeout(() => child.stdin.end(), 1500)
      child.on('close', () => srv.close(() => resolve({ out, err })))
      child.on('error', reject)
    })
  })
}

test('远端模式：--cloud 指向的实例收到 Authorization: Bearer <token>', async () => {
  const seen = []
  const { out } = await runMcpWith(['--cloud', '{BASE}', '--token', 'me_abc123'], { onRequest: (req) => seen.push(String(req.headers.authorization || '')) })
  assert.ok(seen.length >= 1, '远端模式应当真的发起 HTTP 请求')
  assert.equal(seen[0], 'Bearer me_abc123', '没带令牌，云端实例会 401')
  assert.match(out, /remote/, '统计结果应来自远端')
})

test('--cloud 也接受带 /memory-eternal/api 后缀的地址（不会拼成双份）', async () => {
  const seen = []
  const { out } = await runMcpWith(['--cloud', '{BASE}/memory-eternal/api', '--token', 'me_x'], { onRequest: (req) => seen.push(String(req.url || '')) })
  assert.ok(seen.every((u) => !u.includes('/api/memory-eternal/api')), '路径被拼重了：' + seen.join(', '))
  assert.match(out, /remote/)
})
