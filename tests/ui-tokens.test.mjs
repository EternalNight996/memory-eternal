// 设计令牌与组件层：守「口径」而不是守像素
//   ① 令牌值域固定（间距/字号/圆角只允许这几档），space() 越界要夹取；
//   ② CSS 变量与令牌一一对应（改令牌忘了同步 CSS 是经典事故）；
//   ③ Btn / Status / EmptyState / ErrorBar / StepFlow 的语义类名正确。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SPACE, FONT, LINE, RADIUS, MOTION, COLOR, space, TOKENS_CSS, COMPONENTS_CSS } from '../src/client/ui/design-tokens.js'
import { Btn, Status, EmptyState, ErrorBar, StepFlow, Section, Hint, Skeleton } from '../src/client/ui/components.js'

const html = (el) => renderToStaticMarkup(el)

test('间距/字号/圆角只允许固定档位，space() 越界夹取', () => {
  assert.deepEqual(SPACE, [0, 2, 4, 6, 8, 12, 16, 24, 32])
  assert.deepEqual(Object.values(FONT), [10, 11, 12, 13, 14, 16, 20])
  assert.deepEqual(Object.values(RADIUS), [6, 10, 14, 999])
  assert.equal(space(0), 0)
  assert.equal(space(5), 12)
  assert.equal(space(999), 32, '越界要夹到最大档，而不是返回 undefined')
  assert.equal(space(-1), 0)
  assert.equal(space('x'), 0, '非法输入回到 0 档')
})

test('CSS 变量与令牌逐项对应（漏一个就会有人写死色值）', () => {
  assert.match(TOKENS_CSS, /--me-sp-4:8px/)
  assert.match(TOKENS_CSS, /--me-fs-md:13px/)
  assert.match(TOKENS_CSS, /--me-r-md:10px/)
  for (const key of ['text', 'textDim', 'panel', 'border', 'accent', 'success', 'warn', 'danger', 'info', 'mark']) {
    assert.ok(COLOR[key], '缺少语义色 ' + key)
  }
  assert.match(TOKENS_CSS, /--me-c-accent:/)
  assert.match(TOKENS_CSS, /--me-c-danger:/)
  assert.ok(MOTION.ease.startsWith('cubic-bezier'), '缓动曲线应当是 cubic-bezier')
  assert.equal(LINE.normal, 1.55)
})

test('Btn：变体类名与 loading 禁用', () => {
  assert.match(html(React.createElement(Btn, { variant: 'primary' }, '启用')), /me-btn--primary/)
  assert.match(html(React.createElement(Btn, { variant: 'ghost' }, '更多')), /me-btn--ghost/)
  assert.match(html(React.createElement(Btn, { variant: 'danger' }, '删除')), /me-btn--danger/)
  assert.match(html(React.createElement(Btn, { size: 'sm' }, '刷新')), /me-btn--sm/)
  const loading = html(React.createElement(Btn, { variant: 'primary', loading: true }, '启用'))
  assert.match(loading, /disabled/, 'loading 时必须禁用，防止重复点')
  assert.match(loading, /…/, 'loading 时文案要变成省略号')
})

test('Status：四种色点都有对应类名', () => {
  for (const tone of ['ok', 'warn', 'bad', 'idle']) {
    assert.match(html(React.createElement(Status, { tone, text: 'x' })), new RegExp('me-dot--' + tone))
  }
})

test('EmptyState 必须能渲染 hint 与主操作（「暂无数据」不算空态）', () => {
  const h = html(React.createElement(EmptyState, { title: '还没有卡片', hint: '导入或新建一张', action: React.createElement(Btn, { variant: 'primary' }, '新建') }))
  assert.match(h, /me-empty__hint/)
  assert.match(h, /导入或新建一张/)
  assert.match(h, /me-empty__title/)
})

test('ErrorBar：有 onRetry 才渲染重试按钮', () => {
  assert.equal(html(React.createElement(ErrorBar, { error: '' })), '')
  const noRetry = html(React.createElement(ErrorBar, { error: '服务不可达' }))
  assert.match(noRetry, /服务不可达/)
  assert.doesNotMatch(noRetry, /重试/)
  const withRetry = html(React.createElement(ErrorBar, { error: '服务不可达', onRetry: () => {} }))
  assert.match(withRetry, /重试/)
})

test('StepFlow：完成打勾、当前步高亮', () => {
  const h = html(React.createElement(StepFlow, { steps: ['服务', '模型', '启用'], current: 1, done: [0] }))
  assert.match(h, /me-steps__item--done/)
  assert.match(h, /me-steps__item--now/)
  assert.match(h, /✓/, '完成的步骤显示勾')
  assert.match(h, /服务/)
  assert.match(h, /模型/)
})

