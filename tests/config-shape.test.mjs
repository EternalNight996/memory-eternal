// 配置层守卫：DSH 0.2.2 会把标了 volatile 的字段当成「可写引用」回传，插件收到的是空对象 {}，
// 于是每个布尔字段都触发 `ValidationError: $.enabled expected boolean but got [object Object]`，
// 整条插件被拒绝激活（图标消失 / 面板白屏）。真实故障复现过一轮，代价很大，这里锁死。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync('index.js', 'utf8')

test('不得对 Config 调用 markAllVolatile（DSH 0.2.2 下会把每个字段变成 {}）', () => {
  const code = src.split(/\r?\n/).filter((l) => !l.trim().startsWith('//'))
  const called = code.some((l) => /^\s*markAllVolatile\(Config\)\s*;?\s*$/.test(l))
  assert.equal(called, false, 'markAllVolatile(Config) 会让配置字段变成 {}，插件校验失败；需要热更新请换方案')
})

test('Config 对空对象字段报「expected boolean」（保留真实的类型校验）', async () => {
  const m = await import('file:///' + process.cwd().replace(/\\/g, '/') + '/index.js')
  assert.throws(() => m.Config({ enabled: {} }), /expected boolean/, 'Config 必须拒绝 {enabled:{}} 这种形状')
})

test('Config 接受真实标量并补默认值', async () => {
  const m = await import('file:///' + process.cwd().replace(/\\/g, '/') + '/index.js')
  const out = m.Config({ enabled: true, autoCapture: false })
  assert.equal(out.enabled, true)
  assert.equal(out.autoCapture, false)
  assert.equal(out.coreMemoryLimit, 6)
})
