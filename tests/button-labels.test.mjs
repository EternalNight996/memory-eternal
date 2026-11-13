// 按钮文案守卫：按钮只写纯文字，不加 emoji / 符号前缀，也不夹「，」「、」。
//
// 用户原话：「所有按钮都不要增加，这种字符串」→「是「，」」。
// 口径：<button> / <Btn> 的文案不得以 emoji、★ ☆ ▶ ⟲ ↻ ⏱ ✖ ✏ ⬇ ⚡ ＋ 这类符号开头，
// 也不许出现「，」「、」这种分隔符；忙碌态不许用「⏳ + 文案」拼串（用文字本身或「…」）。
// 例外两类，本就是图标位、不是文案：① 纯图标按钮（整段文案只有符号）；② 专门的图标槽（<span className="mc-rail-ico">🧠</span>）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')

const DECOR = new RegExp('[\\p{Extended_Pictographic}★☆▶⟲↻⏱✖✏⬇⚡＋+]', 'u')
const BUSY = new RegExp("['\"]" + '[\\p{Extended_Pictographic}★☆▶⟲↻⏱✖✏⬇⚡]' + " ?['\"] ?\\+", 'u')
const TEXT_RE = /[A-Za-z\u4e00-\u9fa5]/

// 开标签的真正结束位置：属性里可能带 `=>`、字符串里的 `>`，要跳过 {} 与引号再找 '>'
function openTagEnd(src, start) {
  let depth = 0
  let quote = ''
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (quote) { if (c === quote && src[i - 1] !== '\\') quote = ''; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') { depth++; continue }
    if (c === '}') { depth--; continue }
    if (c === '>' && depth === 0) return i
  }
  return -1
}

function buttonBlocks(src) {
  const blocks = []
  for (const tag of ['button', 'Btn']) {
    const re = new RegExp('<' + tag + '\\b', 'g')
    let m
    while ((m = re.exec(src))) {
      const openEnd = openTagEnd(src, m.index)
      if (openEnd < 0) continue
      const close = src.indexOf('</' + tag + '>', openEnd)
      if (close < 0) continue
      blocks.push({ line: src.slice(0, m.index).split('\n').length, tag, inner: src.slice(openEnd + 1, close), full: src.slice(m.index, close) })
      re.lastIndex = close
    }
  }
  return blocks.sort((a, b) => a.line - b.line)
}

// 文案首段（到第一个 {表达式} / <子元素> 为止）；后面还有没有真文案（中英文或 t('...')）
function headOf(inner) {
  const head = inner.split(/[<{]/)[0].trim()
  const rest = inner.slice(inner.indexOf(head) + head.length)
  return { head, labeled: TEXT_RE.test(rest) || /t\(/.test(rest) }
}

test('按钮文案只用纯文字：不得以 emoji / 符号开头', () => {
  const src = read('src/client/index.tsx')
  const bad = []
  for (const b of buttonBlocks(src)) {
    const { head, labeled } = headOf(b.inner)
    if (!head || !DECOR.test(head[0]) || !labeled) continue
    bad.push('L' + b.line + ' <' + b.tag + '> 文案以「' + head.slice(0, 12) + '」开头')
  }
  assert.deepEqual(bad, [], '按钮文案不要加 emoji / 符号前缀：\n' + bad.join('\n'))
})

test('按钮忙碌态不拼 emoji（不要  ⏳ + 文案 这种写法）', () => {
  const src = read('src/client/index.tsx')
  const bad = []
  for (const b of buttonBlocks(src)) {
    const m = b.inner.match(BUSY)
    if (m) bad.push('L' + b.line + ' ' + m[0])
  }
  assert.deepEqual(bad, [], '忙碌态用文字或「…」，不要拼 emoji：\n' + bad.join('\n'))
})

test('按钮文案不夹「，」「、」这种分隔字符串（用户点名的那一个）', () => {
  const src = read('src/client/index.tsx')
  const bad = []
  for (const b of buttonBlocks(src)) {
    const noComment = b.inner.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\/[^\n]*/g, '')
    for (const frag of noComment.split(/\{[^{}]*\}/)) {
      if (/[，、]/.test(frag)) { bad.push('L' + b.line + ' <' + b.tag + '> ' + frag.trim().slice(0, 40)); break }
    }
  }
  assert.deepEqual(bad, [], '按钮里不要出现「，」「、」：\n' + bad.join('\n'))
})

test('首页工具栏：备份与迁移 / 刷新 是纯文字按钮（用户点名的两个）', () => {
  const src = read('src/client/index.tsx')
  const bar = buttonBlocks(src).filter((b) => /backupEntry|loadAll\(\)\}>\{t\('refresh'\)/.test(b.full))
  assert.match(src, />\{t\('backupEntry'\)\}<\/Btn>/, '「备份与迁移」不要带前缀符号')
  assert.match(src, /onClick=\{\(\) => loadAll\(\)\}>\{t\('refresh'\)\}<\/Btn>/, '「刷新」不要带前缀符号')
  assert.ok(bar.length >= 2, '工具栏两个按钮都要能被守卫扫到')
})

test('纯图标按钮必须带 title / aria-label（去掉文字后仍然可读）', () => {
  const src = read('src/client/index.tsx')
  const bad = []
  for (const b of buttonBlocks(src)) {
    const { head, labeled } = headOf(b.inner)
    if (!head || !DECOR.test(head[0]) || labeled) continue
    if (!/\b(title|aria-label)=/.test(b.full)) bad.push('L' + b.line + ' ' + head)
  }
  assert.deepEqual(bad, [], '纯图标按钮要有 title / aria-label：\n' + bad.join('\n'))
})
