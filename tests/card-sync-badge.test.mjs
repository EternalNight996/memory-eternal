// 「云端模式下卡片不许发灰」的守卫。
//
// 背景（用户实测反馈）：切到云端后整列卡片都挂上「⏳ 未同步」、边框变虚线、整卡压暗到 55%。
// 根因：`showSync` 原来写成「处于云端模式 **或** 库里有同步记录」——
//   而 `cloud_synced_at` 是**本地推送记账列**，云端库里每张卡都没有它，
//   于是云端模式下列表被逐张判成「未同步」，全屏发灰。
// 现在：云端模式整列不判（卡本来就在云端），只有「本地库 + 真有过同步记录」才逐张区分。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ui = readFileSync(path.join(root, 'src/client/index.tsx'), 'utf8')

test('showSync 的判定必须排除云端模式', () => {
  const m = /showSync=\{([^}]+)\}/.exec(ui)
  assert.ok(m, '找不到 showSync 的传值表达式')
  const expr = m[1]
  assert.ok(
    /cloudForm\.mode\s*!==\s*'cloud'/.test(expr),
    'showSync 必须以「不是云端模式」为前提，否则云端卡会被逐张判成未同步：' + expr,
  )
  assert.ok(!/cloudForm\.mode\s*===\s*'cloud'/.test(expr), 'showSync 不许把云端模式当成"要判同步"的条件')
})

test('未同步的视觉（虚线 + 压暗 + 徽标）只由 unsynced 一个开关控制', () => {
  assert.match(ui, /const unsynced = !!showSync && !card\.cloudSyncedAt/, 'unsynced 仍应是「showSync 且有卡没同步」')
  assert.match(ui, /\$\{unsynced \? ' unsynced' : ''\}/, '卡片 class 由 unsynced 决定')
  assert.match(ui, /unsynced \? \{ opacity: 0\.55 \}/, '压暗由 unsynced 决定')
  assert.match(ui, /\{unsynced && <span className="mc-v5-card-status unsynced"/, '徽标由 unsynced 决定')
})

test('构建产物里同样排除云端模式（先 node build.mjs 再跑本测试）', () => {
  const built = readFileSync(path.join(root, 'web/app.js'), 'utf8')
  assert.ok(
    /showSync:\s*[^,}]*\.mode\s*!==\s*"cloud"/.test(built) || /showSync:\s*[^,}]*\.mode\s*!==\s*'cloud'/.test(built),
    'web/app.js 里 showSync 应带"不是云端模式"的判定（是不是没跑 build？）',
  )
})
