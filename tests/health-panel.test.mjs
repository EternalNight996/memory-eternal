// 健康面板（可靠性线）：/overview 的备份摘要 + 面板接线 + 验收工具的两道新闸。
// 真实事故回忆：健康卡里误用了 ConfigPanel 作用域的 tf() → 整页白屏，
// 而「白屏没有横向溢出」让 panel-check 通过了 —— 所以这里也守卫工具本身。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApi } from '../lib/api.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
const fakeRes = () => { const rec = { status: 0, body: '' }; return { rec, res: { writeHead(s) { rec.status = s }, end(b) { rec.body = b ? String(b) : '' }, setHeader() {}, on() {}, once() {}, emit() {} } } }
const bodyOf = (rec) => { try { return JSON.parse(rec.body) } catch { return null } }

test('/overview 返回备份摘要（panel 的健康卡要看「最近一次多久前」）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-health-'))
  try {
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true })
    for (const n of ['memory-eternal-2026-10-18_0306.db', 'memory-eternal-2026-10-19_0306.db']) fs.writeFileSync(path.join(dir, 'backups', n), 'x')
    const api = createApi({ vaultDir: () => dir, getSettings: () => ({}), currentPkgVersion: () => '0.10.53' })
    const { rec, res } = fakeRes()
    await api({ method: 'GET', url: '/memory-eternal/api/overview' }, res)
    const d = bodyOf(rec)
    assert.equal(d.ok, true)
    assert.equal(d.backups.count, 2, '备份数量')
    assert.ok(d.backups.newestAt > 0, '最近备份时间')
    assert.deepEqual(d.backups.files, ['memory-eternal-2026-10-18_0306.db', 'memory-eternal-2026-10-19_0306.db'])
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('没有 backups 目录时不报错，返回 count=0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-health2-'))
  try {
    const api = createApi({ vaultDir: () => dir, getSettings: () => ({}), currentPkgVersion: () => '0.10.53' })
    const { rec, res } = fakeRes()
    await api({ method: 'GET', url: '/memory-eternal/api/overview' }, res)
    const d = bodyOf(rec)
    assert.equal(d.ok, true)
    assert.equal(d.backups.count, 0)
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('面板接线：健康卡只用 t()/tf() 里**该作用域存在的**那个（白屏事故）', () => {
  const client = read('src/client/index.tsx')
  assert.match(client, /healthTitle:/, '要有词条')
  assert.equal((client.match(/healthTitle:/g) || []).length, 2, '中英各一条')
  // LibraryAdmin 里没有 tf()（那是 ConfigPanel 的局部 helper）——健康卡必须用 t()
  const start = client.indexOf("healthTitle: '")
  const admin = client.slice(client.indexOf('function LibraryAdmin'), client.indexOf('// -- Enhanced knowledge graph'))
  assert.doesNotMatch(admin, /tf\('health/, 'LibraryAdmin 里不许用 tf(health…)（会 ReferenceError 白屏）')
  assert.match(admin, /t\('healthBackupAge'\)\.replace\('\{n\}'/, '占位符要手动替换')
})

test('验收工具必须有「白屏 / JS 异常」两道闸（否则空白页会通过溢出检查）', () => {
  const pc = read('scripts/panel-check.mjs')
  assert.match(pc, /PAGE_ALIVE_PROBE/, '要探测页面是否还活着')
  assert.match(pc, /textLen < 20/, '空白页判失败')
  assert.match(pc, /Runtime\.exceptionThrown/, '要捕获页面异常')
  assert.match(pc, /pageErrors/, '异常要进汇总并影响退出码')
})
