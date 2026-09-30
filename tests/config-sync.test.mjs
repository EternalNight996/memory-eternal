// 配置同步回归：独立 Web 页保存 → 待应用文件 → DSH 端应用。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pendingConfigPath, readPendingConfig, writePendingConfig, clearPendingConfig, drainPendingConfig } from '../lib/config-sync.js'

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

test('clear：不存在也算成功', async () => {
  const home = await tmpHome()
  assert.equal(clearPendingConfig({ DSH_HOME: home }), false)
})
