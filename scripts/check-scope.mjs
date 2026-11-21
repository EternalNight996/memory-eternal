/**
 * 跨作用域引用检查（门禁第 7 步）。
 *
 * 背景：单文件巨型组件里，某个按钮引用了**别的组件**的 state/函数，
 * 静态语法合法、构建通过，但一渲染就 ReferenceError → 整个面板白屏。
 * 已经踩过 5 次：cloudUsable / health / readPkgVersion / disconnectCloud / switching。
 *
 * 做法：对几个「大组件 + 有自己的 state」的函数，扫描函数区间内引用的标识符，
 * 若某个标识符定义在区间**之外**且看起来像组件内 state，就报错。
 */
import { readFileSync } from 'node:fs'

const FILE = 'src/client/index.tsx'
const src = readFileSync(FILE, 'utf8')
const lines = src.split(/\r?\n/)

// 需要检查的组件 + 该组件**可能误引用**的标识符（只列真正高风险的名字）
const TARGETS = [
  { fn: 'MemoryLibraryInner', suspects: ['switching','setSwitching','switchDataSource','cloudForm','setCloudForm','cloudOpen','setCloudOpen','cloudPlan','setCloudPlan','showKeyField','setShowKeyField','cloudTab','setCloudTab','cloudTest','setCloudTest','importJob','setImportJob','vaultSel','setVaultSel'] },
  { fn: 'GraphView', suspects: ['switching','cloudForm','setCloudForm','importJob','setImportJob'] },
]

function rangeOf(fnName) {
  const start = lines.findIndex((l) => new RegExp('function ' + fnName + '\\b').test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^(export )?function [A-Z]/.test(lines[i]) || /^(export )?const [A-Z]\w* = \(/.test(lines[i])) { end = i; break }
  }
  return { start, end }
}

const problems = []
for (const t of TARGETS) {
  const r = rangeOf(t.fn)
  if (!r) continue
  const body = lines.slice(r.start, r.end).join('\n')
  for (const name of t.suspects) {
    if (!new RegExp('\\b' + name + '\\b').test(body)) continue
    const defIdx = lines.findIndex((l, i) => i !== r.start && new RegExp('(const|let|var|function) (\\[)?' + name + '\\b').test(l))
    if (defIdx > 0 && (defIdx < r.start || defIdx >= r.end)) {
      problems.push(t.fn + ' 引用了 ' + name + '（定义在行 ' + (defIdx + 1) + '，不在本组件作用域）')
    }
  }
}

if (problems.length) {
  console.error('✗ 跨作用域引用（会 ReferenceError 白屏）:')
  for (const p of problems) console.error('   ' + p)
  process.exit(1)
}
console.log('✓ 无跨作用域引用')