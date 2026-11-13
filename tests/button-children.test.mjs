// 按钮子节点守卫：**Btn 不许把 children 当字符串拼**。
//
// 旧实现 `(icon ? icon + ' ' : '') + children` 在多段文案时走 Array#toString：
//   <Btn>🛟 {label}</Btn>            → 文本 "🛟 ,备份与迁移"（凭空多一个逗号）
//   <Btn>{a}（{n}）</Btn>            → "待审核,（,4,）"
//   <Btn>● {label}</Btn>             → "●, 自动备份"
//   内嵌 <span> 则直接变成 "[object Object]"（计数徽标就是这么消失的）。
// 用户连报三次的「所有按钮都不要增加，这种字符串」根因就在这里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import React from 'react'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const require = createRequire(path.join(pkgRoot, 'package.json'))
const { renderToStaticMarkup } = require('react-dom/server')
const { Btn } = await import(pathToFileURL(path.join(pkgRoot, 'src/client/ui/components.js')).href)

test('Btn 保留子节点：多段文案不会被 join(",") 拼成逗号串', () => {
  const html = renderToStaticMarkup(React.createElement(Btn, null, '待审核', React.createElement('span', { className: 'me-count' }, 4)))
  assert.ok(!html.includes(','), '不许出现 Array#toString 拼出来的逗号：' + html)
  assert.ok(!html.includes('[object Object]'), '子节点不能被字符串化：' + html)
  assert.match(html, /待审核<span class="me-count">4<\/span>/)
})

test('Btn 的图标 + 文案不会被拼成「图标 ，文案」', () => {
  const html = renderToStaticMarkup(React.createElement(Btn, { icon: '🛟' }, '备份与迁移'))
  assert.ok(!/,/.test(html), '图标与文案之间不许出现逗号：' + html)
  assert.ok(html.includes('🛟') && html.includes('备份与迁移'), html)
})

test('Btn 的单段字符串文案原样保留（空格不被吞）', () => {
  const html = renderToStaticMarkup(React.createElement(Btn, null, '✓ ' + '批准'))
  assert.ok(html.includes('✓ 批准'), html)
})
