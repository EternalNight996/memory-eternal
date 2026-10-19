// 用户反馈（第 58 轮）：「重启常驻实例」按钮消失了；反馈/异常区排版不对、滚动条异常。
// 根因：① 按钮原来被包在「有异常才渲染」的警告块里，版本一对齐就整块消失；
//       ② 阅读器最多 8 个头部按钮，而 0.10.42 给按钮组设的是 nowrap → 在 max-width:760px 的对话框里横向溢出；
//       ③ .me-dialog-body 是 content-box，阅读器加了 width:100% + padding → 又撑出一层横向滚动；
//       ④ 诊断 <pre> 里长路径没有断点 → 横向滚动。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')

test('对话框与正文用 border-box + 隐藏横向滚动（width:100% 不再撑破容器）', () => {
  assert.match(src, /\.me-dialog \{[^}]*box-sizing: border-box/, '对话框 border-box')
  assert.match(src, /\.me-dialog-body \{[^}]*box-sizing: border-box/, '正文 border-box')
  assert.match(src, /\.me-dialog-body \{[^}]*overflow-x: hidden/, '正文不许出现横向滚动条')
  assert.match(src, /boxSizing: 'border-box'/, '阅读器内联宽度也要 border-box')
})

test('诊断/反馈 <pre> 的长路径要换行，不许横向滚动', () => {
  const line = src.slice(src.indexOf('const preStyle ='), src.indexOf('const preStyle =') + 400)
  assert.match(line, /wordBreak: 'break-word'/)
  assert.match(line, /overflowX: 'hidden'/)
})

test('「重启常驻实例」按钮**永远**存在（两轮反馈都栽在它消失上）', () => {
  // 操作行只依赖 vc 存在，不再被 residentNeedsRestart / vc.stale 决定是否渲染
  assert.match(src, /\{vc && \(\r?\n\s+<div style=\{\{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6/, '操作行要无条件渲染')
  assert.match(src, /onClick=\{restartResident\}/, '按钮必须真的存在')
  // 三种状态各有准确说明（常驻旧 / 宿主旧 / 全部对齐）
  assert.match(src, /tf\('vcRestartFixes', \{ served: residentServed \|\| '', disk: vc\.onDisk \|\| '' \}\)/)
  assert.match(src, /tf\('vcRestartHostOnly', \{ loaded: vc\.loaded \|\| '', disk: vc\.onDisk \|\| '' \}\)/)
  assert.match(src, /tf\('vcRestartAnyway', \{ ver: vc\.onDisk \|\| '' \}\)/)
  for (const key of ['vcRestartFixes', 'vcRestartHostOnly', 'vcRestartAnyway', 'vcHostProcessStale']) {
    assert.equal((src.match(new RegExp(key + ':', 'g')) || []).length, 2, key + ' 中英各一条')
  }
  // 宿主旧时不能再谎称「点重启常驻实例即可」
  assert.match(src, /tf\('vcHostProcessStale', \{ disk: vc\.onDisk, loaded: vc\.loaded \}\)/, '警告文案要区分宿主与常驻')
})

test('大标题 modal 的 h2 不横向溢出（长标题省略号）', () => {
  assert.match(src, /\.me-modal-title h2 \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis/)
})
