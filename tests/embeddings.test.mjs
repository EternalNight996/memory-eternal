// 可选语义召回：mock 一个 OpenAI 兼容 /embeddings 端点，验证
//   · 配置缺失 → 完全不启用（纯词法）
//   · 有缓存 + 查询无字面交集 → 向量召回仍能把卡带出来
//   · 服务不可用 → 降级不抛错
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureVault, writeCard, search, deleteCard } from '../lib/vault.js'
import { closeAllDb } from '../lib/db.js'
import { embeddingSettings, settingsFor, backfill, vectorStats, denseSearch, denseBonus, cosine, probeService } from '../lib/embeddings.js'
import { readEmbeddingConfig, writeEmbeddingConfig, embeddingConfigFile } from '../lib/embedding-config.js'

// 语义类：同类的词落在同一维度，模拟「同义/近义」被 embedding 拉到一起
const CLASSES = [
  ['卡死', '超时', '卡住', '无响应'],
  ['检索', '搜不到', '查找'],
  ['成本', '花费', '价格'],
]
const DIM = 8
function vecOf(text) {
  const v = new Float32Array(DIM)
  const s = String(text)
  for (let c = 0; c < CLASSES.length; c++) {
    if (CLASSES[c].some((w) => s.includes(w))) v[c] += 1
  }
  // 其余字符做散列，保证不同文本多少有差异
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch)) v[4 + (ch.charCodeAt(0) % 4)] += 0.05
  }
  let n = 0
  for (let i = 0; i < DIM; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < DIM; i++) v[i] /= n
  return Array.from(v)
}

let server
let port
let isolatedHome
let savedDshHome
const saved = { ...process.env }

before(async () => {
  // 隔离 DSH_HOME：避免读到本机真实的 .embedding.json（启用 bge-m3）导致测试走错端点
  isolatedHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-embed-home-'))
  savedDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = isolatedHome
  server = http.createServer((req, res) => {
    if (req.url.includes('/embeddings')) {
      let raw = ''
      req.on('data', (d) => { raw += d })
      req.on('end', () => {
        try {
          const body = JSON.parse(raw || '{}')
          const inputs = Array.isArray(body.input) ? body.input : [body.input]
          const data = inputs.map((t, i) => ({ index: i, embedding: vecOf(t) }))
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data }))
        } catch (e) {
          res.writeHead(500); res.end(String(e))
        }
      })
      return
    }
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'mock-embed-8' }] }))
      return
    }
    if (req.url.includes('/api/tags')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ models: [{ name: 'bge-m3' }] }))
      return
    }
    res.writeHead(404); res.end('no')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  port = server.address().port
})

after(async () => {
  closeAllDb()
  process.env = { ...saved }
  if (savedDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedDshHome
  if (server) await new Promise((r) => server.close(r))
  try { await fsp.rm(isolatedHome, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
})

async function freshVault() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-embed-'))
  await ensureVault(root)
  return root
}

const cfgFor = () => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: '', model: 'mock-embed-8' })

test('未配置 embedding 时 embeddingSettings 返回 null（功能不启用）', () => {
  const env = { ...process.env }
  delete env.MEMORY_EMBED_BASE_URL; delete env.MEMORY_EMBED_MODEL
  delete env.MEMORY_LLM_BASE_URL; delete env.OPENAI_BASE_URL
  assert.equal(embeddingSettings(env), null)
})

test('cosine / denseBonus 口径', () => {
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([1, 0])), 1)
  assert.equal(cosine(new Float32Array([1, 0]), new Float32Array([0, 1])), 0)
  assert.equal(denseBonus(1, { topN: 50, max: 2 }), 2)
  assert.ok(denseBonus(50) > 0)
  assert.equal(denseBonus(51), 0)
})

test('向量召回：查询与卡片无字面交集，靠同义类命中', async () => {
  const root = await freshVault()
  const cfg = cfgFor()
  const target = await writeCard(root, { kind: 'knowledge', title: '请求超时处理', body: '记录一次线上请求超时的排查过程与结论。', status: 'approved' })
  await writeCard(root, { kind: 'knowledge', title: '发布流程', body: 'npm 发布与版本号约定。', status: 'approved' })
  await writeCard(root, { kind: 'knowledge', title: '成本核算', body: '服务器成本与花费汇总。', status: 'approved' })

  process.env.MEMORY_EMBED_BASE_URL = cfg.baseUrl
  process.env.MEMORY_EMBED_MODEL = cfg.model
  delete process.env.MEMORY_EMBED_KEY

  const r = await backfill(root, cfg, { limit: 10, batch: 4 })
  assert.equal(r.embedded, 3)
  const st = vectorStats(root, cfg.model)
  assert.equal(st.vectors, 3)

  // 查询里只有「卡死」，卡片里只有「超时」：字面零交集
  const hits = await search(root, '请求卡死怎么处理')
  assert.ok(hits.some((h) => h.path === target.path), '向量召回应把无字面交集的卡带出来')
})

