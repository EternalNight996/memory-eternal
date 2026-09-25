// settings-compat 的两代接口自测：用一个假的 ctx 分别模拟 0.1.6 与 0.1.7 宿主。
// 用法：node tests/settings-compat.test.mjs

import assert from 'node:assert/strict'
import { createSettingsHandle } from '../lib/settings-compat.js'

// 模拟 schemastery：调用时补默认值（真实 Config(raw) 同样是「返回解析后的对象」）
const Schema = (raw = {}) => ({ captureMinChars: 200, autoCapture: true, ...raw })

let failed = 0
const check = async (name, fn) => {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${name}: ${error?.message || error}`)
  }
}

console.log('场景 A：dsh ≤0.1.6（settings.register 存在 → 原生路径）')
{
  const calls = []
  const native = { get: () => ({ autoCapture: true }), watch: () => () => {}, update: async () => {} }
  const ctx = { settings: { register: (ns, schema, opts) => { calls.push({ ns, opts }); return native } } }

  await check('原样返回 register 的句柄，不改行为', () => {
    const handle = createSettingsHandle(ctx, 'memory-eternal', Schema, { autoCapture: false })
    assert.equal(handle, native)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].ns, 'memory-eternal')
    assert.deepEqual(calls[0].opts, { base: { autoCapture: false } })
  })
}

console.log('场景 B：dsh ≥0.1.7（无 register → configEditor 路径）')
{
  const edits = []
  const entry = { options: { id: 'memory-eternal', config: { autoCapture: false } } }
  const makeCtx = (withEditor = true) => ({
    settings: { describe: () => [] },          // 只有 0.1.7 的方法集
    fiber: { entry },
    get: (name) => (withEditor && name === 'configEditor'
      ? { edit: async (e, change) => { edits.push(change(e.options.config ?? {}, {})) } }
      : undefined),
  })

  const handle = createSettingsHandle(makeCtx(), 'memory-eternal', Schema, { autoCapture: false })

  await check('get() 返回经 schema 补过默认值的配置', () => {
    const cfg = handle.get()
    assert.equal(cfg.captureMinChars, 200)   // 默认值被补上
    assert.equal(cfg.autoCapture, false)     // 显式值优先
  })

  await check('watch() 返回可调用 disposer，且不会回调（0.1.7 无 per-registration watcher）', () => {
    let called = false
    const dispose = handle.watch(() => { called = true })
    assert.equal(typeof dispose, 'function')
    dispose()
    assert.equal(called, false)
  })

  await check('update() 经 configEditor.edit 合并写入，并刷新本地快照', async () => {
    await handle.update({ captureMinChars: 999 })
    assert.equal(edits.length, 1)
    assert.equal(edits[0].captureMinChars, 999)
    assert.equal(edits[0].autoCapture, false)     // 未提供的键保持原值
    assert.equal(handle.get().captureMinChars, 999)
  })

  await check('没有 configEditor 时 update() 明确报错（不静默失败）', async () => {
    const bare = createSettingsHandle(makeCtx(false), 'memory-eternal', Schema, {})
    await assert.rejects(() => bare.update({ autoCapture: true }), /configEditor/)
  })
}

console.log(failed === 0 ? '\n全部通过 ✔' : `\n有 ${failed} 项失败 ✘`)
process.exitCode = failed === 0 ? 0 : 1