test('Section / Hint / Skeleton 可渲染', () => {
  assert.match(html(React.createElement(Section, { title: '语义召回', desc: '按意思相近找卡' }, '内容')), /语义召回/)
  assert.match(html(React.createElement(Hint, { tone: 'ok' }, '已保存')), /已保存/)
  assert.match(html(React.createElement(Skeleton, { h: 20 })), /me-skel/)
})

test('组件样式表覆盖全部变体（防止改组件忘了加 CSS）', () => {
  for (const v of ['primary', 'secondary', 'ghost', 'danger']) assert.match(COMPONENTS_CSS, new RegExp('\\.me-btn--' + v))
  for (const t of ['ok', 'warn', 'bad', 'idle']) assert.match(COMPONENTS_CSS, new RegExp('\\.me-dot--' + t))
  for (const k of ['me-empty', 'me-error', 'me-steps', 'me-skel']) assert.match(COMPONENTS_CSS, new RegExp('\\.' + k))
})

// ────────────────────────────────────────────────────────────────────────────
// 源码守卫（阶段 3）：一屏一颗主按钮 / 空态必带 hint
//
// 为什么用「标记切分」而不是按函数名切：视图的 JSX 分散在多个分支里（卡片列表在
// MemoryLibraryInner，统计在 BackupCard + LibraryAdmin 两处），按函数名切会把
// NewCardModal、SkillReview 这些弹窗算进同一个屏，误报一堆。
// 源码里用 `{/* @view cards */}` … `{/* @view-end cards */}`（JS 里是 `// @view ...`）
// 显式框出「同一屏」的范围，同名多段累计。
// ────────────────────────────────────────────────────────────────────────────
const srcFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/client/index.tsx')
const clientSrc = readFileSync(srcFile, 'utf8')

const VIEWS = ['cards', 'stats', 'audit', 'optimize', 'reader']

function viewBlocks(source) {
  const out = {}
  let current = null
  let buf = []
  for (const line of source.split(/\r?\n/)) {
    const end = /@view-end\s+([A-Za-z-]+)/.exec(line)
    if (end) {
      if (current !== end[1]) throw new Error('视图标记不配对：开 ' + current + ' 却关了 ' + end[1])
      out[current] = (out[current] || '') + buf.join('\n') + '\n'
      current = null
      buf = []
      continue
    }
    const start = /@view\s+([A-Za-z-]+)/.exec(line)
    if (start) {
      if (current) throw new Error('视图标记嵌套：' + current + ' 里又开了 ' + start[1])
      current = start[1]
      buf = []
      continue
    }
    if (current) buf.push(line)
  }
  if (current) throw new Error('视图标记没闭合：' + current)
  return out
}

test('源码守卫：每个视图块内 me-on / variant="primary" ≤ 1（一屏一颗主按钮）', () => {
  const blocks = viewBlocks(clientSrc)
  for (const v of VIEWS) assert.ok(blocks[v] != null, '缺少视图标记 @view ' + v + '（改了 JSX 却忘了框标记，守卫就会静默失效）')
  const report = []
  for (const v of VIEWS) {
    // \b 边界很关键：localStorage 的 'me-onboarded-v2' 不能被当成主按钮
    const n = (blocks[v].match(/\bme-on\b|variant="primary"/g) || []).length
    report.push(v + '=' + n)
    assert.ok(n <= 1, v + ' 视图里出现 ' + n + ' 个主按钮（me-on / variant="primary"）：' + report.join(' '))
  }
})

test('源码守卫：EmptyState 的每个使用点都必须带非空 hint=（空态要说下一步）', () => {
  const hits = []
  const re = /<EmptyState\b/g
  let m
  while ((m = re.exec(clientSrc))) hits.push(m.index)
  assert.ok(hits.length >= 4, 'EmptyState 使用点只有 ' + hits.length + ' 处，是不是被换回「暂无数据」了')
  const bad = []
  for (const i of hits) {
    const lineNo = clientSrc.slice(0, i).split('\n').length
    const chunk = clientSrc.slice(i, i + 900)
    const end = chunk.indexOf('/>')
    const seg = end === -1 ? chunk : chunk.slice(0, end)
    if (!/\bhint=\{/.test(seg)) bad.push(lineNo + '(缺 hint=)')
    else if (/hint=\{(''|"")\}/.test(seg)) bad.push(lineNo + '(hint 是空串)')
  }
  assert.deepEqual(bad, [], '这些 EmptyState 没给下一步：' + bad.join(', '))
})

test('源码守卫：错误条可重试（ErrorBar 用到 onRetry）', () => {
  const used = (clientSrc.match(/<ErrorBar\b/g) || []).length
  const retry = (clientSrc.match(/<ErrorBar[\s\S]{0,400}?onRetry=/g) || []).length
  assert.ok(used >= 4, 'ErrorBar 使用点太少：' + used)
  assert.ok(retry >= 4, 'ErrorBar 至少要能在失败时就地重试（当前 ' + retry + '/' + used + ' 处带 onRetry）')
})
