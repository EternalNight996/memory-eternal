// 配置同步回归：独立 Web 页保存 → 待应用文件 → DSH 端应用。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pendingConfigPath, readPendingConfig, writePendingConfig, clearPendingConfig, drainPendingConfig, writeFileAtomicSync } from '../lib/config-sync.js'

const homes = []
const tmpHome = async () => { const d = await fsp.mkdtemp(path.join(os.tmpdir(), 'me-cfgsync-')); homes.push(d); return d }
after(async () => { for (const h of homes) await fsp.rm(h, { recursive: true, force: true }) })

test('读写往返：patch 原样可读，且路径在 DSH_HOME 下', async () => {
  const home = await tmpHome()
  const env = { DSH_HOME: home }
  assert.ok(pendingConfigPath(env).startsWith(home), '待应用文件必须落在 DSH_HOME 内')
  assert.equal(readPendingConfig(env), null, '没有文件时应为 null')
  const w = writePendingConfig(env, { recycleRetentionDays: 10 })
  assert.ok(w.at > 0)
  const r = readPendingConfig(env)
  assert.deepEqual(r.patch, { recycleRetentionDays: 10 })
})

test('损坏/非法内容不得抛错（返回 null）', async () => {
  const home = await tmpHome()
  const env = { DSH_HOME: home }
  fs.writeFileSync(pendingConfigPath(env), '{ not json', 'utf8')
  assert.equal(readPendingConfig(env), null)
  fs.writeFileSync(pendingConfigPath(env), JSON.stringify({ at: 1, patch: [1, 2] }), 'utf8')
  assert.equal(readPendingConfig(env), null, '数组 patch 非法')
  fs.writeFileSync(pendingConfigPath(env), JSON.stringify({ at: 1, patch: null }), 'utf8')
  assert.equal(readPendingConfig(env), null)
})

test('drain：应用成功后文件被删除；应用失败则保留待重试', async () => {
  const home = await tmpHome()
  const env = { DSH_HOME: home }
  writePendingConfig(env, { enabled: false })
  const applied = []
  const out = await drainPendingConfig(env, async (patch) => { applied.push(patch) })
  assert.deepEqual(out, { enabled: false })
  assert.equal(applied.length, 1)
  assert.equal(readPendingConfig(env), null, '成功后必须删除')
  assert.equal(await drainPendingConfig(env, async () => {}), null, '没有待应用项时返回 null')
  writePendingConfig(env, { enabled: true })
  await assert.rejects(() => drainPendingConfig(env, async () => { throw new Error('revision conflict') }), /conflict/)
  assert.ok(readPendingConfig(env), '失败必须保留文件，等下一轮重试')
})

test('writeFileAtomicSync：另一个进程并发读时永远拿到完整 JSON（非原子写会读到半截）', async () => {
  const home = await tmpHome()
  const target = path.join(home, 'shared-config.json')
  // 载荷要够大：非原子写（先截断再写入）才有可观测的窗口
  const payload = (i) => JSON.stringify({ i, pad: 'x'.repeat(200000), items: Array.from({ length: 200 }, (_, k) => k) })
  writeFileAtomicSync(target, payload(0))
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).items.length, 200, '首次写入必须完整可读')
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.endsWith('.tmp')), [], '不得留下 .tmp 残file')

  // 独立进程死循环读取：它看到的每一次读都必须能 JSON.parse（原子 rename 的契约）。
  // 对照实验（同一台机器、同样的写循环）里，非原子的 writeFileSync 会出现读不到完整内容的情况。
  const reader = spawn(process.execPath, ['-e', [
    "const fs = require('fs')",
    'const target = process.argv[1]',
    'const deadline = Date.now() + 1200',
    'let reads = 0, bad = 0',
    'while (Date.now() < deadline) {',
    '  let raw',
    '  try { raw = fs.readFileSync(target, "utf8") } catch { continue }',
    '  reads++',
    '  try { JSON.parse(raw) } catch { bad++ }',
    '}',
    'process.stdout.write(JSON.stringify({ reads, bad }))',
  ].join('\n'), target], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })

  let out = ''
  reader.stdout.on('data', (d) => { out += d })
  const done = new Promise((resolve) => reader.on('close', resolve))
  const deadline = Date.now() + 1000
  let i = 1
  while (Date.now() < deadline) { writeFileAtomicSync(target, payload(i++)); await new Promise((r) => setTimeout(r, 1)) }
  await done
  const stats = JSON.parse(out || '{}')
  assert.ok(stats.reads > 0, '读进程应至少完成一次读（否则测试无意义）')
  assert.equal(stats.bad, 0, `并发读到了 ${stats.bad} 次不完整内容（原子写失效）`)
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.endsWith('.tmp')), [], '写循环结束后不得留下 .tmp')
})

test('clear：不存在也算成功', async () => {
  const home = await tmpHome()
  assert.equal(clearPendingConfig({ DSH_HOME: home }), false)
})

test('drain：连续失败到上限后放弃，但**保留文件**并标注 dropped + lastError（#16）', async () => {
  const home = await tmpHome()
  const env = { DSH_HOME: home }
  writePendingConfig(env, { recycleRetentionDays: 0 })
  const fail = async () => { throw new Error('值不合法') }
  await assert.rejects(() => drainPendingConfig(env, fail, 2), /值不合法/)
  const afterFirst = readPendingConfig(env)
  assert.ok(afterFirst, '第 1 次失败应保留（下一轮重试）')
  assert.equal(afterFirst.tries, 1)
  assert.equal(afterFirst.lastError, '值不合法', '失败原因要落进文件（否则没人看得到）')
  await assert.rejects(() => drainPendingConfig(env, fail, 2), /已放弃/)
  const dropped = readPendingConfig(env)
  assert.ok(dropped, '达到上限**不得静默删除**用户的改动，文件要留作证据')
  assert.equal(dropped.dropped, true)
  assert.equal(dropped.lastError, '值不合法')
  assert.deepEqual(dropped.patch, { recycleRetentionDays: 0 }, '改动本身必须还在')
  // 已放弃的文件不再无限重试（否则每 5 秒烧一次），但仍可见
  assert.equal(await drainPendingConfig(env, async () => { throw new Error('不该被调用') }, 2), null)
  // 用户重新保存 → 清除 dropped，重新开始重试
  writePendingConfig(env, { recycleRetentionDays: 7 })
  const again = readPendingConfig(env)
  assert.equal(again.dropped, false)
  assert.equal(again.tries, 0)
  const applied = []
  assert.deepEqual(await drainPendingConfig(env, async (p) => { applied.push(p) }), { recycleRetentionDays: 7 })
  assert.equal(readPendingConfig(env), null)
  assert.deepEqual(applied, [{ recycleRetentionDays: 7 }])
})

test('drain：抛出的 dropped 错误要能自证（dropped 标记 + 保留路径）', async () => {
  const home = await tmpHome()
  const env = { DSH_HOME: home }
  writePendingConfig(env, { enabled: true })
  const fail = async () => { throw new Error('Configuration for "memory-eternal" is overridden by a home patch') }
  await assert.rejects(() => drainPendingConfig(env, fail, 1), (error) => {
    assert.equal(error.dropped, true)
    assert.match(error.message, /overridden by a home patch/, '原始报错必须被带出来')
    assert.ok(error.message.includes(pendingConfigPath(env)), '要告诉用户改动还在哪个文件里')
    return true
  })
})
