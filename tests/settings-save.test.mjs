// issue #12 回归：配置保存。
// 宿主 dsh-settings.write() 有三道门槛：条目可配置 / revision 与 describe 完全一致 / 只写 volatile 字段；
// 且 volatile 回流可能滞后。这里用假 settings 服务把三种失败形态都钉死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, bindSettings } from '../index.js'

const makeCtx = (service) => {
  const handlers = new Map()
  return {
    get: (n) => (n === 'settings' ? service : undefined),
    on: (ev, fn) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn) },
    off: () => {},
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    fiber: { entry: { options: { id: 'memory-eternal' } } },
  }
}
const baseService = (over = {}) => ({
  describe: () => [{ ns: 'memory-eternal', revision: 7, applies: 'live' }],
  configure: () => () => {},
  async update() {},
  ...over,
})

test('保存：面板 revision 过期时必须自动用最新 revision 重试（issue #12）', async () => {
  const seen = []
  const ctx = makeCtx(baseService({
    async update(ns, patch, rev) {
      seen.push(rev)
      if (rev !== 7) throw new Error('settings namespace "memory-eternal" changed since it was read (expected revision 3, now 7)')
    },
  }))
  const settings = bindSettings(ctx, Config, { recycleRetentionDays: 30 })
  const out = await settings.update({ recycleRetentionDays: 10 }, 3)
  assert.deepEqual(seen, [3, 7], '先按面板 revision 试一次，冲突后必须取最新 revision 重试')
  assert.equal(out.retried, true)
  assert.equal(settings.get().recycleRetentionDays, 10)
})

test('保存：宿主不回流 volatile 时，本地视图也必须立刻是新值', async () => {
  const live = { recycleRetentionDays: 30 }
  const ctx = makeCtx(baseService({ update: async () => {} })) // 只写配置文件、不改活引用
  const settings = bindSettings(ctx, Config, live)
  await settings.update({ recycleRetentionDays: 10 }, 7)
  assert.equal(settings.get().recycleRetentionDays, 10, '叠加层必须让 get() 立刻反映新值')
})

test('保存：宿主回流后叠加层自动摘除（不掩盖宿主真实状态）', async () => {
  const live = { recycleRetentionDays: 30 }
  const ctx = makeCtx(baseService({ update: async () => {} }))
  const settings = bindSettings(ctx, Config, live)
  await settings.update({ recycleRetentionDays: 10 }, 7)
  live.recycleRetentionDays = 10 // 宿主稍后回流
  assert.equal(settings.get().recycleRetentionDays, 10)
  live.recycleRetentionDays = 99 // 宿主权威值再次变化
  assert.equal(settings.get().recycleRetentionDays, 99, '摘除后必须跟随宿主')
})

test('保存：非冲突错误原样抛出（不得吞掉）', async () => {
  const ctx = makeCtx(baseService({ update: async () => { throw new Error('EACCES: permission denied') } }))
  const settings = bindSettings(ctx, Config, {})
  await assert.rejects(() => settings.update({ recycleRetentionDays: 10 }, 7), /EACCES/)
})

test('保存：宿主不支持写配置时给出明确错误', async () => {
  const ctx = makeCtx({ describe: () => [], configure: () => () => {} })
  const settings = bindSettings(ctx, Config, {})
  await assert.rejects(() => settings.update({ enabled: false }, 0), /不支持写配置/)
})
