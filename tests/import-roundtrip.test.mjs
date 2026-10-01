// 记忆核心 · 导入/导出回归测试（issue：导出 OK、导入 0 张、且提示只有「导入完成：0」）
//
// 根因：客户端「导出JSON」写出的是**裸数组**，而 /import 只读 payload.cards —— 裸数组被
// 静默当成空备份（ok:true / imported:0 / skipped:0），UI 于是只显示「导入完成：0」。
// 这里直接驱动真实路由处理器，钉死：
//   ① 裸数组（v0.10.0 及以前的备份）整批导回；
//   ② 信封对象（新备份形状）整批导回；
//   ③ 同批里互相近似的卡不互相吞（去重基线 = 导入前快照）；
//   ④ 同库重复导入被如实判重（不是静默 0）；
//   ⑤ 形状不认识 → 400 且给出可诊断的原因；
//   ⑥ 导入不能绕过审核守卫（auditMode=all 时 approved 也进隔离区）。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApi, API_PREFIX } from '../lib/api.js'
import { closeAllDb, setAuditConfig } from '../lib/db.js'
import { listCards, writeCard } from '../lib/vault.js'

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-import-'))
after(async () => {
  closeAllDb()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})
let seq = 0
const newVault = () => path.join(tmpRoot, 'vault-' + (++seq))

// ---- 真实处理器驱动（假 req/res，够 json() 用） --------------------------------
function makeReq(payload) {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const iter = (async function* () { yield Buffer.from(raw, 'utf8') })()
  return Object.assign(iter, { url: `${API_PREFIX}/import`, method: 'POST', headers: { 'content-type': 'application/json' } })
}
function makeRes() {
  return {
    status: 0, body: null,
    writeHead(status) { this.status = status },
    end(buf) { this.body = JSON.parse(Buffer.from(buf).toString('utf8')) },
  }
}
async function call(root, route, payload, method = 'GET') {
  const handle = createApi({ vaultDir: () => root })
  const res = makeRes()
  const raw = payload === undefined ? '' : (typeof payload === 'string' ? payload : JSON.stringify(payload))
  const iter = (async function* () { if (raw) yield Buffer.from(raw, 'utf8') })()
  await handle(Object.assign(iter, { url: `${API_PREFIX}${route}`, method, headers: {} }), res)
  return { status: res.status, ...res.body }
}
const callImport = (root, payload) => call(root, '/import', payload, 'POST')

// ---- 造卡：正文高度重合（旧实现会在同一批里互相判重） -------------------------
const COMMON = '这一段是备份里三张卡共有的背景描述，用来让它们的字符 bigram 高度重合：'.repeat(3) +
  '插件把知识卡存进本地 SQLite 双库（主库只放 approved，隔离区放 pending、rejected、deleted），召回、检索、图谱、导出都读主库。'
const card = (title, tail, status = 'approved') => ({
  path: `03-Knowledge/${title}.md`,
  title,
  kind: 'knowledge',
  status,
  store: status === 'approved' ? 'main' : 'quarantine',
  text: `---\nformatVersion: 1\nkind: knowledge\ntitle: ${title}\ntags: [导入测试]\nstatus: ${status}\nsubmittedBy: test\n---\n\n# ${title}\n\n${COMMON}\n\n${tail}`,
})

test('① 裸数组备份（v0.10.0 之前的导出形状）能整批导入', async () => {
  const root = newVault()
  const bare = [card('裸数组-甲', '差异一：这一行只在甲里出现。'), card('裸数组-乙', '差异二：这一行只在乙里出现。'), card('裸数组-丙', '差异三：这一行只在丙里出现。')]
  const r = await callImport(root, bare)
  assert.equal(r.status, 200)
  assert.equal(r.ok, true)
  assert.equal(r.total, 3)
  assert.equal(r.imported, 3, '裸数组必须整批导入（旧实现这里是 0）')
  assert.equal(r.skipped, 0)
  assert.equal((await listCards(root)).length, 3)
})

