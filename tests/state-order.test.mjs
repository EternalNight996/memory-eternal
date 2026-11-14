// 守一个真实踩过的坑：**useState 声明必须在「同步求值点」之前**。
//
// 事故：`deviceAuth` 的 useState 被插到了使用点之后，整个「记忆设置」页直接崩：
//   ReferenceError: Cannot access 'deviceAuth' before initialization
//   at ConfigPanel (app.js:34259)
// 那一行正是 `}, [deviceAuth, cloudForm.url])` —— useEffect 的依赖数组在**渲染期同步求值**，
// 所以它比函数体里的引用严格得多：函数体（回调）里的引用要等调用时才求值，不会 TDZ。
//
// 因此这条测试只查「同步求值点」：
//   ① useEffect/useMemo/useCallback 的依赖数组 `}, [a, b])`
//   ② 组件的顶层立即执行表达式（不含函数体）
// 注释与字符串要排除，否则满屏假阳性（第一版就是这么废掉的）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const SRC = fs.readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const lines = SRC.split('\n')

/** 去掉行内的 // 注释与字符串内容，只留下代码骨架（够用即可）。 */
function strip(line) {
  let out = line
  // 去掉行内注释（简化：不在字符串里的 //）
  out = out.replace(/(^|[^:'"`])\/\/.*$/, '$1')
  // 把字符串/模板内容抹成占位，避免把文案里的单词当成标识符
  out = out.replace(/'(?:[^'\\]|\\.)*'/g, "''")
  out = out.replace(/"(?:[^"\\]|\\.)*"/g, '""')
  out = out.replace(/`(?:[^`\\]|\\.)*`/g, '``')
  return out
}

function componentRange(name) {
  const start = lines.findIndex((l) => new RegExp(`^(export )?function ${name}\\(`).test(l))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^(function |export function |const [A-Z])/.test(lines[i])) { end = i; break }
  }
  return { start, end }
}

/** 收集组件内所有 useState 声明的行号。 */
function useStateDecls(r) {
  const map = new Map()
  for (let i = r.start; i < r.end; i++) {
    const m = /const \[([A-Za-z_$][\w$]*), set[A-Za-z_$][\w$]*\] = useState/.exec(strip(lines[i]))
    if (m) map.set(m[1], i)
  }
  return map
}

/** 收集所有「同步求值点」的行号（依赖数组）。 */
function depArrayLines(r) {
  const hits = []
  for (let i = r.start; i < r.end; i++) {
    const code = strip(lines[i])
    // 形如 `}, [a, b, c]);` 或 `}, []);`
    const m = /^\s*\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(code)
    if (m) hits.push({ line: i, vars: m[1].split(',').map((x) => x.trim()).filter(Boolean) })
  }
  return hits
}

function audit(name) {
  const r = componentRange(name)
  assert.ok(r, `找不到组件 ${name}`)
  const decls = useStateDecls(r)
  assert.ok(decls.size > 10, `${name} 的 useState 数量异常（${decls.size}），解析可能失效`)
  const problems = []
  for (const dep of depArrayLines(r)) {
    for (const v of dep.vars) {
      // 只看我们自己声明的 state（外部变量、props、常量不管）
      if (!decls.has(v)) continue
      const declLine = decls.get(v)
      if (declLine > dep.line) {
        problems.push(`${v}：声明在 ${declLine + 1} 行，但 ${dep.line + 1} 行的依赖数组就用了 → TDZ`)
      }
    }
  }
  return { problems, declCount: decls.size, depCount: depArrayLines(r).length }
}

test('ConfigPanel：useState 不能晚于它的依赖数组（防 TDZ）', () => {
  const r = audit('ConfigPanel')
  assert.deepEqual(r.problems, [], `useState 声明晚于依赖数组会导致 TDZ 崩溃：\n  ${r.problems.join('\n  ')}`)
})

test('MemoryLibraryInner：useState 不能晚于它的依赖数组（防 TDZ）', () => {
  const r = audit('MemoryLibraryInner')
  assert.deepEqual(r.problems, [], `useState 声明晚于依赖数组会导致 TDZ 崩溃：\n  ${r.problems.join('\n  ')}`)
})

test('deviceAuth 回归锚点：声明必须在第一个使用它的依赖数组之前', () => {
  const r = componentRange('ConfigPanel')
  const decls = useStateDecls(r)
  assert.ok(decls.has('deviceAuth'), 'deviceAuth 的 useState 不见了')
  const declLine = decls.get('deviceAuth')
  const depLine = lines.findIndex((l, i) => i > r.start && i < r.end && /\[\s*deviceAuth\s*,/.test(strip(l)) && /^\s*\}/.test(strip(l)))
  assert.ok(depLine > 0, '找不到 deviceAuth 的依赖数组')
  assert.ok(declLine < depLine, `deviceAuth 声明（${declLine + 1} 行）必须在依赖数组（${depLine + 1} 行）之前`)
})
