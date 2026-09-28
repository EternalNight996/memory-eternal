// 渲染冒烟测试（防白屏回归）：真跑一遍打包后的 client bundle，把记忆页各入口渲染出来。
//
// 为什么必须有它：0.9.1 曾把「滚动续拉」的 useEffect 写在 loadCards 定义之前，
// 依赖数组在渲染期求值 → TDZ 抛错 → **整个记忆页白屏**；而单元测试、类型检查、
// 构建全都是绿的（没有人跑过渲染）。这类 bug 只有真渲染能抓到。
//
// 依赖打包产物 lib/client.js：npm test 会先跑 node build.mjs 再跑它。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const require = createRequire(path.join(pkgRoot, 'package.json'))

const React = require('react')
const { renderToString } = require('react-dom/server')

// 浏览器环境最小替身（bundle 是浏览器 IIFE，靠 window.__ModuleLoader__ 注册）
let factory = null
globalThis.window = {
  __ModuleLoader__: { load: (def) => { factory = def.factory } },
  addEventListener() {}, removeEventListener() {},
  localStorage: { getItem: () => null, setItem() {} },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
}
globalThis.document = {
  documentElement: { getAttribute: () => 'light', setAttribute() {} },
  addEventListener() {}, removeEventListener() {},
  createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} }),
}
globalThis.location = { search: '' }
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, cards: [], total: 0, entries: [], hits: [], nodes: [], edges: [] }) })

require(path.join(pkgRoot, 'lib', 'client.js'))
assert.ok(factory, 'lib/client.js 应通过 window.__ModuleLoader__.load 注册 factory；先跑 node build.mjs')

const mod = factory((id) => {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') return require('react/jsx-runtime')
  return new Proxy({}, { get: () => () => null })
})
assert.ok(mod.MemoryLibrary, 'bundle 应导出 MemoryLibrary')

const translate = (key) => String(key)
const render = (search) => {
  globalThis.location = { search }
  return renderToString(React.createElement(mod.MemoryLibrary, { t: translate, inModal: false, onClose() {}, onFull() {}, full: false }))
}

test('记忆页渲染冒烟：四个入口（卡片/设置/用量/图谱）都不得抛错（TDZ 白屏回归）', () => {
  const cases = [
    ['cards', '', 'mc-rail'],
    ['config', '?tab=config', 'mc-rail'],
    ['usage', '?tab=usage', 'captureLog'],
    ['graph', '?tab=graph', 'mc-rail'],
  ]
  for (const [name, search, marker] of cases) {
    let html = ''
    assert.doesNotThrow(() => { html = render(search) }, `入口 ${name} 渲染抛错`)
    assert.ok(html.length > 1000, `入口 ${name} 渲染内容过少（${html.length}）`)
    assert.ok(html.includes(marker), `入口 ${name} 应包含 ${marker}`)
  }
})

test('记忆页渲染冒烟：卡片视图渲染出「空库」占位而不是崩溃', () => {
  const html = render('')
  assert.ok(html.includes('mc-empty') || html.includes('mc-grid'), '卡片视图应有卡片网格或空态占位')
})

// 官方桌面版回归：桌面壳把「最小化 / 最大化 / 关闭」画在页面顶部，并按 DSH 的约定在
// <html> 上打 data-windows-titlebar + --dsh-windows-titlebar-height。全屏浮层若不让开，
// 我们右上角的「×」会压在窗口「关闭」上 —— 点下去直接退出整个桌面壳（用户实测反馈）。
test('官方桌面版：全屏浮层必须让开窗口标题栏', () => {
  const html = render('')
  assert.ok(html.includes('[data-windows-titlebar]'), '缺少 [data-windows-titlebar] 让位规则：会盖住桌面壳的窗口控制按钮')
  assert.ok(html.includes('--dsh-windows-titlebar-height'), '应使用 DSH 约定的窗口标题栏高度变量')
  assert.ok(html.includes('.me-modal-full'), '全屏态必须走 me-modal-full 类：内联 100vh 无法被 CSS 覆盖')
  assert.ok(!html.includes("'100vh', borderRadiu"), '全屏不应再写死内联 100vh')
})
// issue #2 回归：槽位宿主可能被别的插件改成 flex-direction:column。
// 纵向容器里 flex-wrap 的语义是「换列」、flex-basis:100% 指的是「高度 100%」，
// 两者叠加会把「记忆」入口挤进右侧溢出列，裁切到只剩右边缘一条缝。
test('sidebar footer：纵向 flex 宿主下不得使用 wrap / basis:100%', () => {
  const html = render('')
  assert.ok(html.includes('.me-footer { width: 100%; flex: 0 0 auto'), '.me-footer 必须用方向无关的 flex: 0 0 auto')
  assert.ok(!html.includes('flex: 1 1 100%'), 'flex:1 1 100% 在纵向宿主里会变成高度 100% → 按钮被裁切')
  // 注意：React 渲染 <style> 子节点时会转义双引号，断言里不要带 " 
  assert.ok(!html.includes('> .me-footer) { flex-wrap'), '通用 :has(> .me-footer) 宿主不得带 flex-wrap（纵向容器里=换列）')
  assert.ok(html.includes(':has(.me-footer) { flex-wrap: wrap; }'), '横向 .footerActions 行容器仍需 wrap 才能独占一行')
})

