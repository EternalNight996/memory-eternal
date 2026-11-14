// 回归：云端推送失败的补推队列。
//
// 现场需求：切云端后 agent 沉淀自动推到云端；推送失败不能丢，要有补推路径。
// 这里只测队列本身的读写/封顶/本地模式行为 —— 真实推送靠 /import/chunk（幂等）保证。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/** 每个用例用独立 DSH_HOME，互不干扰，也不碰用户真实配置。 */
async function fresh() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'me-qtest-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = tmp
  const mod = await import('../lib/cloud-push.js?' + Date.now() + Math.random())
  return {
    mod,
    tmp,
    restore() {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      fs.rmSync(tmp, { recursive: true, force: true })
    },
  }
}

test('本地模式下 shouldPushToCloud 为 false', async () => {
  const { mod, restore } = await fresh()
  try {
    mod.writeCloudConn({ mode: 'local', url: '', token: '', active: false })
    assert.equal(mod.shouldPushToCloud(), false)
  } finally { restore() }
})

test('云端模式但缺 token → 不推（避免打无鉴权请求）', async () => {
  const { mod, restore } = await fresh()
  try {
    mod.writeCloudConn({ mode: 'cloud', url: 'https://example.com', token: '', active: true })
    assert.equal(mod.shouldPushToCloud(), false)
  } finally { restore() }
})

test('云端模式 + token + 合法 url → 该推', async () => {
  const { mod, restore } = await fresh()
  try {
    mod.writeCloudConn({ mode: 'cloud', url: 'https://example.com', token: 't0ken', active: true })
    assert.equal(mod.shouldPushToCloud(), true)
  } finally { restore() }
})

test('云端模式但 url 不是 http(s) → 写入被拒', async () => {
  const { mod, restore } = await fresh()
  try {
    const r = mod.writeCloudConn({ mode: 'cloud', url: 'ftp://x', token: 't', active: true })
    assert.equal(r.ok, false, '非法 url 必须在写入时拒绝，而不是等到推送时才报错')
  } finally { restore() }
})

test('失败入队 → 可读回 → 字段完整', async () => {
  const { mod, restore } = await fresh()
  try {
    mod.enqueueFailedPush({ title: '标题甲', kind: 'knowledge', body: '正文甲', source: 'test' }, 'HTTP 503')
    const q = mod.readQueue()
    assert.equal(q.length, 1)
    assert.equal(q[0].title, '标题甲')
    assert.equal(q[0].kind, 'knowledge')
    assert.equal(q[0].body, '正文甲')
    assert.equal(q[0].error, 'HTTP 503')
    assert.ok(q[0].at, '要有入队时间')
  } finally { restore() }
})

test('本地模式 flush 不动队列（返回 not-cloud）', async () => {
  const { mod, restore } = await fresh()
  try {
    mod.writeCloudConn({ mode: 'local', url: '', token: '', active: false })
    mod.enqueueFailedPush({ title: 'a', kind: 'knowledge', body: 'x' }, 'e')
    const r = await mod.flushQueue()
    assert.equal(r.ok, false)
    assert.equal(r.error, 'not-cloud')
    assert.equal(mod.readQueue().length, 1, '本地模式绝不能清队列，否则数据就真丢了')
  } finally { restore() }
})

test('队列封顶：超过 500 条后保留最新的', async () => {
  const { mod, restore } = await fresh()
  try {
    for (let i = 0; i < 505; i++) {
      mod.enqueueFailedPush({ title: 'card-' + i, kind: 'knowledge', body: 'b' + i }, 'e')
    }
    const q = mod.readQueue()
    assert.ok(q.length <= 500, '封顶后不该超过 500，实际 ' + q.length)
    // 最新的在（505 次入队 → 最后一条是 card-504）
    assert.ok(q.some((r) => r.title === 'card-504'), '最新一张必须在队里')
  } finally { restore() }
})

test('队列文件有坏行时不炸（JSONL 容错）', async () => {
  const { mod, restore, tmp } = await fresh()
  try {
    const p = path.join(tmp, 'memory-eternal-cloud-queue.jsonl')
    fs.writeFileSync(p, JSON.stringify({ title: 'good', kind: 'knowledge', body: 'x' }) + '\n{坏行\n' + JSON.stringify({ title: 'good2', kind: 'knowledge', body: 'y' }) + '\n', 'utf8')
    const q = mod.readQueue()
    assert.equal(q.length, 2, '坏行要被跳过，好行照读')
    assert.deepEqual(q.map((r) => r.title), ['good', 'good2'])
  } finally { restore() }
})

test('空队列 flush 直接返回，不发请求', async () => {
  const { mod, restore } = await fresh()
  try {
    mod.writeCloudConn({ mode: 'cloud', url: 'https://example.com', token: 't', active: true })
    const r = await mod.flushQueue()
    assert.equal(r.ok, true)
    assert.equal(r.total, 0)
    assert.equal(r.sent, 0)
  } finally { restore() }
})
