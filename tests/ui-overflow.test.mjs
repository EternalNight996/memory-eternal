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

test('「重启常驻实例」按钮常驻显示（不再随警告块一起消失）', () => {
  // 独立于警告块的操作行：{vc && ( residentNeedsRestart ? ...
  // 注意：文件是 CRLF，跨行正则要用 \r?\n
  assert.match(src, /\{vc && \(\r?\n\s+residentNeedsRestart \? \(/, '操作行要独立渲染（不再只在异常时出现）')
  // 一切正常时也给按钮 + 说明
  assert.match(src, /tf\('vcRestartAnyway', \{ ver: vc\.onDisk \|\| '' \}\)/)
  assert.equal((src.match(/vcRestartAnyway:/g) || []).length, 2, '中英词条各一条')
  // 按钮本体仍然调用 restartResident（两条分支各一次）
  assert.equal((src.match(/onClick=\{restartResident\}/g) || []).length >= 2, true, '两种状态下都要能点')
})

test('大标题 modal 的 h2 不横向溢出（长标题省略号）', () => {
  assert.match(src, /\.me-modal-title h2 \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis/)
})