test('向量不足覆盖率时 denseSearch 返回 null（不误用半套缓存）', async () => {
  const root = await freshVault()
  // 先清掉环境变量再写卡：否则写卡后的增量同步会补齐全部向量，覆盖率就不再是半套
  delete process.env.MEMORY_EMBED_BASE_URL
  delete process.env.MEMORY_EMBED_MODEL
  for (const [t, b] of [['A', '超时'], ['B', '成本'], ['C', '发布'], ['D', '检索'], ['E', '部署']]) {
    await writeCard(root, { kind: 'knowledge', title: t, body: b, status: 'approved' })
  }
  const cfg = cfgFor()
  process.env.MEMORY_EMBED_BASE_URL = cfg.baseUrl
  process.env.MEMORY_EMBED_MODEL = cfg.model
  await backfill(root, cfg, { limit: 1 }) // 只补 1/5
  const d = await denseSearch(root, '卡死')
  assert.equal(d, null)
})

test('服务不可用时降级：不死循环、不抛错', async () => {
  const root = await freshVault()
  await writeCard(root, { kind: 'knowledge', title: '超时处理', body: '超时', status: 'approved' })
  process.env.MEMORY_EMBED_BASE_URL = 'http://127.0.0.1:1'
  process.env.MEMORY_EMBED_MODEL = 'mock-embed-8'
  // 无缓存 → denseSearch 先返回 null；即使有缓存，也会因请求失败降级
  const d = await denseSearch(root, '卡死')
  assert.equal(d, null)
  const hits = await search(root, '超时')
  assert.ok(Array.isArray(hits), '检索必须照常返回')
})

test('配置面板：写入/读取/校验 + 默认关闭 7997', async () => {
  const dsh = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-embed-cfg-'))
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = dsh
  try {
    const def = readEmbeddingConfig()
    assert.equal(def.enabled, false, '默认必须关闭')
    assert.equal(def.mode, 'builtin', '新装默认内置语义（零安装）')
    assert.equal(def.baseUrl, 'http://127.0.0.1:7997/v1', '默认端口 7997')
    assert.equal(def.model, 'bge-m3')
    assert.ok(embeddingConfigFile().endsWith('.embedding.json'))

    const w = writeEmbeddingConfig({ enabled: true, model: 'bge-m3' })
    assert.equal(w.enabled, true)
    const r = readEmbeddingConfig()
    assert.equal(r.baseUrl, 'http://127.0.0.1:7997/v1')
    assert.equal(r.model, 'bge-m3')

    assert.throws(() => writeEmbeddingConfig({ baseUrl: 'ftp://nope' }), /http/)
    assert.throws(() => writeEmbeddingConfig({ model: 'bad model!!' }), /模型名/)
  } finally {
    process.env.DSH_HOME = savedHome
    try { await fsp.rm(dsh, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
  }
})

test('settingsFor：保存并启用后优先于环境变量；关闭时回退 env', async () => {
  const dsh = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-embed-cfg2-'))
  const savedHome = process.env.DSH_HOME
  const savedBase = process.env.MEMORY_EMBED_BASE_URL
  const savedModel = process.env.MEMORY_EMBED_MODEL
  process.env.DSH_HOME = dsh
  process.env.MEMORY_EMBED_BASE_URL = 'http://env.example/v1'
  process.env.MEMORY_EMBED_MODEL = 'env-model'
  try {
    writeEmbeddingConfig({ enabled: true, baseUrl: 'http://127.0.0.1:7997/v1', model: 'bge-m3' })
    const on = settingsFor('/tmp/whatever')
    assert.equal(on.source, 'config')
    assert.equal(on.model, 'bge-m3')

    writeEmbeddingConfig({ enabled: false })
    const off = settingsFor('/tmp/whatever')
    assert.equal(off.source, 'env')
    assert.equal(off.model, 'env-model')
  } finally {
    process.env.DSH_HOME = savedHome
    if (savedBase === undefined) delete process.env.MEMORY_EMBED_BASE_URL; else process.env.MEMORY_EMBED_BASE_URL = savedBase
    if (savedModel === undefined) delete process.env.MEMORY_EMBED_MODEL; else process.env.MEMORY_EMBED_MODEL = savedModel
    try { await fsp.rm(dsh, { recursive: true, force: true }) } catch { /* Windows 句柄 */ }
  }
})

test('probeService：识别 OpenAI 兼容端点的 /models', async () => {
  const p = await probeService(cfgFor())
  assert.equal(p.reachable, true)
  assert.equal(p.kind, 'openai')
  assert.ok(p.models.includes('mock-embed-8'))
})

test('增量同步：写卡自动补向量，删卡自动清理', async () => {
  const root = await freshVault()
  process.env.MEMORY_EMBED_BASE_URL = `http://127.0.0.1:${port}/v1`
  process.env.MEMORY_EMBED_MODEL = 'mock-embed-8'
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  try {
    const w = await writeCard(root, { kind: 'knowledge', title: '增量同步卡', body: '这张卡用于验证写后自动补向量。', status: 'approved' })
    for (let i = 0; i < 60 && vectorStats(root, 'mock-embed-8').vectors < 1; i++) await sleep(50)
    assert.equal(vectorStats(root, 'mock-embed-8').vectors, 1, '写卡后应自动补出向量')
    await deleteCard(root, w.path)
    for (let i = 0; i < 60 && vectorStats(root, 'mock-embed-8').vectors > 0; i++) await sleep(50)
    assert.equal(vectorStats(root, 'mock-embed-8').vectors, 0, '删卡后应清理向量')
  } finally {
    delete process.env.MEMORY_EMBED_BASE_URL
    delete process.env.MEMORY_EMBED_MODEL
  }
})
