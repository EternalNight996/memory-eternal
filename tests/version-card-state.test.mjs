// 版本卡判定的**表驱动**穷举：0.10.45 的事故就是「第三种状态」没被想到。
// 这里把 常驻(旧/新/挂/未托管/锁未知) × 宿主(旧/新) 的组合钉死，并守住不变式「按钮永远显示」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { versionCardState } from '../src/client/version-state.js'

const DISK = '0.10.47'
const base = { hasVersion: true, hostVersion: DISK, onDisk: DISK, residentServed: DISK, residentPresent: true, residentManaged: true }

test('全部对齐：有按钮、不高亮、无警告、提示「通常无需重启」', () => {
  const s = versionCardState(base)
  assert.equal(s.showButton, true)
  assert.equal(s.emphasis, false)
  assert.equal(s.warn, null)
  assert.equal(s.hint, 'restartAnyway')
})

test('常驻实例落后：高亮按钮 + restartFixes，无警告优先于宿主', () => {
  const s = versionCardState({ ...base, residentServed: '0.10.39' })
  assert.equal(s.emphasis, true)
  assert.equal(s.hint, 'restartFixes')
  assert.equal(s.warn, null, '只是常驻落后时不再弹警告块（旧行为保持不变）')
})

test('常驻实例没在跑：警告 residentDown + 提示 restartStart（不拼空的「当前 v」）', () => {
  const s = versionCardState({ ...base, residentServed: '' })
  assert.equal(s.warn, 'residentDown')
  assert.equal(s.hint, 'restartStart')
  assert.equal(s.emphasis, true)
})

test('★ 用户这台的状态：常驻新 + 宿主旧 → 仍有按钮，但说明「重启常驻不影响本页」', () => {
  const s = versionCardState({ ...base, hostVersion: '0.10.39' })
  assert.equal(s.showButton, true, '按钮绝不能消失（这正是 0.10.45 的事故）')
  assert.equal(s.emphasis, false, '常驻不旧 → 不高亮')
  assert.equal(s.warn, 'hostProcessStale')
  assert.equal(s.hint, 'restartHostOnly')
})

test('★ 常驻旧 + 宿主旧：宿主警告优先（本页看不到新代码的原因更直接），按钮高亮', () => {
  const s = versionCardState({ ...base, hostVersion: '0.10.39', residentServed: '0.10.30' })
  assert.equal(s.warn, 'hostProcessStale')
  assert.equal(s.emphasis, true)
  assert.equal(s.hint, 'restartFixes', '常驻确实旧 → 提示仍然说「点了会换新版」')
})

test('常驻没在跑 + 宿主旧：先说宿主旧，按钮高亮，提示 restartStart', () => {
  const s = versionCardState({ ...base, hostVersion: '0.10.39', residentServed: '' })
  assert.equal(s.warn, 'hostProcessStale')
  assert.equal(s.emphasis, true)
  assert.equal(s.hint, 'restartStart')
})

test('未托管（在跑但没人保活）→ 警告 residentUnmanaged', () => {
  const s = versionCardState({ ...base, residentServed: '0.10.30', residentManaged: false, residentManagedKnown: true })
  assert.equal(s.warn, 'residentUnmanaged')
  assert.equal(s.emphasis, true)
})

test('托管状态未知（锁不可读）→ 警告 residentLockUnknown（不能误报成未托管）', () => {
  const s = versionCardState({ ...base, residentManaged: false, residentManagedKnown: false })
  assert.equal(s.warn, 'residentLockUnknown')
  assert.equal(s.residentUnmanaged, false)
})

test('宿主托管（managedBy=host）不算未托管，也不该出现未托管警告', () => {
  const s = versionCardState({ ...base, residentManaged: false, residentManagedKnown: true, residentManagedBy: 'host' })
  assert.equal(s.residentUnmanaged, false)
  assert.equal(s.warn, null)
})

test('不可替换（环境限制）优先于未托管，并压过宿主旧？——不：宿主旧仍最优先', () => {
  const blocked = { fresh: true, error: 'EPERM' }
  const a = versionCardState({ ...base, residentManaged: false, residentManagedKnown: true, replaceBlocked: blocked })
  assert.equal(a.warn, 'residentReplaceBlocked')
  const b = versionCardState({ ...base, hostVersion: '0.10.39', replaceBlocked: blocked })
  assert.equal(b.warn, 'hostProcessStale', '宿主旧优先')
  const stale = versionCardState({ ...base, replaceBlocked: { fresh: false } })
  assert.equal(stale.warn, null, '过期的 blocked 状态不再提示')
})

test('不变式：只要拿得到版本信息，任何组合都 showButton', () => {
  const hosts = [DISK, '0.10.39', '']
  const served = [DISK, '0.10.30', '']
  const managed = [true, false, null]
  const known = [true, false, null]
  const by = ['', 'host', 'watchdog']
  const blocked = [null, { fresh: true }, { fresh: false }]
  let combos = 0
  for (const hostVersion of hosts) for (const residentServed of served) for (const residentManaged of managed)
    for (const residentManagedKnown of known) for (const residentManagedBy of by) for (const replaceBlocked of blocked) {
      combos++
      const s = versionCardState({ hasVersion: true, onDisk: DISK, hostVersion, residentServed, residentPresent: true, residentManaged, residentManagedKnown, residentManagedBy, replaceBlocked })
      assert.equal(s.showButton, true, 'combos=' + combos)
      assert.ok(['hostProcessStale', 'residentDown', 'residentReplaceBlocked', 'residentLockUnknown', 'residentUnmanaged', null].includes(s.warn), 'warn 必须是已知 key：' + s.warn)
      assert.ok(['restartStart', 'restartFixes', 'restartHostOnly', 'restartAnyway'].includes(s.hint), 'hint 必须是已知 key：' + s.hint)
    }
  assert.ok(combos >= 12 * 27, '组合数应 ≥ 324（实际 ' + combos + '）')
})

test('没有版本信息时不显示按钮（面板还没拿到 vc）', () => {
  assert.equal(versionCardState({ hasVersion: false }).showButton, false)
})
