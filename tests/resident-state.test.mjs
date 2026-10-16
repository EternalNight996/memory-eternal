// issue #30 第五轮复测（A: 盘稳态）：环境限制必须做成**长期状态**，而不是每次开机当"漂移"重试一遍。
//   记录 → 面板/align/version-check 显示成「不可替换（环境限制）」→ 环境修好后自动清除。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { residentStatePath, readResidentState, recordReplaceBlocked, clearReplaceBlocked, replaceBlockedInfo } from '../lib/resident-state.js'
import { alignFindings } from '../lib/align.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => readFileSync(path.join(root, f), 'utf8')

test('记录 / 读取 / 清除「不可替换」状态（与看门狗锁同目录）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-resstate-'))
  const env = { DSH_HOME: dir }
  try {
    assert.equal(replaceBlockedInfo(env), null, '初始没有状态')
    const first = recordReplaceBlocked(env, { error: 'EPERM: operation not permitted', lockPath: 'A:/x/memory-eternal-watchdog.json', port: 7999, version: '0.10.31', served: '0.10.29' })
    assert.equal(first.ok, true)
    assert.equal(first.firstTime, true, '第一次要标出来（首次用 warn 提醒，之后降级）')
    const info = replaceBlockedInfo(env)
    assert.equal(info.fresh, true)
    assert.match(info.error, /EPERM/)
    assert.equal(info.served, '0.10.29')
    assert.match(residentStatePath(env), /memory-eternal-state\.json$/)
    assert.equal(readResidentState(env).replaceBlocked.count, 1)
    // 再记一次：firstTime=false、count 累加（用于"已知状态"的降级）
    const second = recordReplaceBlocked(env, { error: 'EPERM' })
    assert.equal(second.firstTime, false)
    assert.equal(readResidentState(env).replaceBlocked.count, 2)
    // 环境修好 → 清除
    assert.equal(clearReplaceBlocked(env), true)
    assert.equal(replaceBlockedInfo(env), null)
    assert.equal(clearReplaceBlocked(env), false, '已清除时返回 false')
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('状态过期（>7 天）不再当"当前有效"，避免陈旧限制长期误导', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'me-resstate-old-'))
  const env = { DSH_HOME: dir }
  try {
    recordReplaceBlocked(env, { error: 'EPERM' })
    const data = JSON.parse(fs.readFileSync(residentStatePath(env), 'utf8'))
    data.replaceBlocked.at = Date.now() - 8 * 24 * 3600 * 1000
    fs.writeFileSync(residentStatePath(env), JSON.stringify(data), 'utf8')
    assert.equal(replaceBlockedInfo(env).fresh, false)
  } finally { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }) } catch {} }
})

test('align：不可替换要显示成「环境限制」（warn + 出路），而不是"暂时落后"', () => {
  const blocked = { fresh: true, error: 'EPERM: operation not permitted', lockPath: 'A:/AI/DSH数据/memory-eternal-watchdog.json', served: '0.10.29', version: '0.10.31' }
  const r = alignFindings({ hostVersion: '0.10.31', onDisk: '0.10.31', residentServed: '0.10.29', residentPort: 7999, replaceBlocked: blocked })
  const f = r.findings.find((x) => x.id === 'resident-replace-blocked')
  assert.ok(f, '要有专门的一条')
  assert.equal(f.level, 'warn', '环境限制不该算 fix（不是我们能改的）')
  assert.match(f.title, /不可替换/)
  assert.match(f.detail, /长期/)
  assert.match(f.command, /restart --port 7999/)
  // 过期的状态不再提示
  const old = alignFindings({ hostVersion: '0.10.31', onDisk: '0.10.31', replaceBlocked: { ...blocked, fresh: false } })
  assert.equal(old.findings.some((x) => x.id === 'resident-replace-blocked'), false)
})

test('接线守卫：宿主先探锁再决定、面板/接口都要能看到这个状态', () => {
  const index = read('index.js')
  assert.match(index, /m\.probeLockWritable\(\)/, '宿主在重启前要探锁可写性')
  assert.match(index, /recordReplaceBlocked\(process\.env/, '要记下不可替换状态')
  assert.match(index, /常驻实例不可替换（环境限制）/, '措辞要与"漂移"区分开')
  assert.match(index, /firstTime \? 'warn' : 'boot'/, '首次 warn、之后降级为已知状态（不再每次开机都当失败）')
  const api = read('lib/api.js')
  assert.match(api, /replaceBlocked,/, 'version-check 要带出该状态')
  const client = read('src/client/index.tsx')
  assert.match(client, /residentReplaceBlocked/, '面板要区分显示')
  assert.equal((client.match(/vcResidentReplaceBlocked:/g) || []).length, 2, '中英词条各一条')
})
