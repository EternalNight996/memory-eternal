// 守一个真实踩过的坑：**useState 声明必须在「同步求值点」之前**。
//
// 事故一：`deviceAuth` 的 useState 被插到了使用点之后，记忆设置页直接崩：
//   ReferenceError: Cannot access 'deviceAuth' before initialization
//   at ConfigPanel
// 事故二：修完 deviceAuth 后，同一只依赖数组里的 `cloudForm` 同样是 TDZ ——
//   连环雷，说明必须一次性查全。
//
// 为什么依赖数组特别严格：它**在渲染期同步求值**。函数体（回调）里的引用要等调用时
// 才求值，不会 TDZ；依赖数组当场就炸。
//
// 这条测试的坑（自己踩过）：
//   ① 第一版把注释和字符串里的词也算进去 → 满屏假阳性
//   ② 第二版只查 `decls.has(v)`，而依赖里写的是 `cloudForm.url`
//      → `has('cloudForm.url')` 永远 false → 从来没检查过 → 假阴性
//   现在：先剥注释/字符串，再按 `.` 取主变量名。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const SRC = fs.readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const lines = SRC.split('\n')

/** 去掉行内注释与字符串内容，只留代码骨架。 */
function strip(line) {
  return line
    .replace(/(^|[^:'"`])\/\/.*$/, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
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

function useStateDecls(r) {
  const map = new Map()
  for (let i = r.start; i < r.end; i++) {
    const m = /const \[([A-Za-z_$][\w$]*), set[A-Za-z_$][\w$]*\] = useState/.exec(strip(lines[i]))
    if (m) map.set(m[1], i)   // 后者覆盖前者：取组件内最后一次声明（通常就是生效的那个）
  }
  return map
}

function depArrayLines(r) {
  const hits = []
  for (let i = r.start; i < r.end; i++) {
    const m = /^\s*\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(strip(lines[i]))
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
      // **关键**：依赖里可能写 `cloudForm.url`、`autoState.lastRunAt`，要取主变量名。
      // 之前直接用 `decls.has(v)` 判断，带点的永远匹配不上 —— 等于没检查（踩过）。
      const base = v.split('.')[0].split('?')[0].trim()
      if (!decls.has(base)) continue
      if (decls.get(base) > dep.line) {
        problems.push(`${base}：声明在 ${decls.get(base) + 1} 行，但 ${dep.line + 1} 行的依赖数组就用了 → TDZ`)
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

test('回归锚点：deviceAuth 与 cloudForm 都必须声明在第一个依赖数组之前', () => {
  const r = componentRange('ConfigPanel')
  const decls = useStateDecls(r)
  const deps = depArrayLines(r)
  for (const name of ['deviceAuth', 'cloudForm']) {
    assert.ok(decls.has(name), `${name} 的 useState 不见了`)
    const dep = deps.find((d) => d.vars.some((v) => v.split('.')[0] === name))
    assert.ok(dep, `找不到引用 ${name} 的依赖数组`)
    assert.ok(
      decls.get(name) < dep.line,
      `${name} 声明（${decls.get(name) + 1} 行）必须在依赖数组（${dep.line + 1} 行）之前`,
    )
  }
})
