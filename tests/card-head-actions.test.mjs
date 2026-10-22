// 用户截图反馈（图 1/图 2）：知识卡片的标题很长时，右上角「收起 / 删除 / 关闭」被挤成竖排。
// 根因：.me-dialog-head 是 space-between，而 h3 没 min-width:0（压不动），按钮组也没 flex:0 0 auto / nowrap（被压扁）。
// 这里锁死修法，防止以后改样式时回退。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')

test('标题必须能收缩并单行省略（否则长标题会把按钮顶出去）', () => {
  assert.match(src, /\.me-dialog-head h3 \{ min-width: 0; flex: 1 1 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/)
  // 悬停能看到完整标题（省略后不至于丢信息）
  assert.match(src, /<h3 title=\{card\.title\}>/, '阅读器 h3 要有 title 属性')
})

test('按钮不被压扁、但按钮组可换行（否则 8 个按钮在 760px 里横向溢出）', () => {
  assert.match(src, /\.me-dialog-head \{ flex-wrap: wrap; gap: 8px 12px; \}/)
  assert.match(src, /\.me-dialog-head \.me-head-actions \{[^}]*flex: 0 1 auto/, '按钮组可以收缩/换行（不再是 0 0 auto）')
  // 按钮**自身**不换行/不缩，但按钮组整体允许换行：阅读器最多 8 个按钮，760px 对话框里 nowrap 会横向溢出
  assert.match(src, /\.me-dialog-head \.me-head-actions \{[^}]*flex-wrap: wrap/, '按钮组整体允许换行（防止横向滚动条）')
  assert.match(src, /\.me-dialog-head \.me-head-actions \.mc-btn \{ flex: 0 0 auto; white-space: nowrap; \}/, '按钮自身也不许缩/换行')
})

test('多按钮头部都走 .me-head-actions（阅读器 + 导出图谱 + 支持弹窗）', () => {
  assert.equal((src.match(/className="me-head-actions"/g) || []).length, 3, '阅读器、导出图谱与支持弹窗各一处')
  const reader = src.slice(src.indexOf('<h3 title={card.title}>'), src.indexOf('<h3 title={card.title}>') + 1400)
  assert.match(reader, /className="me-head-actions"/, '阅读器的按钮组要带类')
})
