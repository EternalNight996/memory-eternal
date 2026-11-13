// 语义召回 API 冒烟：配置 → 探测 → 建缓存 → 状态覆盖率（真实 HTTP 路由，不 mock handler）。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureVault, writeCard } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'
import { createApi } from '../lib/api.js'

const DIM = 8
function vecOf(text) {
  const v = new Float32Array(DIM)
  const s = String(text)
  const classes = [['卡死', '超时'], ['检索', '搜不到'], ['成本', '花费']]
  classes.forEach((ws, i) => { if (ws.some((w) => s.includes(w))) v[i] += 1 })
  let n = 0
  for (let i = 0; i < DIM; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < DIM; i++) v[i] /= n
  return Array.from(v)
}

let mock, api, root, dsh, savedHome, base, mockBase

before(async () => {
  dsh = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-embedapi-home-'))
  savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dsh

  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-embedapi-vault-'))
  await ensureVault(root)
  await writeCard(root, { kind: 'knowledge', title: '请求超时处理', body: '线上请求超时排查与结论。', status: 'approved' })
  await writeCard(root, { kind: 'knowledge', title: '发布流程', body: 'npm 发布与版本约定。', status: 'approved' })

  mock = http.createServer((req, res) => {
    if (req.url.includes('/embeddings')) {
      let raw = ''
      req.on('data', (d) => { raw += d })
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        const inputs = Array.isArray(body.input) ? body.input : [body.input]
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: inputs.map((t, i) => ({ index: i, embedding: vecOf(t) })) }))
      })
      return
    }
    if (req.url.includes('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'mock-embed-8' }] })); return }
    res.writeHead(404); res.end('no')
  })
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  mockBase = 'http://127.0.0.1:' + mock.address().port + '/v1'

  api = http.createServer(createApi({ vaultDir: () => root, vaultRoots: () => [{ name: '', root }], getSettings: () => ({}) }))
  await new Promise((r) => api.listen(0, '127.0.0.1', r))
  base = 'http://127.0.0.1:' + api.address().port + '/memory-eternal/api'
})

after(async () => {
  closeAllDb()
  process.env.DSH_HOME = savedHome
  for (const s of [mock, api]) if (s) await new Promise((r) => s.close(r))
  try { await fsp.rm(dsh, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
  try { await fsp.rm(root, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
})

const j = (p, opt) => fetch(base + p, opt).then((r) => r.json())

test('默认状态：关闭、默认 7997、无向量', async () => {
  const s = await j('/embedding/status')
  assert.equal(s.ok, true)
  assert.equal(s.enabled, false)
  assert.equal(s.config.baseUrl, 'http://127.0.0.1:7997/v1')
  assert.equal(s.coverage.vectors, 0)
})

test('保存配置 → 探测 → 建缓存 → 覆盖率到 2/2', async () => {
  // 显式带 mode：不带的话会沿用上一条用例（内置通道）留下的 mode，
  // 于是探测走 builtin 分支、kind 断言就红了（测试间状态泄漏，不是功能问题）。
  const c = await j('/embedding/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, mode: 'online', baseUrl: mockBase, model: 'mock-embed-8' }) })
  assert.equal(c.ok, true)
  assert.equal(c.config.enabled, true)
  assert.equal(c.config.mode, 'online')

  const p = await j('/embedding/status?probe=1')
  assert.equal(p.service.reachable, true)
  assert.equal(p.service.kind, 'openai')

  const b = await j('/embedding/backfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 10 }) })
  assert.equal(b.ok, true)
  for (let i = 0; i < 50; i++) {
    const s = await j('/embedding/status')
    if (s.job && s.job.state !== 'running') break
    await new Promise((r) => setTimeout(r, 100))
  }
  const s = await j('/embedding/status')
  assert.equal(s.job.state, 'done', '建缓存任务应完成：' + JSON.stringify(s.job))
  assert.equal(s.coverage.vectors, 2)
  assert.equal(s.coverage.cards, 2)
})

test('非法地址被拒绝（不会写坏配置）', async () => {
  const bad = await j('/embedding/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseUrl: 'ftp://nope' }) })
  assert.equal(bad.ok, false)
  const s = await j('/embedding/status')
  assert.equal(s.config.baseUrl, mockBase)
})

test('模型目录接口：目录/厂商/机器条件/Ollama 状态齐全', async () => {
  const m = await j('/embedding/models')
  assert.equal(m.ok, true)
  assert.ok(Array.isArray(m.catalog) && m.catalog.length >= 5, '模型目录至少 5 项')
  assert.ok(Array.isArray(m.vendors) && m.vendors.length >= 4, '厂商预设至少 4 项')
  assert.ok(m.system.cores > 0, '应能读到 CPU 核数')
  assert.ok(m.system.ramGB > 0, '应能读到内存')
  assert.equal(typeof m.ollama.installed, 'boolean')
  assert.equal(m.config.model, 'mock-embed-8')
})

test('一键部署：写配置并启动建缓存任务', async () => {
  const d = await j('/embedding/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock-embed-8', baseUrl: mockBase }) })
  assert.equal(d.ok, true)
  assert.equal(d.job.kind, 'backfill')
  for (let i = 0; i < 50; i++) {
    const s = await j('/embedding/status')
    if (s.job && s.job.state !== 'running') break
    await new Promise((r) => setTimeout(r, 100))
  }
  const s = await j('/embedding/status')
  assert.equal(s.job.state, 'done', '部署任务应完成：' + JSON.stringify(s.job))
  const c = await j('/embedding/status')
  assert.equal(c.coverage.vectors, 2)
})

test('语义开关：关闭后 enabled=false，开启后恢复', async () => {
  const off = await j('/embedding/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }) })
  assert.equal(off.ok, true)
  assert.equal(off.config.enabled, false)
  const st = await j('/embedding/status')
  assert.equal(st.enabled, false, '关闭后 settingsFor 应为空（检索回落纯词法）')

  const on = await j('/embedding/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
  assert.equal(on.ok, true)
  const st2 = await j('/embedding/status')
  assert.equal(st2.enabled, true)
  assert.equal(st2.config.model, 'mock-embed-8', '开关不应丢掉已保存的模型')
})

test('内置语义（无需 Ollama）：是**真能用**的本地通道，部署后直接建向量', async () => {
  // 历史行为是「mode=builtin 等于关掉语义召回」（enabled=false、不建向量）——
  // 那让面板上的「内置语义」变成一个骗人的选项。现在它是本地 n-gram 通道：
  // enabled=true、model=builtin-ngram-768、照常走 backfill。
  const d = await j('/embedding/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'builtin' }) })
  assert.equal(d.ok, true, JSON.stringify(d))
  assert.equal(d.mode, 'builtin')
  assert.ok(d.job, '内置模式应当启动建向量任务（本地算，不联网）')
  const st = await j('/embedding/status?probe=1')
  assert.equal(st.config.mode, 'builtin')
  assert.equal(st.config.enabled, true, '内置通道是启用的')
  assert.equal(st.config.model, 'builtin-ngram-768')
  assert.equal(st.service.kind, 'builtin', '内置通道的服务探测应当直接报 reachable/builtin')
})
