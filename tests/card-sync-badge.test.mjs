// 卡片列表**不允许**出现「未同步」视觉（用户三次反馈：整片发灰）。
//
// 历史：
//   v0.48.2 之前 —— hover 把标题染成状态色；
//   v0.48.4 —— 只解决了"云端模式整列不判"，本地库里只要有一张同步过，
//              其余全被判未同步 → 虚线 + 压暗 55% + ⏳ 徽标（用户截图反馈仍在发灰）；
//   v0.49.3 —— **视觉整体移除**：不再有 unsynced class / 压暗 / 徽标。
//              数据层（cloudSyncedAt、补推队列）保留，只是列表上不表达。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ui = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')

test('卡片组件里不许再有 unsynced 的视觉表达', () => {
  const start = ui.indexOf('const CardRow = (')
  assert.ok(start > 0, '找不到 CardRow')
  const next = ui.indexOf('\nconst ', start + 10)
  const block = ui.slice(start, next > 0 ? next : ui.length)
  assert.equal(/unsynced/.test(block), false, 'CardRow 里不该再出现 unsynced（虚线/压暗/徽标都删了）')
  // 压暗/虚线只针对"未同步"这条语义：全文都不许再出现「unsynced 就压暗/虚线」的组合
  assert.equal(/unsynced\s*\?\s*\{\s*opacity/.test(ui), false, '不该再压暗整张卡')
  assert.equal(/mc-cardrow\.unsynced/.test(ui), false, '不该再虚线')
})

test('CJK 文案可以留（历史 key），但列表里不再渲染「未同步」徽标', () => {
  // 徽标那次渲染必须消失；i18n key 留着不影响（其它地方/未来的同步面板可能复用）
  assert.equal(ui.includes('mc-v5-card-status unsynced'), false, '徽标渲染点必须删干净')
})

test('CSS 里 unsynced 规则已清理', () => {
  assert.equal(ui.includes('.mc-cardrow.unsynced'), false, '虚线规则要删')
  assert.equal(ui.includes('.mc-v5-card-status.unsynced'), false, '灰色徽标样式要删')
})

test('构建产物同样不含 unsynced 视觉（先 node build.mjs 再跑）', () => {
  const built = readFileSync(path.join(root, 'web/app.js'), 'utf8')
  assert.equal(built.includes('mc-cardrow unsynced'), false)
  assert.equal(built.includes('mc-v5-card-status unsynced'), false)
})
