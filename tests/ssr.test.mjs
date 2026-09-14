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
