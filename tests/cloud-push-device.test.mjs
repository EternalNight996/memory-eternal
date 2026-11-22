// 自动沉淀的云端推送必须带本机的设备 id（多设备同账号的核心坑）。
//
// 背景：capture 是本地写 + 异步推送云端（pushCardToCloud → POST /api/import/chunk）。
// 云端该接口的 vaultDir 是按请求头 X-Device-Id 解析的（activeRootOf(roots, currentDevice())）。
// 推送不带这个头 → 落进「全局活跃库」（最后一次切库那台决定的），两台设备选不同库时写错地方。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pushCardToCloud, writeCloudConn, readCloudConn } from '../lib/cloud-push.js'

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'me-push-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return Promise.resolve(fn(home)).finally(() => {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* 忽略 */ }
  })
}

test('conn 文件保存/读回 deviceId（客户端同步下来的设备 id）', () => withHome(async () => {
  const w = writeCloudConn({ mode: 'cloud', url: 'https://cloud.example', token: 'me_token_1234567890abcd', active: true, owner: 'a@b.c', deviceId: 'dev-abc-123' })
  assert.equal(w.ok, true, JSON.stringify(w))
  const c = readCloudConn()
  assert.equal(c.deviceId, 'dev-abc-123', 'readCloudConn 要带回 deviceId')
  // 后续只传部分字段时不能被抹掉（合并语义）
  writeCloudConn({ mode: 'cloud', url: 'https://cloud.example', token: 'me_token_1234567890abcd', active: true })
  assert.equal(readCloudConn().deviceId, 'dev-abc-123')
}))

test('pushCardToCloud 会带 X-Device-Id', () => withHome(async () => {
  const seen = { headers: null, url: '' }
  const srv = http.createServer((req, res) => {
    seen.url = req.url
    seen.headers = req.headers
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, imported: 1, duplicate: 0 }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + srv.address().port
  try {
    writeCloudConn({ mode: 'cloud', url: base, token: 'me_token_1234567890abcd', active: true, deviceId: 'dev-abc-123' })
    const out = await pushCardToCloud({ title: '推送测试', body: '一段足够长的推送测试正文。', kind: 'knowledge' })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(seen.url, '/api/import/chunk')
    assert.equal(seen.headers['x-device-id'], 'dev-abc-123', '推送必须带设备 id，否则会写进全局活跃库')
    assert.match(String(seen.headers.authorization || ''), /^Bearer me_/)
  } finally {
    await new Promise((r) => srv.close(r))
  }
}))

test('没有 deviceId 时（老客户端）不带头，行为与之前一致', () => withHome(async () => {
  const seen = { headers: null }
  const srv = http.createServer((req, res) => {
    seen.headers = req.headers
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, imported: 1 }))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + srv.address().port
  try {
    writeCloudConn({ mode: 'cloud', url: base, token: 'me_token_1234567890abcd', active: true })
    const out = await pushCardToCloud({ title: '推送测试2', body: '另一段足够长的推送测试正文。', kind: 'knowledge' })
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(seen.headers['x-device-id'], undefined, '没设备 id 就不发（老库/老客户端兼容）')
  } finally {
    await new Promise((r) => srv.close(r))
  }
}))
