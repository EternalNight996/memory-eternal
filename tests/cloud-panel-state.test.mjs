// 守「state 必须在同一组件内、且在引用之前声明」—— 这个坑连踩 5 次：
//   deviceAuth / cloudForm / cloudTab / cloudTest / isConnected
// 每次症状都一样：ReferenceError: Cannot access 'X' before initialization → 整页崩。
//
// 为什么难查：报错只给变量名，堆栈指向 bundle 行号；
// 而根因往往是「把 A 组件的 state 插进了 B 组件」或「声明晚于 useEffect 依赖数组」。
//
// 这条测试做两件事：
//   ① 组件归属：ConfigPanel 里引用的 state，必须在 ConfigPanel 内声明（不能借别的组件）
//   ② 顺序：声明必须早于「同步求值点」（依赖数组 / 立即执行表达式）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const SRC = fs.readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
const lines = SRC.split('\n')

function strip(line) {
  // 注意：这个函数体的正则里**不能出现反引号** —— 之前用模板字符串包着，
  // 反引号把字符串截断了，strip 实际没生效，注释里的字也被当成代码（假阴性）。
  return line
    .replace(/(^|[^:'"])\/\/.*$/, '$1')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\u0060[^\u0060\\]*(?:\\.[^\u0060\\]*)*\u0060/g, 'X')
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

/** 组件内所有 `const [x, setX] = useState` 与 `const x =` 定义。 */
function defs(r) {
  const map = new Map()
  for (let i = r.start; i < r.end; i++) {
    const code = strip(lines[i])
    const m = /const \[([A-Za-z_$][\w$]*), set[A-Za-z_$][\w$]*\] = useState/.exec(code)
      || /const ([A-Za-z_$][\w$]*) = (?:useCallback|useMemo|useRef|cloudTab|cloudForm|cloudConn|cloudTest|cloudApi|\(|async|await)/.exec(code)
      || /const ([A-Za-z_$][\w$]*) = /.exec(code)
    if (m) map.set(m[1], i)
  }
  return map
}

const CFG = 'ConfigPanel'
const cfg = componentRange(CFG)
assert.ok(cfg, '找不到 ConfigPanel')

// ── ① 归属：这些 state 必须声明在 ConfigPanel 内 ─────────────────────────
// （历史上它们都被误插进过 MemoryLibraryInner）
const MUST_BE_IN_CFG = [
  'cloudForm', 'cloudConn', 'cloudTab', 'cloudTest', 'deviceAuth', 'deviceErr', 'deviceBusy',
  'cloudPlan', 'showKeyField', 'merchants', 'mchForm', 'mchBusy', 'mchErr', 'mchSecret',
  'isConnected', 'cloudIdentity', 'disconnectCloud', 'loadCloudPlan',
]

test('ConfigPanel 的 state 必须声明在 ConfigPanel 内（不能借用别的组件）', () => {
  const d = defs(cfg)
  const missing = MUST_BE_IN_CFG.filter((k) => !d.has(k))
  assert.deepEqual(missing, [], `以下定义不在 ConfigPanel 内（会 TDZ 或 is not defined）：${missing.join(', ')}`)
})

// ── ② 顺序：声明必须早于依赖数组 ─────────────────────────────────────────
test('ConfigPanel 的 state 不能被「更早的依赖数组」引用（防 TDZ）', () => {
  const d = defs(cfg)
  const problems = []
  for (let i = cfg.start; i < cfg.end; i++) {
    const m = /^\s*\}\s*,\s*\[([^\]]*)\]\s*\)/.exec(strip(lines[i]))
    if (!m) continue
    for (const v of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      const base = v.split('.')[0].split('?')[0].trim()
      if (!d.has(base)) continue
      if (d.get(base) > i) {
        problems.push(`${base}：声明在 ${d.get(base) + 1} 行，但 ${i + 1} 行的依赖数组就用了`)
      }
    }
  }
  assert.deepEqual(problems, [], `依赖数组在渲染期同步求值，引用未声明的 state 会直接崩：\n  ${problems.join('\n  ')}`)
})

// ── ③ 回归锚点：出过事的几个 ─────────────────────────────────────────────
test('回归锚点：deviceAuth / cloudForm / cloudPlan / isConnected 都在依赖它们的 effect 之前', () => {
  const d = defs(cfg)
  for (const k of ['deviceAuth', 'cloudForm', 'cloudPlan', 'isConnected']) {
    assert.ok(d.has(k), `${k} 的定义丢了`)
  }
  // deviceAuth / cloudForm 被同一个 useEffect 依赖。
  // 必须匹配 `}, [deviceAuth, ...])` 这种**依赖数组**，不能匹配 `const [deviceAuth, ...]`
  // 这种解构 —— 第一版就是被解构行骗了，锚点永远指向定义行本身。
  const depLine = lines.findIndex((l, i) => i > cfg.start && i < cfg.end && /^\s*\}\s*,\s*\[/.test(strip(l)) && /deviceAuth/.test(strip(l)))
  assert.ok(depLine > 0, '找不到 deviceAuth 的依赖数组')
  assert.ok(d.get('deviceAuth') < depLine, 'deviceAuth 必须在依赖数组之前')
  assert.ok(d.get('cloudForm') < depLine, 'cloudForm 必须在依赖数组之前')
})

// ── ④ 云端面板必须三态互斥 ───────────────────────────────────────────────
test('云端面板三态互斥：isConnected 同时控制「登录CTA不显示」与「表单不显示」', () => {
  const region = lines.slice(cfg.start, cfg.end).join('\n')
  // 判据是**语义**而不是某一种写法：
  //   · 有 isConnected 分支
  //   · 登录面板（设备码 / 设备码面板）出现在 isConnected 的 **else** 分支里
  //     —— 早期写成 {!isConnected && deviceAuth ? (...)} 显式排除，
  //        后来重排成 else 分支内直接 {deviceAuth ? (...)}，语义等价。
  assert.ok(region.includes('{isConnected ? ('), '已连接分支缺失')

  const elseIdx = region.indexOf(') : (')
  assert.ok(elseIdx > 0, '找不到 isConnected 的 else 分支')

  // else 之后必须出现登录面板（会自己渲染二维码或"扫码登录"按钮）
  const after = region.slice(elseIdx)
  const hasLoginPanel = after.includes('{deviceAuth ? (') || after.includes('{!isConnected && deviceAuth ? (')
  assert.ok(hasLoginPanel, '登录面板必须出现在未连接（else）分支内，否则已连接时仍会显示')

  // 且 isConnected 分支**内部**不能出现登录面板（那才是真重复渲染）
  const head = region.slice(0, elseIdx)
  assert.ok(!head.includes('{deviceAuth ? ('), '已连接分支里不该再有设备码面板')
})
