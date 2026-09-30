// 保存后不再闪烁：本地叠加层合并逻辑（issue：保存后先退回旧值再跳回新值）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeLocalOverlay, sameValue } from '../src/client/config-merge.js'

test('宿主尚未回流时：本地值必须胜出（不闪烁）', () => {
  const host = { recycleRetentionDays: 30, recallLimit: 5 }
  const overlay = { recycleRetentionDays: 10 }
  const { values, overlay: rest } = mergeLocalOverlay(host, overlay)
  assert.equal(values.recycleRetentionDays, 10, '保存过的字段必须保持新值')
  assert.equal(values.recallLimit, 5, '未改动的字段跟随宿主')
  assert.deepEqual(rest, { recycleRetentionDays: 10 }, '未回流 → 叠加层保留')
})

test('宿主回显一致后：叠加层自动摘除（回到宿主权威值）', () => {
  const host = { recycleRetentionDays: 10 }
  const { values, overlay: rest } = mergeLocalOverlay(host, { recycleRetentionDays: 10 })
  assert.equal(values.recycleRetentionDays, 10)
  assert.deepEqual(rest, {}, '一致即摘除，之后跟随宿主变化')
  const later = mergeLocalOverlay({ recycleRetentionDays: 99 }, rest)
  assert.equal(later.values.recycleRetentionDays, 99, '摘除后宿主改值应立刻反映')
})

test('数组/对象按键值比较（vaultProfiles 这类）', () => {
  const host = { vaultProfiles: [{ name: 'a', path: 'p' }] }
  const same = mergeLocalOverlay(host, { vaultProfiles: [{ name: 'a', path: 'p' }] })
  assert.deepEqual(same.overlay, {}, '内容相同即视为已回流')
  const diff = mergeLocalOverlay(host, { vaultProfiles: [{ name: 'b', path: 'q' }] })
  assert.equal(diff.values.vaultProfiles[0].name, 'b')
  assert.deepEqual(diff.overlay.vaultProfiles, [{ name: 'b', path: 'q' }])
})

test('空叠加层：原样返回宿主快照（不引入额外键）', () => {
  const host = { a: 1 }
  const { values, overlay } = mergeLocalOverlay(host, {})
  assert.deepEqual(values, { a: 1 })
  assert.deepEqual(overlay, {})
  assert.equal(sameValue(1, '1'), false)
  assert.equal(sameValue([1, 2], [1, 2]), true)
})
