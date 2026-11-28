// 操作日志：新增分析字段（kind/session/card_key/ok/detail）必须落库并能从 /logs 取到。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { ensureVault } from '../lib/vault.js'
import { closeDb, logActivity } from '../lib/db.js'
import { createApi } from '../lib/api.js'

test('activity_log 写入分析字段并由 /logs 返回', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'me-logdetail-'))
  const root = path.join(parent, 'v')
  await ensureVault(root)
  const ok = logActivity(root, {
    ip: '127.0.0.1',
    agent: 'test-agent',
    action: 'capture',
    title: '日志分析字段',
    target: '02-Projects/a.md',
    kind: 'project',
    session: 'sess-1',
    card_key: 'uid-1',
    ok: false,
    detail: { store: 'cards', status: 'pending', rel: '02-Projects/a.md' },
  })
  assert.equal(ok, true)
  const handler = createApi({ vaultDir: () => root, vaultRoots: () => [{ name: 'v', root }], getSettings: () => ({}) })
  const srv = http.createServer(async (req, res) => { await handler(req, res) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  try {
    const base = `http://127.0.0.1:${srv.address().port}/memory-eternal/api`
    const d = await fetch(base + '/logs?limit=10').then((r) => r.json())
    assert.equal(d.ok, true)
    const row = (d.rows || []).find((x) => x.title === '日志分析字段')
    assert.ok(row, '日志行应存在')
    assert.equal(row.kind, 'project')
    assert.equal(row.session, 'sess-1')
    assert.equal(row.card_key, 'uid-1')
    assert.equal(Number(row.ok), 0)
    assert.equal(JSON.parse(row.detail).status, 'pending')
  } finally {
    await new Promise((r) => srv.close(r))
    try { closeDb(root) } catch { /* 忽略 */ }
    fs.rmSync(parent, { recursive: true, force: true })
  }
})
