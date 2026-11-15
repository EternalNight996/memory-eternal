// 沉淀自检（/overview 的 capture 字段）：把「为什么没有新卡片」变成可断言的一行结论
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApi, API_PREFIX } from '../lib/api.js'
import { ensureVault, writeCard } from '../lib/vault.js'
import { getDb, closeAllDb } from '../lib/db.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-capcheck-'))
process.env.DSH_HOME = path.join(tmp, 'home')
await fs.mkdir(process.env.DSH_HOME, { recursive: true })

after(async () => {
  closeAllDb()
  await fs.rm(tmp, { recursive: true, force: true })
})

const res = () => {
  const out = { status: 0, body: '' }
  out.writeHead = (s) => { out.status = s }
  out.setHeader = () => {}
  out.end = (b) => { out.body = String(b || '') }
  out.on = () => {}
  out.once = () => {}
  out.emit = () => {}
  return out
}
const get = async (api, url) => {
  const r = res()
  await api({ url, method: 'GET', headers: {} }, r)
  return JSON.parse(r.body)
}

test('/overview 带 capture 自检：发号器在 → seqOk=true，并给出 seq', async () => {
  const dir = path.join(tmp, 'v1')
  await ensureVault(dir)
  const api = createApi({ vaultDir: () => dir, getSettings: () => ({}), getCaptureLog: () => [] })
  const o = await get(api, API_PREFIX + '/overview')
  assert.equal(o.ok, true)
  assert.ok(o.capture, '必须带 capture 字段')
  assert.equal(o.capture.seqOk, true)
  assert.equal(o.capture.cardSeq, 0, '空库的 seq 是 0（0 也是"有值"）')
  assert.equal(o.capture.lastFail, null)
})

test('/overview：发号器被清掉 → seqOk=false（这是"写不进卡"的可见信号）', async () => {
  const dir = path.join(tmp, 'v2')
  await ensureVault(dir)
  const db = getDb(dir)
  db.prepare("DELETE FROM card_sequence WHERE name='card'").run()
  const api = createApi({ vaultDir: () => dir, getSettings: () => ({}), getCaptureLog: () => [] })
  const o = await get(api, API_PREFIX + '/overview')
  assert.equal(o.capture.seqOk, false, '自检必须如实报缺失，不能假装健康')
  assert.equal(o.capture.cardSeq, null)
})

test('/overview：最近一次蒸馏失败（AUTH）要带出来，且比成功新时能看出"卡在鉴权"', async () => {
  const dir = path.join(tmp, 'v3')
  await ensureVault(dir)
  await writeCard(dir, { kind: 'knowledge', title: '有卡', tags: ['t'], body: '写一张卡，让 seq 变成 1，避免和空库混淆。', status: 'approved' })
  const now = Date.now()
  const log = [
    { time: now - 60000, action: 'created', reason: '新卡：早一点的' },
    { time: now - 1000, action: 'fail', reason: '蒸馏调用失败（deepseek-official/deepseek-flash）：AUTH Authentication Fails' },
  ]
  const api = createApi({ vaultDir: () => dir, getSettings: () => ({}), getCaptureLog: () => log })
  const o = await get(api, API_PREFIX + '/overview')
  assert.equal(o.capture.seqOk, true)
  assert.ok(o.capture.lastFail, '最近失败要带出来')
  assert.match(o.capture.lastFail.reason, /AUTH/)
  assert.ok(o.capture.lastFail.at > o.capture.lastCreatedAt, '失败比成功新 → 前端据此标黄并显示原因')
})

test('/overview：自动沉淀被关掉时如实报告（不是故障，是开关）', async () => {
  const dir = path.join(tmp, 'v4')
  await ensureVault(dir)
  const api = createApi({ vaultDir: () => dir, getSettings: () => ({ autoCapture: false }), getCaptureLog: () => [] })
  const o = await get(api, API_PREFIX + '/overview')
  assert.equal(o.capture.autoCapture, false)
})