test('② 信封对象（新导出形状）能整批导入，且同批近似卡不互相吞', async () => {
  const root = newVault()
  const envelope = {
    format: 'memory-eternal-vault',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    count: 3,
    cards: [card('信封-甲', '差异一：这一行只在甲里出现。'), card('信封-乙', '差异二：这一行只在乙里出现。'), card('信封-丙', '差异三：这一行只在丙里出现。')],
  }
  const r = await callImport(root, envelope)
  assert.equal(r.imported, 3, '同批近似卡去重基线必须是导入前快照，否则只能进来 1 张')
  assert.equal(r.skipped, 0)
  assert.equal((await listCards(root)).length, 3)
})

test('③ 导出 → 导入 全量往返（导出响应即备份文件）', async () => {
  const src = newVault()
  await writeCard(src, { kind: 'knowledge', title: '往返甲', tags: ['t'], body: '甲卡正文：讲的是导入导出链路里 JSON 形状必须两端一致，否则备份是死的。', status: 'approved' })
  await writeCard(src, { kind: 'knowledge', title: '往返乙', tags: ['t'], body: '乙卡正文：讲的是审核守卫在数据库层强制，任何写入路径都绕不过它。', status: 'approved' })
  await writeCard(src, { kind: 'project', title: '往返丙（待审）', tags: ['t'], body: '待审卡的正文，导入后应回到隔离区。', status: 'pending' })
  const ex = await call(src, '/export')
  assert.equal(ex.ok, true)
  assert.equal(ex.formatVersion, 1)
  assert.equal(ex.count, 3)

  const dst = newVault()
  // 模拟客户端落盘：把导出响应原样写成 memory-vault.json，再原样读回来导入
  const file = path.join(tmpRoot, 'memory-vault.json')
  await fs.writeFile(file, JSON.stringify(ex, null, 2), 'utf8')
  const r = await callImport(dst, await fs.readFile(file, 'utf8'))
  assert.equal(r.imported, 3)
  assert.equal(r.quarantined, 1, '待审卡应进隔离区并计数')
  assert.equal((await listCards(dst)).length, 2)
  assert.equal((await listCards(dst, { status: ['pending'] })).length, 1)
})

test('④ 同一份备份再导一次：如实报「已存在」，不是静默 0', async () => {
  const root = newVault()
  const bare = [card('重复-甲', '甲。'), card('重复-乙', '乙。')]
  assert.equal((await callImport(root, bare)).imported, 2)
  const again = await callImport(root, bare)
  assert.equal(again.imported, 0)
  assert.equal(again.skipped, 2)
  assert.equal(again.total, 2)
  assert.equal(again.failed.length, 2)
  assert.match(again.failed[0].reason, /已存在/)
  assert.equal((await listCards(root)).length, 2, '重复导入不得产生副本')
})

test('⑤ 形状无法识别 / 空文件 / 坏 JSON：都给得出原因', async () => {
  const root = newVault()
  const bad = await callImport(root, { hello: 'world' })
  assert.equal(bad.status, 400)
  assert.match(bad.error, /文件格式无法识别/)

  const empty = await callImport(root, [])
  assert.equal(empty.status, 200)
  assert.equal(empty.total, 0)
  assert.equal(empty.warning, '文件里没有任何卡片')

  const broken = await callImport(root, '{不是 JSON')
  assert.equal(broken.status, 400)
  assert.match(broken.error, /JSON 解析失败/)
})

test('⑥ 导入也要过审核守卫：auditMode=all 时 approved 卡进隔离区', async () => {
  const root = newVault()
  setAuditConfig(root, { auditMode: 'all', auditExemptAgents: [], auditExemptKinds: [] })
  const r = await callImport(root, [card('守卫-甲', '甲。', 'approved'), card('守卫-乙', '乙。', 'approved')])
  assert.equal(r.imported, 2)
  assert.equal(r.quarantined, 2, '审核规则不允许导入数据绕过')
  assert.equal((await listCards(root)).length, 0, '主库必须仍然为空')
  assert.equal((await listCards(root, { status: ['pending'] })).length, 2)
})
